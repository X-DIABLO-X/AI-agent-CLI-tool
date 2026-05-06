import { OpenAI } from "openai";

export const BASE_URL =
  process.env.GROQ_BASE_URL ||
  process.env.OPENAI_BASE_URL ||
  "https://api.groq.com/openai/v1";

const GROQ_MODEL_LIMITS = {
  "allam-2-7b": { rpm: 30 },
  "groq/compound": { rpm: 30 },
  "groq/compound-mini": { rpm: 30 },
  "llama-3.1-8b-instant": { rpm: 30 },
  "llama-3.3-70b-versatile": { rpm: 30 },
  "meta-llama/llama-4-scout-17b-16e-instruct": { rpm: 30 },
  "meta-llama/llama-prompt-guard-2-22m": { rpm: 30 },
  "meta-llama/llama-prompt-guard-2-86m": { rpm: 30 },
  "openai/gpt-oss-120b": { rpm: 30 },
  "openai/gpt-oss-20b": { rpm: 30 },
  "openai/gpt-oss-safeguard-20b": { rpm: 30 },
  "qwen/qwen3-32b": { rpm: 60 },
};

const MAX_RATE_LIMIT_WAIT_MS = Number(
  process.env.GROQ_MAX_RATE_LIMIT_WAIT_MS || 15000
);
const MAX_KEY_COOLDOWN_MS = Number(
  process.env.GROQ_MAX_KEY_COOLDOWN_MS || 60000
);

const rawKeys = [
  ...(process.env.GROQ_API_KEYS || "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean),
  ...(process.env.GROQ_API_KEY ? [process.env.GROQ_API_KEY.trim()] : []),
];

const uniqueKeys = [...new Set(rawKeys)];
const keyPool = uniqueKeys.map((key, index) => ({
  key,
  index,
  availableAt: 0,
  lastUsedAt: 0,
  disabled: false,
}));

const clientCache = new Map();
let roundRobinIndex = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getClient(apiKey) {
  if (!clientCache.has(apiKey)) {
    clientCache.set(
      apiKey,
      new OpenAI({
        apiKey,
        baseURL: BASE_URL,
      })
    );
  }
  return clientCache.get(apiKey);
}

function getMinDelayMs(model, overrideMs) {
  if (Number.isFinite(overrideMs) && overrideMs > 0) return overrideMs;
  const fromEnv = Number(
    process.env.GROQ_MIN_REQUEST_INTERVAL_MS ||
      process.env.MODEL_MIN_REQUEST_INTERVAL_MS
  );
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return Math.ceil(60000 / (GROQ_MODEL_LIMITS[model]?.rpm || 30));
}

function parseRetryDelayMs(err, fallbackMs) {
  const headerValue =
    err?.headers?.["retry-after"] ||
    err?.response?.headers?.["retry-after"] ||
    err?.cause?.headers?.["retry-after"];
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, MAX_RATE_LIMIT_WAIT_MS);
  }
  return Math.min(fallbackMs, MAX_RATE_LIMIT_WAIT_MS);
}

function isTransient(err) {
  const code = err?.code || err?.cause?.code || "";
  if (
    [
      "ECONNRESET",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "ENETUNREACH",
      "ENOTFOUND",
      "EPIPE",
      "UND_ERR_SOCKET",
    ].includes(code)
  ) {
    return true;
  }
  if (err?.status && err.status >= 500) return true;
  return (
    typeof err?.message === "string" &&
    /connection error|fetch failed|timeout/i.test(err.message)
  );
}

function getNextReadyKey(model, minDelayMs) {
  const now = Date.now();
  let earliest = Number.POSITIVE_INFINITY;
  let enabledKeys = 0;

  for (let offset = 0; offset < keyPool.length; offset++) {
    const idx = (roundRobinIndex + offset) % keyPool.length;
    const state = keyPool[idx];
    if (state.disabled) {
      continue;
    }
    enabledKeys++;
    const readyAt = Math.max(state.availableAt, state.lastUsedAt + minDelayMs);
    if (readyAt <= now) {
      roundRobinIndex = (idx + 1) % keyPool.length;
      state.lastUsedAt = now;
      return { state, waitMs: 0, enabledKeys };
    }
    earliest = Math.min(earliest, readyAt);
  }

  return {
    state: null,
    waitMs:
      enabledKeys > 0 && Number.isFinite(earliest)
        ? Math.max(0, earliest - now)
        : 0,
    enabledKeys,
  };
}

async function acquireKey(model, minDelayMs) {
  if (keyPool.length === 0) {
    throw new Error(
      "Missing Groq API key. Set GROQ_API_KEYS or GROQ_API_KEY in .env."
    );
  }

  while (true) {
    const { state, waitMs, enabledKeys } = getNextReadyKey(model, minDelayMs);
    if (state) return state;
    if (enabledKeys === 0) {
      throw new Error(
        "All configured Groq API keys are invalid or disabled. Add fresh keys to GROQ_API_KEYS."
      );
    }
    await sleep(waitMs);
  }
}

export function hasGroqApiKeys() {
  return keyPool.length > 0;
}

function isInvalidKeyError(err) {
  const message = String(err?.message || "");
  return (
    err?.status === 401 ||
    err?.code === "expired_api_key" ||
    /invalid api key|expired_api_key|incorrect api key|unauthorized/i.test(
      message
    )
  );
}

export async function createGroqChatCompletion(
  params,
  { minDelayMs, maxRetries = 6, logger } = {}
) {
  const delayMs = getMinDelayMs(params.model, minDelayMs);
  let attempt = 0;
  let lastErr;

  while (attempt <= maxRetries) {
    const state = await acquireKey(params.model, delayMs);

    try {
      const client = getClient(state.key);
      return await client.chat.completions.create(params);
    } catch (err) {
      lastErr = err;

      if (isInvalidKeyError(err)) {
        state.disabled = true;
        state.availableAt = Number.POSITIVE_INFINITY;
        if (logger) {
          logger(
            `[auth] Key ${state.index + 1}/${keyPool.length} is invalid or expired. Disabling it and rotating to the next key...`
          );
        }
        attempt++;
        continue;
      }

      if (err?.status === 429) {
        const fallbackMs = Math.max(delayMs * (attempt + 2), delayMs + 500);
        const cooldownMs = Math.min(
          parseRetryDelayMs(err, fallbackMs),
          MAX_KEY_COOLDOWN_MS
        );
        state.availableAt = Date.now() + cooldownMs;
        if (logger) {
          logger(
            `[rate-limit] Key ${state.index + 1}/${keyPool.length} cooling down for ${cooldownMs}ms. Rotating to the next key...`
          );
        }
        attempt++;
        continue;
      }

      if (!isTransient(err) || attempt === maxRetries) {
        throw err;
      }

      const retryMs =
        Math.min(8000, 800 * 2 ** attempt) + Math.floor(Math.random() * 400);
      if (logger) {
        logger(
          `[retry] ${String(err.message || "").slice(0, 80)} (attempt ${attempt + 1}/${maxRetries}) - waiting ${retryMs}ms...`
        );
      }
      await sleep(retryMs);
      attempt++;
    }
  }

  throw lastErr;
}
