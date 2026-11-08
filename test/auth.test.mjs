import test from "node:test";
import assert from "node:assert/strict";
import { SevenSevenAuthPlugin, _internal as I } from "../index.mjs";
import { clientStub, makeFetch, reply, sessionAuth } from "./helpers.mjs";

test("password login creates a key, stores the cookie and the password for refresh", async () => {
  const { fetchImpl, calls } = makeFetch(({ path, method, headers, body }) => {
    switch (`${method} ${path}`) {
      case "POST /api/auth/login":
        assert.equal(body.username, "alice");
        assert.equal(body.remember, true);
        return reply(200, { ok: true }, {
          "set-cookie": ["session=abc; Max-Age=2592000; HttpOnly", "pref=zh; Max-Age=600"],
        });
      case "GET /api/auth/me":
        assert.equal(headers.get("cookie"), "session=abc; pref=zh");
        return reply(200, { username: "alice", credits: 100 });
      case "GET /api/keys/groups":
        return reply(200, {
          groups: [{ name: "vip", allowed: false }, { name: "default", allowed: true }],
        });
      case "POST /api/keys":
        assert.equal(body.group, "default");
        assert.equal(body.name, "magpie");
        return reply(200, { key: "sk-created", warning: "save it" });
      default:
        return reply(404, { detail: "unexpected" });
    }
  });

  const { auth, me } = await I.loginWithPasswordFlow({
    username: "alice",
    password: "pw",
    fetchImpl,
  });

  assert.equal(me.username, "alice");
  assert.equal(auth.type, "oauth");
  assert.equal(auth.access, "session=abc; pref=zh");
  assert.equal(auth.refresh, "pw");
  assert.equal(auth.apiKey, "sk-created");
  assert.equal(auth.keyName, "magpie");
  assert.equal(auth.keyGroup, "default");
  assert.ok(auth.expires > Date.now() + 80_000);
  assert.equal(calls.filter((call) => call.path === "/api/keys").length, 1);
});

test("password login reuses a pasted API key and does not create one", async () => {
  const { fetchImpl, calls } = makeFetch(({ path, method, headers }) => {
    switch (`${method} ${path}`) {
      case "POST /api/auth/login":
        return reply(200, {}, { "set-cookie": "session=abc; Max-Age=60" });
      case "GET /api/auth/me":
        return reply(200, { username: "alice" });
      case "GET /v1/models":
        assert.equal(headers.get("authorization"), "Bearer sk-pasted");
        return reply(200, { data: [] });
      default:
        return reply(404, { detail: "unexpected" });
    }
  });

  const { auth } = await I.loginWithPasswordFlow({
    username: "alice",
    password: "pw",
    apiKey: "sk-pasted",
    fetchImpl,
  });

  assert.equal(auth.apiKey, "sk-pasted");
  assert.equal(auth.keyName, "pasted");
  assert.equal(calls.some((call) => call.path === "/api/keys"), false);
});

test("a rejected pasted API key fails the login", async () => {
  const { fetchImpl } = makeFetch(({ path, method }) => {
    if (method === "POST" && path === "/api/auth/login") {
      return reply(200, {}, { "set-cookie": "session=abc; Max-Age=60" });
    }
    if (path === "/api/auth/me") return reply(200, { username: "alice" });
    if (path === "/v1/models") return reply(401, { detail: "bad key" });
    return reply(404, {});
  });

  await assert.rejects(
    I.loginWithPasswordFlow({ username: "alice", password: "pw", apiKey: "bad", fetchImpl }),
    (error) => error.status === 401 && /API Key/.test(error.message),
  );
});

test("cookie login validates the session and can create a key", async () => {
  const { fetchImpl, calls } = makeFetch(({ path, method, headers }) => {
    switch (`${method} ${path}`) {
      case "GET /api/auth/me":
        assert.equal(headers.get("cookie"), "session=ok; cf=1");
        return reply(200, { username: "bob" });
      case "GET /api/keys/groups":
        return reply(200, { groups: [{ name: "default", allowed: true }] });
      case "POST /api/keys":
        return reply(200, { key: "sk-cookie" });
      default:
        return reply(404, {});
    }
  });

  const { auth } = await I.loginWithCookieFlow({
    cookie: "Cookie: session=ok; cf=1",
    fetchImpl,
  });

  assert.equal(auth.type, "oauth");
  assert.equal(auth.access, "session=ok; cf=1");
  assert.equal(auth.refresh, "");
  assert.equal(auth.expires, 0);
  assert.equal(auth.apiKey, "sk-cookie");
  assert.equal(calls[0].path, "/api/auth/me");
});

test("Cloudflare challenges are surfaced as their own error", async () => {
  const { fetchImpl } = makeFetch(() =>
    reply(403, { detail: "Just a moment..." }, { "cf-mitigated": "challenge" }),
  );

  await assert.rejects(
    I.loginWithPasswordFlow({ username: "alice", password: "pw", fetchImpl }),
    (error) => error.cfChallenge === true,
  );
  assert.match(I.safeError({ cfChallenge: true }), /Cookie/);
});

test("a login without a session cookie fails clearly", async () => {
  const { fetchImpl } = makeFetch(() => reply(200, { ok: true }));

  await assert.rejects(
    I.loginWithPasswordFlow({ username: "alice", password: "pw", fetchImpl }),
    (error) => error.code === "no_cookie",
  );
});

