export function reply(status = 200, body = {}, headers = {}) {
  const resultHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      resultHeaders.append(name, item);
    }
  }
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: resultHeaders,
  });
}

export function makeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = String(init.method || "GET").toUpperCase();
    const headers = new Headers(init.headers || {});
    let body;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call = { url: parsed.href, path: parsed.pathname, method, headers, body };
    calls.push(call);
    const result = await handler(call);
    return result instanceof Response ? result : reply(result?.status, result?.body, result?.headers);
  };
  return { fetchImpl, calls };
}

export const sessionAuth = {
  type: "oauth",
  access: "session=abc",
  refresh: "pw",
  username: "alice",
  apiKey: "sk-existing",
  expires: Date.now() + 86_400_000,
};

export function clientStub() {
  const saved = [];
  return {
    saved,
    auth: {
      async set(payload) {
        saved.push(payload);
      },
    },
  };
}