import { NextResponse } from "next/server";

export async function POST() {
  const out = NextResponse.json({ success: true });
  out.cookies.delete("session");
  return out;
}
