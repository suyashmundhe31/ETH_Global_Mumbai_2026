import { createHmac, timingSafeEqual } from "crypto";

// Key is derived from the RP signing key. Prefixes keep cookie and challenge MACs separate.
const mac = (prefix: string, v: string) =>
  createHmac("sha256", prefix + process.env.RP_SIGNING_KEY!).update(v).digest("hex");
const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Session cookie: "<playerId>.<mac>"
export const sign = (id: string) => `${id}.${mac("session:", id)}`;
export function read(cookie?: string): string | null {
  const [id, m] = (cookie ?? "").split(".");
  return id && m && same(m, mac("session:", id)) ? id : null;
}

// Wallet challenge: the server vouches for the message it asked the wallet to sign.
export const tag = (message: string) => mac("challenge:", message);
export const tagOk = (message: string, t: string) => same(t, tag(message));