/**
 * app/api/chat/route.ts — the AI chat & grievance engine.
 *
 *   GET  /api/chat              → public status (is it live? org contacts, flags)
 *   GET  /api/chat?stage=draft  → same, using DRAFT settings (admins only, for test mode)
 *   POST /api/chat              → streams a plain-text reply
 *
 * Request body (POST):
 *   { module: "ld" | "hr", messages: [{ role: "user" | "assistant", content: string }], stage?: "live" | "draft" }
 *
 * Response: text/plain stream + headers
 *   x-aegis-route   : llm | fallback | posh | crisis | safety | offline | ratelimited
 *   x-aegis-sources : URI-encoded JSON array of source document titles
 *
 * PRIVACY: this handler never logs or stores message content. Conversation
 * history lives only in the user's browser tab and is sent with each request.
 */
import { NextResponse, type NextRequest } from "next/server";
import { streamText } from "ai";
import { getModel, llmInfo } from "@/lib/llm";
import { clientKey, getAdmin } from "@/lib/auth";
import { store } from "@/lib/store";
import {
  buildDraftSnapshot,
  getLiveSnapshot,
  markTested,
  retrieve,
  type Snapshot,
} from "@/lib/knowledge";
import { buildSystemPrompt, fallbackAnswer, redactPII, screenMessage, screenedReply } from "@/lib/guardrails";
import { DEFAULT_SETTINGS, type ChatRoute, type ModuleId, type PublicStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30; // well within Vercel Hobby limits

const MAX_MESSAGES = 12; // conversation window sent to the model
const MAX_CHARS = 2000; // per message
const RATE_LIMIT = 20; // requests per minute per (hashed) client

const grievanceLlm = (): "redacted" | "off" => (process.env.GRIEVANCE_LLM === "off" ? "off" : "redacted");

// ───────────────────────────────── GET ─────────────────────────────────

export async function GET(req: NextRequest) {
  const wantsDraft = req.nextUrl.searchParams.get("stage") === "draft";
  const admin = wantsDraft ? await getAdmin(req) : null;
  const draft = Boolean(wantsDraft && admin);

  const live = await getLiveSnapshot();
  const settings = draft ? (await buildDraftSnapshot()).settings : (live?.settings ?? DEFAULT_SETTINGS);

  const status: PublicStatus = {
    live: Boolean(live),
    version: live?.version ?? 0,
    publishedAt: live?.publishedAt ?? null,
    settings,
    llmConfigured: llmInfo().provider !== "none",
    storePersistent: store.kind === "upstash",
    pilot: process.env.PILOT_MODE !== "off",
    grievanceLlm: grievanceLlm(),
    stage: draft ? "draft" : "live",
  };
  return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
}

// ───────────────────────────────── POST ─────────────────────────────────

type InMsg = { role: "user" | "assistant"; content: string };

function textResponse(body: ReadableStream<Uint8Array> | string, route: ChatRoute, sources: string[] = [], status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "x-aegis-route": route,
      "x-aegis-sources": encodeURIComponent(JSON.stringify(sources)),
    },
  });
}

export async function POST(req: NextRequest) {
  // 1) Rate limit (protects the free LLM quota from bots and loops).
  const hits = await store.incrWindow(`rl:chat:${clientKey(req)}`, 60);
  if (hits > RATE_LIMIT) {
    return textResponse("I'm receiving a lot of requests right now. Please wait a minute and try again.", "ratelimited", [], 429);
  }

  // 2) Validate input.
  let body: { module?: unknown; messages?: unknown; stage?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const module: ModuleId = body.module === "hr" ? "hr" : "ld";
  const messages: InMsg[] = (Array.isArray(body.messages) ? body.messages : [])
    .filter(
      (m): m is InMsg =>
        !!m && typeof m === "object" && (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
    )
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser?.content.trim()) return NextResponse.json({ error: "No user message" }, { status: 400 });

  // 3) Pick knowledge: LIVE for everyone, DRAFT for admins in test mode.
  let snap: Snapshot | null;
  if (body.stage === "draft") {
    const admin = await getAdmin(req);
    if (!admin) return NextResponse.json({ error: "Admin session required for test mode" }, { status: 401 });
    snap = await buildDraftSnapshot();
    await markTested(); // unlocks GO LIVE for the current draft
  } else {
    snap = await getLiveSnapshot();
  }
  const settings = snap?.settings ?? DEFAULT_SETTINGS;

  // 4) Deterministic safety screens — these never reach the LLM.
  const screen = screenMessage(lastUser.content);
  if (screen) return textResponse(screenedReply(screen, settings), screen);

  if (!snap) {
    return textResponse(
      "I'm not live yet — the HR and L&D team are still loading policies and courses. Please check back soon.",
      "offline",
    );
  }

  // 5) Retrieve grounding excerpts (from the redacted query + a little context).
  const recentUserText = messages
    .filter((m) => m.role === "user")
    .slice(-2)
    .map((m) => m.content)
    .join(" ");
  const excerpts = retrieve(snap, redactPII(recentUserText), module, 4);
  const sources = [...new Set(excerpts.map((e) => e.title))];

  // 6) Retrieval-only mode (no key, or grievance LLM disabled by policy).
  const model = getModel();
  if (!model || (module === "hr" && grievanceLlm() === "off")) {
    return textResponse(fallbackAnswer(module, settings, excerpts), "fallback", sources);
  }

  // 7) LLM call — PII-redacted history, strict system prompt, streamed back.
  const modelMessages = messages.map((m) =>
    m.role === "user"
      ? { role: "user" as const, content: redactPII(m.content) }
      : { role: "assistant" as const, content: m.content },
  );

  let failed = false;
  const result = streamText({
    model,
    system: buildSystemPrompt(module, settings, excerpts),
    messages: modelMessages,
    temperature: module === "hr" ? 0.2 : 0.5,
    maxOutputTokens: 400,
    maxRetries: 1,
    abortSignal: req.signal,
    onError: () => {
      // Deliberately log no content — only that an error occurred.
      failed = true;
      console.error("[aegis] LLM stream error (content not logged)");
    },
  });

  // Wrap the model stream so a 429/timeout before any text degrades gracefully
  // to a retrieval-only answer instead of an empty reply.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let emitted = 0;
      try {
        for await (const delta of result.textStream) {
          emitted += delta.length;
          controller.enqueue(encoder.encode(delta));
        }
      } catch {
        failed = true;
      }
      if (emitted === 0) {
        controller.enqueue(encoder.encode(fallbackAnswer(module, settings, excerpts)));
      } else if (failed) {
        controller.enqueue(encoder.encode("\n\n(Connection interrupted — please ask again if the answer looks incomplete.)"));
      }
      controller.close();
    },
  });

  return textResponse(stream, "llm", sources);
}
