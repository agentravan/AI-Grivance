/**
 * app/api/cron/pulse/route.ts — daily Regulatory & Skills Pulse (Vercel Cron).
 *
 * Scheduled in vercel.json. Vercel sends `Authorization: Bearer <CRON_SECRET>`
 * automatically when the CRON_SECRET env var is set, so nobody else can trigger it.
 */
import { NextResponse, type NextRequest } from "next/server";
import { runPulse } from "@/lib/pulse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const run = await runPulse("scheduled pulse");
  return NextResponse.json(run, { status: run.ok ? 200 : 500 });
}