test("a wrong password carries the site's detail", async () => {
  const { fetchImpl } = makeFetch(() => reply(401, { detail: "用户名或密码错误" }));

  await assert.rejects(
    I.loginWithPasswordFlow({ username: "alice", password: "bad", fetchImpl }),
    (error) => error.status === 401 && error.detail === "用户名或密码错误",
  );
});

test("refresh logs in again and returns the new cookie", async () => {
  let logins = 0;
  const { fetchImpl } = makeFetch(({ path, method }) => {
    switch (`${method} ${path}`) {
      case "POST /api/auth/login":
        logins += 1;
        return reply(200, {}, { "set-cookie": "session=fresh; Max-Age=120" });
      case "GET /api/auth/me":
        return reply(200, { username: "alice" });
      default:
        return reply(404, {});
    }
  });

  const refreshed = await I.refreshAuth(sessionAuth, { fetchImpl });
  assert.equal(logins, 1);
  assert.equal(refreshed.access, "session=fresh");
  assert.equal(refreshed.refresh, "pw");
  assert.ok(refreshed.expires > Date.now());
});

test("refresh with a rejected password marks the sign-in as expired", async () => {
  const { fetchImpl } = makeFetch(({ path, method }) => {
    if (method === "POST" && path === "/api/auth/login") {
      return reply(401, { detail: "用户名或密码错误" });
    }
    return reply(404, {});
  });

  await assert.rejects(
    I.refreshAuth(sessionAuth, { fetchImpl }),
    (error) => error.signIn === "expired",
  );
});

test("ensureSession refreshes a dead cookie and saves the new auth", async () => {
  const client = clientStub();
  let meCalls = 0;
  const { fetchImpl } = makeFetch(({ path, method, headers }) => {
    if (path === "/api/auth/login" && method === "POST") {
      return reply(200, {}, { "set-cookie": "session=new; Max-Age=120" });
    }
    if (path === "/api/auth/me") {
      meCalls += 1;
      if (headers.get("cookie") === "session=old") return reply(401, { detail: "未登录" });
      return reply(200, { username: "alice" });
    }
    return reply(404, {});
  });

  const { auth, me } = await I.ensureSession(
    { ...sessionAuth, access: "session=old" },
    { client, fetchImpl },
  );

  assert.equal(meCalls, 2);
  assert.equal(auth.access, "session=new");
  assert.equal(me.username, "alice");
  assert.equal(client.saved.length, 1);
  assert.equal(client.saved[0].body.access, "session=new");
});

test("ensureSession without a saved password marks the sign-in expired", async () => {
  const { fetchImpl } = makeFetch(() => reply(401, { detail: "未登录" }));

  await assert.rejects(
    I.ensureSession({ ...sessionAuth, refresh: undefined }, { fetchImpl }),
    (error) => error.signIn === "expired",
  );
});
test("an HTML block page becomes a friendly error instead of raw HTML", async () => {
  const { fetchImpl } = makeFetch(() =>
    new Response("<!doctype html><html><title>Just a moment...</title></html>", {
      status: 403,
      headers: { "content-type": "text/html" },
    }),
  );

  await assert.rejects(
    I.loginWithPasswordFlow({ username: "alice", password: "pw", fetchImpl }),
    (error) => error.code === "html_block" && !/doctype/i.test(error.message),
  );
});

test("a 429 login is backed off locally instead of hammering the site", async () => {
  let calls = 0;
  const { fetchImpl } = makeFetch(() => {
    calls += 1;
    return reply(429, { detail: "失败次数过多，请 5 分钟后再试" });
  });

  await assert.rejects(
    I.loginWithPasswordFlow({ username: "rate-limited-user", password: "pw", fetchImpl }),
    (error) => error.status === 429,
  );
  await assert.rejects(
    I.loginWithPasswordFlow({ username: "rate-limited-user", password: "pw", fetchImpl }),
    (error) => error.code === "rate_limited",
  );
  assert.equal(calls, 1);
});


test("oauth authorize returns callback() so Magpie can complete the sign-in", async () => {
  const realFetch = globalThis.fetch;
  const { fetchImpl } = makeFetch(({ path, method }) => {
    switch (`${method} ${path}`) {
      case "POST /api/auth/login":
        return reply(200, {}, { "set-cookie": "session=cb; Max-Age=60" });
      case "GET /api/auth/me":
        return reply(200, { username: "callback-user" });
      case "GET /api/keys/groups":
        return reply(200, { groups: [{ name: "default", allowed: true }] });
      case "POST /api/keys":
        return reply(200, { key: "sk-cb" });
      default:
        return reply(404, {});
    }
  });
  globalThis.fetch = fetchImpl;
  try {
    const hooks = await SevenSevenAuthPlugin({ client: clientStub() });
    const started = await hooks.auth.methods[0].authorize({
      username: "callback-user",
      password: "pw",
    });
    assert.equal(typeof started.callback, "function");
    const result = await started.callback();
    assert.equal(result.type, "success");
    assert.equal(result.apiKey, "sk-cb");
  } finally {
    globalThis.fetch = realFetch;
  }
});
