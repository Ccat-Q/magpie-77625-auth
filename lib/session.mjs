import {
  ApiError,
  createKey,
  fetchAccountModels,
  fetchKeyGroups,
  fetchMe,
  fetchStats,
  fetchV1Models,
  loginWithPassword,
  normalizeCookieInput,
  postCheckin,
  validateApiKey,
} from "./api.mjs";
import {
  isFree,
  limitsFor,
  modelsFromAccount,
  modelsFromOpenAI,
  normalizeModel,
  staticModels,
} from "./models.mjs";

export const PROVIDER_ID = "77625";
export const BEIJING_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

export function hasSession(auth) {
  return auth?.type === "oauth" && typeof auth.access === "string" && auth.access.length > 0;
}

export function formatCredits(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? "0");
  return number.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

export function beijingDate(now = Date.now()) {
  return new Date(now + BEIJING_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

export function safeError(error) {
  if (error?.cfChallenge) {
    return "站点触发了 Cloudflare 人机验证。请在浏览器完成验证后，改用「浏览器会话 Cookie」登录。";
  }
  const message =
    (typeof error?.detail === "string" && error.detail) ||
    (typeof error?.message === "string" && error.message) ||
    "请求失败";
  return message.slice(0, 300);
}

function withSignInExpired(error) {
  const wrapped = error instanceof Error ? error : new ApiError(String(error));
  wrapped.signIn = "expired";
  return wrapped;
}

async function saveAuth(client, auth) {
  if (!client?.auth?.set) return;
  try {
    await client.auth.set({ path: { id: PROVIDER_ID }, body: auth });
  } catch {
    // A request can still succeed with the token we already have; the next
    // hook call will refresh and try to save again.
  }
}

export async function resolveApiKey({ cookie, providedKey, keyGroup, fetchImpl, signal }) {
  const key = String(providedKey ?? "").trim();
  if (key) {
    try {
      await validateApiKey({ key, fetchImpl, signal });
    } catch (error) {
      if (error?.status === 401) {
        throw new ApiError("API Key 无效（站点返回 401）", { status: 401, code: "bad_key" });
      }
      throw error;
    }
    return { apiKey: key, keyName: "pasted", keyGroup: String(keyGroup ?? "").trim() };
  }

  const groups = await fetchKeyGroups({ cookie, fetchImpl, signal });
  const wanted = String(keyGroup ?? "").trim();
  let group;
  if (wanted) {
    group = groups.find((item) => item?.name === wanted);
    if (!group) {
      throw new ApiError(`找不到分组「${wanted}」；可用分组：${groups.map((item) => item?.name).filter(Boolean).join("、") || "无"}`, {
        code: "bad_group",
      });
    }
    if (group.allowed === false) {
      throw new ApiError(`分组「${wanted}」不允许创建密钥`, { code: "bad_group" });
    }
  } else {
    group = groups.find((item) => item?.allowed !== false);
  }
  if (!group?.name) {
    throw new ApiError("账号没有可创建密钥的分组；请先在站点创建密钥，再粘贴到登录框", {
      code: "no_group",
    });
  }

  const created = await createKey({
    cookie,
    name: "magpie",
    group: group.name,
    fetchImpl,
    signal,
  });
  return {
    apiKey: created.key,
    keyName: "magpie",
    keyId: created.id,
    keyGroup: group.name,
    warning: created.warning,
  };
}

export async function loginWithPasswordFlow({
  username,
  password,
  apiKey,
  keyGroup,
  fetchImpl,
  signal,
}) {
  const { cookieHeader, expiresAt } = await loginWithPassword({
    username,
    password,
    fetchImpl,
    signal,
  });
  const me = await fetchMe({ cookie: cookieHeader, fetchImpl, signal });
  const key = await resolveApiKey({
    cookie: cookieHeader,
    providedKey: apiKey,
    keyGroup,
    fetchImpl,
    signal,
  });
  return {
    auth: {
      type: "oauth",
      access: cookieHeader,
      refresh: password,
      expires: expiresAt,
      sessionExpires: expiresAt,
      username: me?.username || username,
      accountId: me?.username || username,
      ...key,
    },
    me,
  };
}

export async function loginWithCookieFlow({
  cookie,
  apiKey,
  keyGroup,
  fetchImpl,
  signal,
}) {
  const normalized = normalizeCookieInput(cookie);
  const me = await fetchMe({ cookie: normalized, fetchImpl, signal });
  const key = await resolveApiKey({
    cookie: normalized,
    providedKey: apiKey,
    keyGroup,
    fetchImpl,
    signal,
  });
  return {
    auth: {
      type: "oauth",
      access: normalized,
      // Magpie's OAuth save path keys off the presence of `refresh`; an empty
      // string keeps this as an OAuth account without enabling auto-renewal.
      refresh: "",
      expires: 0,
      sessionExpires: 0,
      username: me?.username || "77625",
      accountId: me?.username || "77625",
      ...key,
    },
    me,
  };
}

async function refreshSession(auth, { fetchImpl, signal } = {}) {
  if (!auth?.refresh || !auth?.username) return undefined;
  try {
    const { cookieHeader, expiresAt } = await loginWithPassword({
      username: auth.username,
      password: auth.refresh,
      fetchImpl,
      signal,
    });
    const me = await fetchMe({ cookie: cookieHeader, fetchImpl, signal });
    return {
      me,
      fields: {
        access: cookieHeader,
        refresh: auth.refresh,
        expires: expiresAt,
        sessionExpires: expiresAt,
        username: me?.username || auth.username,
      },
    };
  } catch (error) {
    if (error?.status === 401) throw withSignInExpired(error);
    throw error;
  }
}

const refreshInFlight = new Map();

function refreshKey(auth) {
  return `${auth?.username ?? ""}|${auth?.access ?? ""}`;
}

async function coordinatedRefresh(auth, options = {}) {
  const key = refreshKey(auth);
  const running = refreshInFlight.get(key);
  if (running) return running;
  const promise = refreshSession(auth, options).finally(() => {
    refreshInFlight.delete(key);
  });
  refreshInFlight.set(key, promise);
  return promise;
}

export async function refreshAuth(auth, options = {}) {
  const refreshed = await coordinatedRefresh(auth, options);
  return refreshed?.fields;
}

/**
 * Return { auth, me } with a session that /api/auth/me accepts, refreshing once
 * when the stored cookie is dead and a password was saved.
 */
export async function ensureSession(auth, { client, fetchImpl, signal } = {}) {
  if (!hasSession(auth)) return { auth, me: null };
  try {
    const me = await fetchMe({ cookie: auth.access, fetchImpl, signal });
    return { auth, me };
  } catch (error) {
    if (error?.status !== 401) throw error;
    if (!auth.refresh || !auth.username) throw withSignInExpired(error);
    const refreshed = await coordinatedRefresh(auth, { fetchImpl, signal });
    const next = { ...auth, ...refreshed.fields };
    await saveAuth(client, next);
    return { auth: next, me: refreshed.me };
  }
}

export function usageFrom(me, stats) {
  const credits = Number(me?.credits);
  const formatted = formatCredits(Number.isFinite(credits) ? credits : me?.credits);
  const windows = [];

  // The site has no "total granted" endpoint, but /api/account/stats reports
  // lifetime consumption. Estimate the lifetime credit pool as
  // current balance + consumed; then Magpie can show a real used percentage
  // instead of its default 0% / 100% for a balance-only wallet.
  const totalCost = Number(stats?.total_cost);
  const hasCost = Number.isFinite(totalCost) && totalCost > 0;
  if (Number.isFinite(credits) && hasCost) {
    const limit = credits + totalCost;
    if (limit > 0) {
      const currentTotal = Math.round(limit * 100) / 100;
      windows.push({
        name: "积分用量",
        used: Math.min(100, Math.max(0, (totalCost / currentTotal) * 100)),
        amount: totalCost,
        limit: currentTotal,
        unit: "积分",
        display: `${formatCredits(totalCost)} / ${formatCredits(currentTotal)} 积分`,
      });
    }
  }
  if (windows.length === 0) {
    windows.push({
      name: "积分余额",
      balance: Number.isFinite(credits) ? credits : 0,
      unit: "积分",
      display: `${formatted} 积分`,
    });
  }

  const today = Array.isArray(stats?.daily)
    ? stats.daily.find((entry) => entry?.date === beijingDate())
    : undefined;
  if (today) {
    windows.push({
      name: "今日",
      display: `${Number(today.calls) || 0} 次 · ${formatCredits(today.cost)} 积分`,
      aside: true,
    });
  }

  return {
    plan: "公益免费",
    user: me?.username || "77625",
    balance: `${formatted} 积分`,
    windows,
  };
}

export async function runUsage(auth, options = {}) {
  if (!hasSession(auth)) {
    return {
      error: "此账号只保存了 API Key，无法读取积分",
      signIn: "kept",
    };
  }
  const { auth: session, me } = await ensureSession(auth, options);
  let stats = null;
  try {
    stats = await fetchStats({ cookie: session.access, fetchImpl: options.fetchImpl, signal: options.signal });
  } catch {
    // Today's numbers are a bonus; the balance is still shown.
  }
  return usageFrom(me, stats);
}

const ALREADY = /已签到|签到过|已经签到|already|今天.*签/i;
const CAPTCHA = /验证码|captcha|人机|challenge/i;
const INACTIVE = /未开放|没有.*活动|暂无.*活动|disabled|inactive|not\s+active/i;
const INELIGIBLE = /没有权限|无权|not\s+eligible|forbidden|不满足|不符合/i;

function checkinFailure(error) {
  if (error?.status === 401) throw withSignInExpired(error);
  const detail = String(error?.detail || error?.message || "");
  if (ALREADY.test(detail)) return { outcome: "done", message: detail };
  if (CAPTCHA.test(detail)) return { outcome: "captcha", message: detail };
  if (INACTIVE.test(detail)) return { outcome: "inactive", message: detail };
  if (INELIGIBLE.test(detail)) return { outcome: "ineligible", message: detail };
  return { outcome: "failed", message: detail };
}

export async function runCheckin(auth, options = {}) {
  if (!hasSession(auth)) return { outcome: "ineligible" };
  const { auth: session, me } = await ensureSession(auth, options);

  if (me?.checkin_enabled === false) return { outcome: "inactive" };
  const permissions = Array.isArray(me?.permissions) ? me.permissions : [];
  const allowed =
    me?.is_admin === true ||
    permissions.includes("*") ||
    permissions.includes("checkin");
  if (!allowed) return { outcome: "ineligible" };
  if (me?.checked_in_today === true) return { outcome: "done", message: "今天已签到" };

  let data;
  try {
    data = await postCheckin({
      cookie: session.access,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
    });
  } catch (error) {
    return checkinFailure(error);
  }

  const points = Number(data?.points);
  const credits = Number(data?.credits);
  if (Number.isFinite(points) && points > 0) {
    return {
      outcome: "claimed",
      credit: points,
      message:
        Number.isFinite(credits) && data?.credits !== undefined
          ? `+${formatCredits(points)} 积分，当前 ${formatCredits(credits)}`
          : `+${formatCredits(points)} 积分`,
    };
  }
  if (data?.already === true) return { outcome: "done", message: "今天已签到" };
  return { outcome: "done", message: typeof data?.message === "string" ? data.message : "今天已签到" };
}

export async function listModels(auth, options = {}) {
  if (!auth) return null;
  if (hasSession(auth)) {
    try {
      const entries = await fetchAccountModels({
        cookie: auth.access,
        fetchImpl: options.fetchImpl,
        signal: options.signal,
      });
      const models = modelsFromAccount(entries);
      return Object.keys(models).length ? models : null;
    } catch (error) {
      if (error?.status === 401) {
        if (!auth.refresh) throw withSignInExpired(error);
        const { auth: session, me } = await ensureSession(auth, options);
        if (!session || !me) return null;
        try {
          const entries = await fetchAccountModels({
            cookie: session.access,
            fetchImpl: options.fetchImpl,
            signal: options.signal,
          });
          const models = modelsFromAccount(entries);
          return Object.keys(models).length ? models : null;
        } catch (second) {
          if (second?.status === 401) throw withSignInExpired(second);
          return null;
        }
      }
      return null;
    }
  }
  if (typeof auth.key === "string" && auth.key) {
    try {
      const entries = await fetchV1Models({
        key: auth.key,
        fetchImpl: options.fetchImpl,
        signal: options.signal,
      });
      const models = modelsFromOpenAI(entries);
      return Object.keys(models).length ? models : null;
    } catch {
      return null;
    }
  }
  return null;
}

export { staticModels, normalizeModel, limitsFor, isFree };