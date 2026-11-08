import test from "node:test";
import assert from "node:assert/strict";
import { _internal as I } from "../index.mjs";
import { clientStub, makeFetch, reply, sessionAuth } from "./helpers.mjs";

function meHandler(overrides = {}) {
  return (call) => {
    if (call.path === "/api/auth/me") return reply(200, { username: "alice", credits: 100, ...overrides });
    if (call.path === "/api/account/checkin" && call.method === "POST") {
      return reply(200, { points: 10, credits: 110 });
    }
    return reply(404, {});
  };
}

test("checkin claims points", async () => {
  const { fetchImpl } = makeFetch(meHandler({ checkin_enabled: true, permissions: ["checkin"] }));
  const result = await I.runCheckin(sessionAuth, { fetchImpl });

  assert.equal(result.outcome, "claimed");
  assert.equal(result.credit, 10);
  assert.match(result.message, /\+10 积分/);
  assert.match(result.message, /110/);
});

test("checkin reports done when the account already checked in", async () => {
  const { fetchImpl } = makeFetch(
    meHandler({ checkin_enabled: true, permissions: ["checkin"], checked_in_today: true }),
  );
  const result = await I.runCheckin(sessionAuth, { fetchImpl });
  assert.equal(result.outcome, "done");
});

test("checkin reports inactive when the site has no check-in event", async () => {
  const { fetchImpl } = makeFetch(meHandler({ checkin_enabled: false }));
  const result = await I.runCheckin(sessionAuth, { fetchImpl });
  assert.equal(result.outcome, "inactive");
});

test("checkin reports ineligible without the checkin permission", async () => {
  const { fetchImpl } = makeFetch(meHandler({ checkin_enabled: true, permissions: [] }));
  const result = await I.runCheckin(sessionAuth, { fetchImpl });
  assert.equal(result.outcome, "ineligible");
});

test("checkin maps an already-checked-in 400 to done", async () => {
  const { fetchImpl } = makeFetch((call) => {
    if (call.path === "/api/auth/me") {
      return reply(200, {
        username: "alice",
        checkin_enabled: true,
        permissions: ["checkin"],
        checked_in_today: false,
      });
    }
    if (call.path === "/api/account/checkin") return reply(400, { detail: "今天已经签到过了" });
    return reply(404, {});
  });

  const result = await I.runCheckin(sessionAuth, { fetchImpl });
  assert.equal(result.outcome, "done");
});

test("checkin maps a captcha to captcha", async () => {
  const { fetchImpl } = makeFetch((call) => {
    if (call.path === "/api/auth/me") {
      return reply(200, {
        username: "alice",
        checkin_enabled: true,
        permissions: ["checkin"],
        checked_in_today: false,
      });
    }
    if (call.path === "/api/account/checkin") return reply(400, { detail: "请完成验证码" });
    return reply(404, {});
  });

  const result = await I.runCheckin(sessionAuth, { fetchImpl });
  assert.equal(result.outcome, "captcha");
});

test("checkin maps an unexpected site error to failed", async () => {
  const { fetchImpl } = makeFetch((call) => {
    if (call.path === "/api/auth/me") {
      return reply(200, {
        username: "alice",
        checkin_enabled: true,
        permissions: ["checkin"],
        checked_in_today: false,
      });
    }
    if (call.path === "/api/account/checkin") return reply(500, { detail: "服务器错误" });
    return reply(404, {});
  });

  const result = await I.runCheckin(sessionAuth, { fetchImpl });
  assert.equal(result.outcome, "failed");
  assert.match(result.message, /服务器错误/);
});

test("an API-key-only account is ineligible for check-in", async () => {
  const result = await I.runCheckin({ type: "api", key: "sk-test" }, {});
  assert.equal(result.outcome, "ineligible");
});

test("checkin refreshes a dead session and saves it", async () => {
  const client = clientStub();
  const { fetchImpl } = makeFetch((call) => {
    if (call.path === "/api/auth/login" && call.method === "POST") {
      return reply(200, {}, { "set-cookie": "session=new; Max-Age=120" });
    }
    if (call.path === "/api/auth/me") {
      if (call.headers.get("cookie") === "session=old") return reply(401, { detail: "未登录" });
      return reply(200, {
        username: "alice",
        credits: 100,
        checkin_enabled: true,
        permissions: ["checkin"],
        checked_in_today: false,
      });
    }
    if (call.path === "/api/account/checkin") return reply(200, { points: 10, credits: 110 });
    return reply(404, {});
  });

  const result = await I.runCheckin(
    { ...sessionAuth, access: "session=old" },
    { client, fetchImpl },
  );

  assert.equal(result.outcome, "claimed");
  assert.equal(client.saved.length, 1);
});

test("checkin 401 without a password marks the sign-in expired", async () => {
  const { fetchImpl } = makeFetch(() => reply(401, { detail: "未登录" }));

  await assert.rejects(
    I.runCheckin({ ...sessionAuth, refresh: undefined }, { fetchImpl }),
    (error) => error.signIn === "expired",
  );
});