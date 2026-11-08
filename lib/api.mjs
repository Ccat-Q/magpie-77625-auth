export const BASE_URL = "https://ly.77625.xyz";
export const API_URL = `${BASE_URL}/api`;
export const V1_URL = `${BASE_URL}/v1`;

export class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ApiError";
    this.status = options.status ?? 0;
    this.code = options.code ?? "api_error";
    this.detail = options.detail ?? "";
    this.cfChallenge = options.cfChallenge ?? false;
  }
}

async function readBody(response) {
  const text = await response.text().catch(() => "");
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const html = contentType.includes("text/html") || /^\s*<(?:!doctype|html)/i.test(text);
  let data = null;
  if (text && !html) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { detail: text.slice(0, 300) };
    }
  }
  return { text, data, html };
}

function combineSignals(signal, controller) {
  if (!signal) return controller.signal;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([controller.signal, signal]);
  }
  if (signal.aborted) controller.abort(signal.reason);
  else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  return controller.signal;
}

/**
 * One HTTP call with a timeout, JSON body/response and a normalized error.
 */
export async function request(url, options = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    signal,
    timeoutMs = 15_000,
    fetchImpl = globalThis.fetch,
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  try {
    const init = {
      method,
      headers: { ...headers },
      signal: combineSignals(signal, controller),
    };
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await fetchImpl(url, init);
    const { data, html } = await readBody(response);
    if (html) {
      const mitigated = (response.headers.get("cf-mitigated") || "").toLowerCase();
      const blocked = response.status === 403 || response.status === 429 || response.status >= 500;
      throw new ApiError(
        "站点返回了 HTML 页面（可能被 Cloudflare 拦截或限流），请稍后重试",
        {
          status: response.status,
          cfChallenge: blocked || mitigated.includes("challenge"),
          code: "html_block",
        },
      );
    }
    if (!response.ok) {
      const detail = errorDetail(data, response.status);
      const mitigated = (response.headers.get("cf-mitigated") || "").toLowerCase();
      const cfChallenge = response.status === 403 && mitigated.includes("challenge");
      throw new ApiError(detail, {
        status: response.status,
        detail,
        cfChallenge,
        code: cfChallenge ? "cf_challenge" : "http_error",
      });
    }
    return { response, data };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error?.name === "AbortError" || error?.cause?.message === "timeout") {
      throw new ApiError("请求已取消或超时", { code: "timeout" });
    }
    throw new ApiError(error?.message || "网络错误", { code: "network" });
  } finally {
    clearTimeout(timer);
  }
}

function errorDetail(data, status) {
  if (typeof data?.detail === "string") return data.detail;
  if (Array.isArray(data?.detail)) {
    return data.detail.map((item) => item?.msg || JSON.stringify(item)).join("; ");
  }
  if (typeof data?.error === "string") return data.error;
  if (typeof data?.error?.message === "string") return data.error.message;
  if (typeof data?.message === "string") return data.message;
  return `站点返回 HTTP ${status}`;
}

function splitSetCookie(value) {
  // A comma starts a new cookie only when it is followed by a cookie name.
  return value.split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/);
}

export function setCookieHeaders(headers) {
  if (typeof headers?.getSetCookie === "function") {
    const values = headers.getSetCookie();
    if (Array.isArray(values) && values.length) return values;
  }
  const combined = headers?.get?.("set-cookie");
  return combined ? splitSetCookie(combined) : [];
}

/**
 * Parse Set-Cookie values into a Cookie header plus the latest expiry we saw.
 */
export function parseSetCookie(headers) {
  const raw = setCookieHeaders(headers);
  const pairs = [];
  let expiresAt = 0;
  for (const cookie of raw) {
    const [pair, ...attributes] = cookie.split(";");
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!name || !value) continue;
    pairs.push(`${name}=${value}`);

    for (const attribute of attributes) {
      const [key, ...rest] = attribute.trim().split("=");
      const attributeName = key.toLowerCase();
      const attributeValue = rest.join("=").trim();
      let expiry = 0;
      if (attributeName === "max-age") {
        const seconds = Number(attributeValue);
        if (Number.isFinite(seconds) && seconds > 0) expiry = Date.now() + seconds * 1000;
      } else if (attributeName === "expires") {
        const parsed = Date.parse(attributeValue);
        if (Number.isFinite(parsed) && parsed > Date.now()) expiry = parsed;
      }
      if (expiry > expiresAt) expiresAt = expiry;
    }
  }
  if (!expiresAt) expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  return { cookieHeader: pairs.join("; "), expiresAt };
}

