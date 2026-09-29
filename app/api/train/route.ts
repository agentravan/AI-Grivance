/**
 * app/api/train/route.ts — the training & knowledge handler (admins only).
 *
 *   GET    /api/train                     → draft docs, settings, launch status, audit log
 *   POST   /api/train  (multipart)        → upload ONE file: fields `file`, `title`, `scope`
 *   POST   /api/train  (JSON)             → { action: "text", title, scope, text }
 *                                           { action: "settings", settings: Partial<OrgSettings> }
 *   PUT    /api/train                     → GO LIVE: { force?: boolean }
 *   DELETE /api/train?id=<docId>          → remove a draft document
 *   DELETE /api/train?action=offline      → kill switch: take the assistant offline
 *
 * Supported uploads: .pdf (text-based, not scanned), .txt, .md, .csv, .json.
 * For Word/Google Docs: File → Download → PDF, or paste the text.
 *
 * Vercel caps request bodies at 4.5 MB, so upload one file per request.
 */
import { NextResponse, type NextRequest } from "next/server";
import { authConfigured, clientKey, getAdmin } from "@/lib/auth";
import { store } from "@/lib/store";
import { lastPulse, runPulse } from "@/lib/pulse";
import { runSelfTest } from "@/lib/selftest";
import { webSearchEnabled } from "@/lib/search";
import {
  addDraftDoc,
  approveDraftDoc,
  deleteDraftDoc,
  draftStatus,
  getDraftSettings,
  listAudit,
  listDraftDocs,
  publish,
  saveDraftSettings,
  takeOffline,
} from "@/lib/knowledge";
import type { DocScope, OrgSettings } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_CHARS = 400_000;
const MIN_TEXT_CHARS = 40;

const json = (data: unknown, status = 200) =>
  NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });

type AdminCheck = { ok: true; admin: { name: string } } | { ok: false; res: NextResponse };

async function requireAdmin(req: NextRequest): Promise<AdminCheck> {
  if (!authConfigured()) {
    return { ok: false, res: json({ error: "Admin access is not configured. Set ADMIN_PASSCODE and AUTH_SECRET." }, 503) };
  }
  const admin = await getAdmin(req);
  if (!admin) return { ok: false, res: json({ error: "Please sign in to the Training Panel." }, 401) };
  return { ok: true, admin };
}

const parseScope = (v: unknown): DocScope => (v === "hr" || v === "ld" ? v : "both");

async function extractFileText(file: File): Promise<{ text: string; source: "pdf" | "text" }> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf") || file.type === "application/pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
    const { text } = await extractText(pdf, { mergePages: true });
    return { text: Array.isArray(text) ? text.join("\n\n") : text, source: "pdf" };
  }
  if (/\.(txt|md|markdown|csv|json)$/.test(name) || file.type.startsWith("text/")) {
    return { text: await file.text(), source: "text" };
  }
  throw new Error("Unsupported file type. Upload PDF, TXT, MD, CSV or JSON — or paste the text.");
}

// ───────────────────────────────── GET ─────────────────────────────────

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.res;
  const { admin } = auth;
  const [docs, settings, status, audit, pulse] = await Promise.all([
    listDraftDocs(),
    getDraftSettings(),
    draftStatus(),
    listAudit(30),
    lastPulse(),
  ]);
  return json({
    admin: admin.name,
    docs,
    settings,
    status,
    audit,
    pulse,
    webSearch: webSearchEnabled(),
    storePersistent: store.kind === "upstash",
  });
}

