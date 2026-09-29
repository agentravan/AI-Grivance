/**
 * lib/auth.ts — minimal admin auth for the Training Panel and GO LIVE.
 *
 * One shared passcode (ADMIN_PASSCODE) + the admin's name, exchanged for a
 * signed, httpOnly, 8-hour session cookie (JWT via `jose`). Every admin action
 * is written to an audit log with that name, so there is at least a record of
 * who changed what.
 *
 * Checks happen inside each route handler (not in proxy/middleware) so the same
 * code works on Next.js 15 and 16 without renaming files.
 *
 * Upgrade path: swap this for SSO (e.g. Auth.js + Google Workspace / Entra ID)
 * when you move off the pilot.
 */
import { SignJWT, jwtVerify } from "jose";
import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

export const ADMIN_COOKIE = "aegis_admin";
const SESSION_HOURS = 8;

export function authConfigured(): boolean {
  return Boolean(process.env.ADMIN_PASSCODE && (process.env.AUTH_SECRET?.length ?? 0) >= 32);
}

function secretKey(): Uint8Array {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) throw new Error("AUTH_SECRET must be set (32+ characters).");
  return new TextEncoder().encode(s);
}

/** Constant-time passcode comparison (hash first so lengths always match). */
export function passcodeMatches(input: string): boolean {
  const expected = process.env.ADMIN_PASSCODE;
  if (!expected) return false;
  const a = createHash("sha256").update(input).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function createSession(name: string): Promise<string> {
  return new SignJWT({ name })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_HOURS}h`)
    .sign(secretKey());
}

export const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/",
  maxAge: SESSION_HOURS * 60 * 60,
};

export async function getAdmin(req: NextRequest): Promise<{ name: string } | null> {
  const token = req.cookies.get(ADMIN_COOKIE)?.value;
  if (!token || !authConfigured()) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey());
    return typeof payload.name === "string" ? { name: payload.name } : null;
  } catch {
    return null;
  }
}

/**
 * Privacy-preserving client key for rate limiting: a salted hash of the IP.
 * The raw IP is never stored.
 */
export function clientKey(req: NextRequest): string {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  return createHash("sha256")
    .update(`${process.env.AUTH_SECRET ?? "dev"}:${ip}`)
    .digest("hex")
    .slice(0, 24);
}