export function normalizeCookieInput(value) {
  let cookie = String(value ?? "").trim();
  if (/^cookie\s*:/i.test(cookie)) cookie = cookie.replace(/^cookie\s*:/i, "").trim();
  if (!cookie) throw new ApiError("Cookie 不能为空", { code: "bad_cookie" });
  if (!cookie.includes("=")) {
    throw new ApiError("Cookie 格式应为 name=value; name2=value2", { code: "bad_cookie" });
  }
  return cookie;
}

const LOGIN_BACKOFF_MS = 5 * 60 * 1000;
const loginBlockedUntil = new Map();

export async function loginWithPassword({ username, password, fetchImpl, signal }) {
  if (!username || !password) throw new ApiError("用户名和密码不能为空", { code: "bad_credentials" });

  const backoffKey = String(username).trim().toLowerCase();
  const blockedUntil = loginBlockedUntil.get(backoffKey) ?? 0;
  if (blockedUntil > Date.now()) {
    const minutes = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 60_000));
    throw new ApiError(`登录被站点限流，请 ${minutes} 分钟后再试`, {
      status: 429,
      code: "rate_limited",
    });
  }

  try {
    const { response } = await request(`${API_URL}/auth/login`, {
      method: "POST",
      body: { username, password, remember: true },
      fetchImpl,
      signal,
    });
    const { cookieHeader, expiresAt } = parseSetCookie(response.headers);
    if (!cookieHeader) {
      throw new ApiError("登录成功，但站点没有返回会话 Cookie。请改用浏览器会话 Cookie 登录。", {
        code: "no_cookie",
      });
    }
    loginBlockedUntil.delete(backoffKey);
    return { cookieHeader, expiresAt };
  } catch (error) {
    if (error?.status === 429) {
      loginBlockedUntil.set(backoffKey, Date.now() + LOGIN_BACKOFF_MS);
    }
    throw error;
  }
}

export async function fetchMe({ cookie, fetchImpl, signal }) {
  const { data } = await request(`${API_URL}/auth/me`, {
    headers: { cookie },
    fetchImpl,
    signal,
  });
  return data;
}

export async function fetchStats({ cookie, fetchImpl, signal }) {
  const { data } = await request(`${API_URL}/account/stats`, {
    headers: { cookie },
    fetchImpl,
    signal,
  });
  return data;
}

export async function fetchAccountModels({ cookie, fetchImpl, signal }) {
  const { data } = await request(`${API_URL}/account/models`, {
    headers: { cookie },
    fetchImpl,
    signal,
  });
  return Array.isArray(data?.models) ? data.models : [];
}

export async function fetchPublicModels({ fetchImpl, signal }) {
  const { data } = await request(`${API_URL}/public/models`, { fetchImpl, signal });
  return Array.isArray(data?.models) ? data.models : [];
}

export async function fetchKeyGroups({ cookie, fetchImpl, signal }) {
  const { data } = await request(`${API_URL}/keys/groups`, {
    headers: { cookie },
    fetchImpl,
    signal,
  });
  return Array.isArray(data?.groups) ? data.groups : [];
}

export async function createKey({ cookie, name, group, fetchImpl, signal }) {
  const { data } = await request(`${API_URL}/keys`, {
    method: "POST",
    headers: { cookie },
    body: { name, group },
    fetchImpl,
    signal,
  });
  if (typeof data?.key !== "string" || !data.key) {
    throw new ApiError("站点没有返回新密钥", { code: "no_key" });
  }
  return { key: data.key, warning: data.warning ?? "", id: data.id };
}

export async function validateApiKey({ key, fetchImpl, signal }) {
  await request(`${V1_URL}/models`, {
    headers: { authorization: `Bearer ${key}` },
    fetchImpl,
    signal,
  });
}

export async function fetchV1Models({ key, fetchImpl, signal }) {
  const { data } = await request(`${V1_URL}/models`, {
    headers: { authorization: `Bearer ${key}` },
    fetchImpl,
    signal,
  });
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.models)) return data.models;
  return [];
}

export async function postCheckin({ cookie, fetchImpl, signal }) {
  const { data } = await request(`${API_URL}/account/checkin`, {
    method: "POST",
    headers: { cookie },
    fetchImpl,
    signal,
    timeoutMs: 30_000,
  });
  return data ?? {};
}