// ───────────────────────────────── POST ─────────────────────────────────

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.res;
  const { admin } = auth;

  // Light rate limit on uploads too.
  if ((await store.incrWindow(`rl:train:${clientKey(req)}`, 60)) > 30) {
    return json({ error: "Too many uploads — wait a minute." }, 429);
  }

  const contentType = req.headers.get("content-type") ?? "";

  try {
    // ── File upload ──
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return json({ error: "No file received." }, 400);
      if (file.size > MAX_FILE_BYTES) return json({ error: "File is larger than 4 MB. Split it or paste the text." }, 413);

      const { text, source } = await extractFileText(file);
      if (text.trim().length < MIN_TEXT_CHARS) {
        return json(
          {
            error:
              "Almost no text could be read from this file. If it is a scanned PDF, run it through OCR first (e.g. open in Google Drive → Open with Google Docs) and upload the result.",
          },
          422,
        );
      }
      const title = String(form.get("title") || file.name.replace(/\.[^.]+$/, "")).trim();
      const doc = await addDraftDoc({
        title,
        scope: parseScope(form.get("scope")),
        text: text.slice(0, MAX_TEXT_CHARS),
        source,
        by: admin.name,
      });
      return json({ ok: true, doc });
    }

    // ── JSON actions ──
    const body = (await req.json()) as {
      action?: string;
      id?: string;
      title?: string;
      scope?: string;
      text?: string;
      settings?: Partial<OrgSettings>;
    };

    if (body.action === "text") {
      const text = String(body.text ?? "");
      if (text.trim().length < MIN_TEXT_CHARS) return json({ error: "Please paste a bit more text." }, 400);
      if (!body.title?.trim()) return json({ error: "Give the document a title." }, 400);
      const doc = await addDraftDoc({
        title: body.title,
        scope: parseScope(body.scope),
        text: text.slice(0, MAX_TEXT_CHARS),
        source: "text",
        by: admin.name,
      });
      return json({ ok: true, doc });
    }

    if (body.action === "pulse") {
      const run = await runPulse(admin.name);
      return run.ok ? json({ ok: true, pulse: run }) : json({ error: run.detail, pulse: run }, 502);
    }

    if (body.action === "selftest") {
      return json({ ok: true, selftest: runSelfTest() });
    }

    if (body.action === "approve" && body.id) {
      const doc = await approveDraftDoc(String(body.id), admin.name);
      return doc ? json({ ok: true, doc }) : json({ error: "Document not found." }, 404);
    }

    if (body.action === "settings" && body.settings && typeof body.settings === "object") {
      const settings = await saveDraftSettings(body.settings, admin.name);
      return json({ ok: true, settings });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Upload failed.";
    return json({ error: message }, 400);
  }
}

// ───────────────────────────────── PUT (GO LIVE) ─────────────────────────────────

export async function PUT(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.res;
  const { admin } = auth;

  const body = (await req.json().catch(() => ({}))) as { force?: boolean };
  const [docs, status, settings] = await Promise.all([listDraftDocs(), draftStatus(), getDraftSettings()]);

  // Pre-flight checks before anything goes in front of employees.
  const problems: string[] = [];
  if (!docs.length) problems.push("Upload at least one policy or catalog document.");
  if (!settings.icEmail && !settings.icPhone && !settings.grievanceChannelUrl) {
    problems.push("Add Internal Committee / official grievance contact details in Settings.");
  }
  const unreviewed = docs.filter((d) => d.needsReview);
  if (unreviewed.length) {
    problems.push(`Approve or delete web-sourced updates first: ${unreviewed.map((d) => d.title).join(", ")}.`);
  }
  if (!status.testedSinceChange && !body.force) {
    problems.push("Run at least one Test Mode conversation against the current draft.");
  }
  if (problems.length) return json({ error: "Not ready to go live.", problems }, 409);

  const snap = await publish(admin.name);
  return json({ ok: true, version: snap.version, publishedAt: snap.publishedAt, documents: snap.docs.length });
}

// ───────────────────────────────── DELETE ─────────────────────────────────

export async function DELETE(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.res;
  const { admin } = auth;

  if (req.nextUrl.searchParams.get("action") === "offline") {
    await takeOffline(admin.name);
    return json({ ok: true, live: false });
  }
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return json({ error: "Missing id." }, 400);
  const ok = await deleteDraftDoc(id, admin.name);
  return ok ? json({ ok: true }) : json({ error: "Document not found." }, 404);
}
