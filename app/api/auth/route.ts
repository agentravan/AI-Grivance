/**
 * app/api/auth/route.ts — admin sign-in for the Training Panel.
 *
 *   GET    → { admin: string | null, configured: boolean }
 *   POST   → { name, passcode }  sets a signed httpOnly session cookie
 *   DELETE → signs out
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  ADMIN_COOKIE,
  authConfigured,
  clientKey,
  createSession,
  getAdmin,
  passcodeMatches,
  sessionCookieOptions,
} from "@/lib/auth";
import { audit } from "@/lib/knowledge";
import { store } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const admin = await getAdmin(req);
  return NextResponse.json({ admin: admin?.name ?? null, configured: authConfigured() });
}

export async function POST(req: NextRequest) {
  if (!authConfigured()) {
    return NextResponse.json({ error: "Set ADMIN_PASSCODE and AUTH_SECRET (32+ chars) in your environment." }, { status: 503 });
  }
  // Brute-force protection: 5 attempts per minute per client.
  if ((await store.incrWindow(`rl:auth:${clientKey(req)}`, 60)) > 5) {
    return NextResponse.json({ error: "Too many attempts. Wait a minute." }, { status: 429 });
  }
  const body = (await req.json().catch(() => ({}))) as { name?: string; passcode?: string };
  const name = String(body.name ?? "").trim().slice(0, 60);
  if (!name) return NextResponse.json({ error: "Enter your name (it is recorded in the audit log)." }, { status: 400 });
  if (!passcodeMatches(String(body.passcode ?? ""))) {
    return NextResponse.json({ error: "Incorrect passcode." }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true, admin: name });
  res.cookies.set(ADMIN_COOKIE, await createSession(name), sessionCookieOptions);
  await audit(name, "sign-in");
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, "", { ...sessionCookieOptions, maxAge: 0 });
  return res;
}
