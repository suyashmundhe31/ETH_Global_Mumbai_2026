import { createHmac, timingSafeEqual } from "crypto";

// Key is derived from the RP signing key. Prefixes keep cookie and challenge MACs separate.
const mac = (prefix: string, v: string) => {
  const key = process.env.RP_SIGNING_KEY;
  if (!key) throw new Error("RP_SIGNING_KEY is not set");
  return createHmac("sha256", prefix + key).update(v).digest("hex");
};
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** A verified human's session lasts this long; then World ID is asked again. */
export const SESSION_SECONDS = 7 * 24 * 60 * 60;

/** Cookie options for the session (httpOnly: never readable by page scripts). */
export const SESSION_COOKIE = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: SESSION_SECONDS,
};

// Session cookie: "<playerId>.<expiresAtUnix>.<mac>"
export const sign = (id: string, nowSec = Math.floor(Date.now() / 1000)) => {
  const exp = String(nowSec + SESSION_SECONDS);
  return `${id}.${exp}.${mac("session:", `${id}.${exp}`)}`;
};

export function read(cookie?: string, nowSec = Math.floor(Date.now() / 1000)): string | null {
  const [id, exp, m] = (cookie ?? "").split(".");
  if (!id || !exp || !m || !/^\d+$/.test(exp) || Number(exp) <= nowSec) return null;
  try {
    return same(m, mac("session:", `${id}.${exp}`)) ? id : null;
  } catch {
    return null;
  }
}

// Wallet challenge: the server vouches for the message it asked the wallet to sign.
export const tag = (message: string) => mac("challenge:", message);
export const tagOk = (message: string, t: string) => {
  try {
    return same(t, tag(message));
  } catch {
    return false;
  }
};
