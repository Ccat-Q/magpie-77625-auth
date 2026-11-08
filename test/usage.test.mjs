import test from "node:test";
import assert from "node:assert/strict";
import { _internal as I } from "../index.mjs";
import { clientStub, makeFetch, reply, sessionAuth } from "./helpers.mjs";

test("usage maps credits and today's calls into balance windows", async () => {
  const today = I.beijingDate();
  const { fetchImpl } = makeFetch(({ path }) => {
    if (path === "/api/auth/me") {
      return reply(200, {
        username: "alice",
        credits: 1234.5,
        checkin_enabled: true,
        permissions: ["checkin"],
      });
    }
    if (path === "/api/account/stats") {
      return reply(200, {
        daily: [
          { date: "2000-01-01", calls: 99, cost: 999 },
          { date: today, calls: 3, cost: 12.5 },
        ],
      });
    }
    return reply(404, {});
  });

  const usage = await I.runUsage(sessionAuth, { fetchImpl });

  assert.equal(usage.plan, "公益免费");
  assert.equal(usage.user, "alice");
  assert.equal(usage.balance, `${I.formatCredits(1234.5)} 积分`);
  assert.equal(usage.windows.length, 2);
  assert.equal(usage.windows[0].name, "积分余额");
  assert.equal(usage.windows[0].balance, 1234.5);
  assert.equal(usage.windows[0].unit, "积分");
  assert.equal(usage.windows[1].name, "今日");
  assert.equal(usage.windows[1].aside, true);
  assert.equal(usage.windows[1].display, "3 次 · 12.5 积分");
});

test("a stats failure still returns the balance", async () => {
  const { fetchImpl } = makeFetch(({ path }) => {
    if (path === "/api/auth/me") return reply(200, { username: "alice", credits: 7 });
    if (path === "/api/account/stats") return reply(500, { detail: "boom" });
    return reply(404, {});
  });

  const usage = await I.runUsage(sessionAuth, { fetchImpl });
  assert.equal(usage.windows.length, 1);
  assert.equal(usage.windows[0].balance, 7);
  assert.equal(usage.balance, "7 积分");
});

test("an API-key-only account cannot read credits", async () => {
  const usage = await I.runUsage({ type: "api", key: "sk-test" }, {});
  assert.match(usage.error, /API Key/);
  assert.equal(usage.windows, undefined);
});

test("usage refreshes an expired session and saves it", async () => {
  const client = clientStub();
  const { fetchImpl } = makeFetch(({ path, method, headers }) => {
    if (path === "/api/auth/login" && method === "POST") {
      return reply(200, {}, { "set-cookie": "session=new; Max-Age=120" });
    }
    if (path === "/api/auth/me") {
      if (headers.get("cookie") === "session=old") return reply(401, { detail: "未登录" });
      return reply(200, { username: "alice", credits: 9 });
    }
    if (path === "/api/account/stats") return reply(200, { daily: [] });
    return reply(404, {});
  });

  const usage = await I.runUsage(
    { ...sessionAuth, access: "session=old" },
    { client, fetchImpl },
  );

  assert.equal(usage.windows[0].balance, 9);
  assert.equal(client.saved.length, 1);
  assert.equal(client.saved[0].body.access, "session=new");
});

test("usage without a saved password marks the sign-in expired", async () => {
  const { fetchImpl } = makeFetch(() => reply(401, { detail: "未登录" }));

  await assert.rejects(
    I.runUsage({ ...sessionAuth, refresh: undefined }, { fetchImpl }),
    (error) => error.signIn === "expired",
  );
});

test("usageFrom tolerates a missing stats object and missing credits", () => {
  const usage = I.usageFrom({ username: "alice" }, null);
  assert.equal(usage.windows.length, 1);
  assert.equal(usage.windows[0].balance, 0);
  assert.equal(usage.balance, "0 积分");
});