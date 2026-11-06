import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";

export async function POST() {
  const out = NextResponse.json({ success: true });
  out.cookies.set("session", "", { ...SESSION_COOKIE, maxAge: 0 });
  return out;
}
