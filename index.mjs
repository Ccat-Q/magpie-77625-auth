import { V1_URL } from "./lib/api.mjs";
import {
  DEFAULT_LIMITS,
  MODEL_LIMITS,
  normalizeModel,
  staticModels,
} from "./lib/models.mjs";
import {
  PROVIDER_ID,
  beijingDate,
  formatCredits,
  hasSession,
  limitsFor,
  listModels,
  loginWithCookieFlow,
  loginWithPasswordFlow,
  refreshAuth,
  resolveApiKey,
  runCheckin,
  runUsage,
  safeError,
  usageFrom,
  ensureSession,
} from "./lib/session.mjs";

const ICON = "https://ly.77625.xyz/static/logo-77625.png";
const FALLBACK_MODELS = staticModels();

function success(fields) {
  const { type: _savedType, ...rest } = fields ?? {};
  return { type: "success", ...rest };
}

function failed(error) {
  return { type: "failed", error: safeError(error) };
}

export const SevenSevenAuthPlugin = async ({ client }) => ({
  config: async (cfg) => {
    cfg.provider ??= {};
    cfg.provider[PROVIDER_ID] ??= {
      name: "77625路由站",
      icon: ICON,
      npm: "@ai-sdk/openai-compatible",
      api: V1_URL,
      models: staticModels(),
    };
  },

  auth: {
    provider: PROVIDER_ID,
    icon: ICON,
    maxConcurrency: 2,

    methods: [
      {
        type: "oauth",
        label: "账号登录（自动续期）",
        prompts: [
          {
            type: "text",
            key: "username",
            message: "77625 用户名",
            placeholder: "站点登录用户名",
          },
          {
            type: "password",
            key: "password",
            message: "77625 密码",
          },
          {
            type: "password",
            key: "apiKey",
            message: "聊天 API Key（可留空，留空自动创建）",
            placeholder: "sk-…",
          },
          {
            type: "text",
            key: "keyGroup",
            message: "密钥分组（可留空，默认第一个可用分组）",
            placeholder: "分组名称",
          },
        ],
        async authorize(inputs = {}, options = {}) {
          try {
            const { auth } = await loginWithPasswordFlow({
              username: inputs.username,
              password: inputs.password,
              apiKey: inputs.apiKey,
              keyGroup: inputs.keyGroup,
              signal: options.signal,
              fetchImpl: options.fetch,
            });
            return success(auth);
          } catch (error) {
            return failed(error);
          }
        },
      },
      {
        type: "oauth",
        label: "浏览器会话 Cookie（不保存密码）",
        prompts: [
          {
            type: "password",
            key: "cookie",
            message: "浏览器 Cookie 头",
            placeholder: "name=value; name2=value2",
          },
          {
            type: "password",
            key: "apiKey",
            message: "聊天 API Key（可留空，留空自动创建）",
            placeholder: "sk-…",
          },
          {
            type: "text",
            key: "keyGroup",
            message: "密钥分组（可留空，默认第一个可用分组）",
            placeholder: "分组名称",
          },
        ],
        async authorize(inputs = {}, options = {}) {
          try {
            const { auth } = await loginWithCookieFlow({
              cookie: inputs.cookie,
              apiKey: inputs.apiKey,
              keyGroup: inputs.keyGroup,
              signal: options.signal,
              fetchImpl: options.fetch,
            });
            return success(auth);
          } catch (error) {
            return failed(error);
          }
        },
      },
      {
        type: "api",
        label: "仅 API Key（不签到、不查积分）",
        placeholder: "sk-…",
      },
    ],

    async loader(getAuth) {
      const auth = await getAuth();
      const apiKey = auth?.type === "api" ? auth.key : auth?.apiKey;
      return {
        baseURL: V1_URL,
        apiKey: typeof apiKey === "string" && apiKey ? apiKey : undefined,
      };
    },

    async refresh(auth) {
      return refreshAuth(auth);
    },

    async usage(getAuth) {
      let auth;
      try {
        auth = await getAuth();
      } catch (error) {
        return { error: safeError(error) };
      }
      try {
        return await runUsage(auth, { client });
      } catch (error) {
        if (error?.signIn) throw error;
        return { error: safeError(error) };
      }
    },

    async checkin(getAuth) {
      let auth;
      try {
        auth = await getAuth();
      } catch {
        return { outcome: "failed", message: "无法读取账号登录信息" };
      }
      try {
        return await runCheckin(auth, { client });
      } catch (error) {
        if (error?.signIn) throw error;
        return { outcome: "failed", message: safeError(error) };
      }
    },
  },

  provider: {
    id: PROVIDER_ID,
    async models(provider, { auth } = {}) {
      try {
        const dynamic = await listModels(auth, { client });
        return dynamic ?? provider?.models ?? FALLBACK_MODELS;
      } catch (error) {
        if (error?.signIn) throw error;
        return provider?.models ?? FALLBACK_MODELS;
      }
    },
  },
});

// Test hook: never export helper functions besides the plugin itself, or the
// Magpie loader will treat each one as a plugin.
export const _internal = {
  PROVIDER_ID,
  V1_URL,
  MODEL_LIMITS,
  DEFAULT_LIMITS,
  FALLBACK_MODELS,
  staticModels,
  normalizeModel,
  beijingDate,
  formatCredits,
  hasSession,
  limitsFor,
  listModels,
  loginWithCookieFlow,
  loginWithPasswordFlow,
  refreshAuth,
  resolveApiKey,
  runCheckin,
  runUsage,
  safeError,
  usageFrom,
  ensureSession,
};