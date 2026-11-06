export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createLogger(scope) {
  const fmt = (level, args) => [`${new Date().toISOString()} [${level}] [${scope}]`, ...args];
  return {
    info: (...a) => console.log(...fmt("info", a)),
    warn: (...a) => console.warn(...fmt("warn", a)),
    error: (...a) => console.error(...fmt("error", a)),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

/** Retries an async fn with exponential backoff. */
export async function withRetry(fn, { attempts = 3, baseDelayMs = 1000, onError } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      onError?.(err, i);
      if (i < attempts - 1) await sleep(baseDelayMs * 2 ** i);
    }
  }
  throw lastErr;
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** JSON.stringify that turns bigint into decimal strings. */
export const toJson = (value) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

// RPC URLs can carry access keys in their path (Arkiv: rabdi({ accessKey }); providers like Alchemy),
// so every URL is removed from messages that reach logs or API responses (arkiv-security-trust recipe).
export const redactUrls = (text) => String(text).replace(/\b(?:https?|wss?):\/\/[^\s"'<>)]+/gi, "<url redacted>");

// viem errors keep the RPC's actual reason (e.g. "eth_getLogs is limited to a 200 range") in `details`.
export const errMessage = (err) => {
  const msg = err?.shortMessage || err?.message || String(err);
  return redactUrls(err?.details && !msg.includes(err.details) ? `${msg} (${err.details})` : msg);
};

/** host[:port] of a URL, for logs (never the path, which may hold a key). */
export const urlHost = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return "<invalid url>";
  }
};
