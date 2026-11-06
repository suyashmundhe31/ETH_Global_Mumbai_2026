import { createHmac, timingSafeEqual } from "crypto";

// Key is derived from the RP signing key. Prefixes keep cookie and challenge MACs separate.
const mac = (prefix: string, v: string) =>
  createHmac("sha256", prefix + process.env.RP_SIGNING_KEY!).update(v).digest("hex");
const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Session cookie: "<playerId>.<expiresUnix>.<mac>". Sessions end after SESSION_SECONDS, so every new session
// goes through the wallet signature + World ID check again (see /api/verify).
export const SESSION_SECONDS = 8 * 60 * 60;
export function sign(id: string) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  return `${id}.${exp}.${mac("session:", `${id}.${exp}`)}`;
}
export function read(cookie?: string): string | null {
  const [id, exp, m] = (cookie ?? "").split(".");
  if (!id || !exp || !m || !/^\d+$/.test(exp) || Number(exp) <= Date.now() / 1000) return null;
  return same(m, mac("session:", `${id}.${exp}`)) ? id : null;
}

/** Cookie options for the session: script can't read it, HTTPS-only in production, gone when the session ends. */
export const SESSION_COOKIE = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_SECONDS,
};

// Wallet challenge: the server vouches for the message it asked the wallet to sign.
export const tag = (message: string) => mac("challenge:", message);
export const tagOk = (message: string, t: string) => same(t, tag(message));