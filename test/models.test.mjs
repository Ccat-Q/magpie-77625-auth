import test from "node:test";
import assert from "node:assert/strict";
import { _internal as I } from "../index.mjs";
import { clientStub, makeFetch, reply, sessionAuth } from "./helpers.mjs";

test("account models are filtered to what the account may call", async () => {
  const { fetchImpl } = makeFetch(({ path }) => {
    if (path === "/api/account/models") {
      return reply(200, {
        models: [
          { name: "x-deepseek-v4.1-flash", allowed: true, price_prompt: 1625, price_completion: 1950 },
          { name: "gemini-3.8-flash", allowed: false, price_prompt: 2730, price_completion: 23400 },
          { name: "sensenova-6.8-flash-lite", allowed: true, price_prompt: 0, price_completion: 0 },
        ],
      });
    }
    return reply(404, {});
  });

  const models = await I.listModels(sessionAuth, { fetchImpl });

  assert.deepEqual(Object.keys(models).sort(), [
    "sensenova-6.8-flash-lite",
    "x-deepseek-v4.1-flash",
  ]);
  assert.equal(models["sensenova-6.8-flash-lite"].free, true);
  assert.equal(models["x-deepseek-v4.1-flash"].free, undefined);
  assert.equal(models["x-deepseek-v4.1-flash"].limit.context, 1_000_000);
  assert.equal(models["x-deepseek-v4.1-flash"].limit.output, 393_216);
  assert.equal(models["x-deepseek-v4.1-flash"].tool_call, true);
});

test("API-key accounts fall back to /v1/models", async () => {
  const { fetchImpl } = makeFetch(({ path, headers }) => {
    if (path === "/v1/models") {
      assert.equal(headers.get("authorization"), "Bearer sk-test");
      return reply(200, {
        data: [{ id: "x-deepseek-v4.1-flash" }, { id: "gemini-4" }],
      });
    }
    return reply(404, {});
  });

  const models = await I.listModels({ type: "api", key: "sk-test" }, { fetchImpl });
  assert.deepEqual(Object.keys(models).sort(), ["gemini-4", "x-deepseek-v4.1-flash"]);
  assert.equal(models["gemini-4"].limit.output, 1_000_000);
});

test("a failing account list returns null so the caller keeps the static table", async () => {
  const { fetchImpl } = makeFetch(() => reply(500, { detail: "boom" }));
  assert.equal(await I.listModels(sessionAuth, { fetchImpl }), null);
});

test("an expired account list without a password marks the sign-in expired", async () => {
  const { fetchImpl } = makeFetch(() => reply(401, { detail: "未登录" }));

  await assert.rejects(
    I.listModels({ ...sessionAuth, refresh: undefined }, { fetchImpl }),
    (error) => error.signIn === "expired",
  );
});

test("an expired account list with a password refreshes and retries", async () => {
  const client = clientStub();
  const { fetchImpl } = makeFetch(({ path, method, headers }) => {
    if (path === "/api/auth/login" && method === "POST") {
      return reply(200, {}, { "set-cookie": "session=new; Max-Age=120" });
    }
    if (path === "/api/auth/me") {
      if (headers.get("cookie") === "session=old") return reply(401, { detail: "未登录" });
      return reply(200, { username: "alice" });
    }
    if (path === "/api/account/models") {
      if (headers.get("cookie") === "session=old") return reply(401, { detail: "未登录" });
      return reply(200, { models: [{ name: "kimi-k3", allowed: true }] });
    }
    return reply(404, {});
  });

  const models = await I.listModels(
    { ...sessionAuth, access: "session=old" },
    { client, fetchImpl },
  );

  assert.deepEqual(Object.keys(models), ["kimi-k3"]);
  assert.equal(client.saved.length, 1);
});

test("the documented model limits are exact", () => {
  assert.deepEqual(I.MODEL_LIMITS["deepseek-flash"], { context: 1_000_000, output: 393_216 });
  assert.deepEqual(I.MODEL_LIMITS["deepseek-v4-flash"], { context: 1_048_576, output: 384_000 });
  assert.deepEqual(I.MODEL_LIMITS["gemini-3.1-pro"], { context: 1_048_576, output: 65_536 });
  assert.deepEqual(I.MODEL_LIMITS["gemini-3.6-flash"], { context: 1_048_576, output: 65_536 });
  assert.deepEqual(I.MODEL_LIMITS["gemini-3.8-flash"], { context: 1_048_576, output: 65_536 });
  assert.deepEqual(I.MODEL_LIMITS["gemini-4"], { context: 1_048_576, output: 1_000_000 });
  assert.deepEqual(I.MODEL_LIMITS["glm-5.2"], { context: 1_000_000, output: 65_536 });
  assert.deepEqual(I.MODEL_LIMITS["kimi-k3"], { context: 1_000_000, output: 131_072 });
  assert.deepEqual(I.MODEL_LIMITS["opus5.5"], { context: 1_000_000, output: 131_072 });
  assert.deepEqual(I.MODEL_LIMITS["sensenova-6.8-flash-lite"], {
    context: 262_144,
    output: 65_536,
    free: true,
  });
  assert.deepEqual(I.MODEL_LIMITS["x-deepseek-v4.1-flash"], {
    context: 1_000_000,
    output: 393_216,
  });
  assert.deepEqual(I.MODEL_LIMITS["不可信-grok-4.7"], { context: 524_288, output: 262_144 });
});

test("unknown models use conservative defaults and stay text-only", () => {
  const model = I.normalizeModel("some-new-model");
  assert.deepEqual(model.limit, { context: 131_072, output: 32_768 });
  assert.deepEqual(model.modalities, { input: ["text"], output: ["text"] });
  assert.equal(model.free, undefined);
});

test("the static model table covers every documented model", () => {
  const models = I.staticModels();
  assert.equal(Object.keys(models).length, Object.keys(I.MODEL_LIMITS).length);
  assert.equal(models["sensenova-6.8-flash-lite"].free, true);
});