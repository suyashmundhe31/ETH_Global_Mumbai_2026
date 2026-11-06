import { NextResponse } from "next/server";

export async function POST() {
  const out = NextResponse.json({ success: true });
  out.cookies.set("session", "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return out;
}
