/**
 * lib/knowledge.ts — the "training" layer.
 *
 * "Training" here means publishing reference content, not fine-tuning a model.
 * Admins upload handbooks/policies/catalogs → text is split into chunks →
 * stored as a DRAFT. GO LIVE copies the draft into an immutable LIVE snapshot.
 * At chat time, the most relevant chunks are retrieved by keyword scoring and
 * passed to the model as quoted reference material.
 *
 * Keyword retrieval (BM25-style) is deliberately chosen over embeddings: it is
 * free, deterministic, needs no extra API, and handles policy/catalog lookups
 * well. Upgrade path: Upstash Vector (also has a free tier).
 *
 * Redis keys
 *   kb:draft:index          hash  docId → DocMeta
 *   kb:draft:doc:{id}       json  string[] (chunks)
 *   kb:draft:settings       json  OrgSettings
 *   kb:draft:changedAt      json  ISO timestamp of last draft edit
 *   kb:draft:testedAt       json  ISO timestamp of last admin test chat
 *   kb:live:version         json  number (0 = offline)
 *   kb:live:snapshot        json  Snapshot
 *   kb:live:counter         json  number (monotonic version counter)
 *   audit                   list  AuditEntry (latest 200)
 */
import { store } from "./store";
import {
  DEFAULT_SETTINGS,
  type AuditEntry,
  type DocMeta,
  type DocScope,
  type ModuleId,
  type OrgSettings,
} from "./types";

export interface SnapshotDoc {
  meta: DocMeta;
  chunks: string[];
}
export interface Snapshot {
  version: number;
  publishedAt: string | null;
  publishedBy: string | null;
  settings: OrgSettings;
  docs: SnapshotDoc[];
}

const K = {
  index: "kb:draft:index",
  doc: (id: string) => `kb:draft:doc:${id}`,
  settings: "kb:draft:settings",
  changedAt: "kb:draft:changedAt",
  testedAt: "kb:draft:testedAt",
  liveVersion: "kb:live:version",
  liveSnapshot: "kb:live:snapshot",
  versionCounter: "kb:live:counter",
  audit: "audit",
};

// ───────────────────────────── text processing ─────────────────────────────

/**
 * Normalise extracted text and neutralise anything that could impersonate our
 * prompt delimiters (basic prompt-injection hygiene for uploaded documents).
 */
export function cleanText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/<\/?\s*(excerpt|system|instructions?|policy_excerpt)[^>]*>/gi, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Split into ~900-char chunks on paragraph/sentence boundaries, with overlap. */
export function chunkText(text: string, size = 900, overlap = 150): string[] {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buf = "";
  let hasNew = false; // does buf contain text beyond the carried-over overlap?
  const flush = () => {
    if (hasNew && buf.trim()) chunks.push(buf.trim());
    buf = buf.length > overlap ? buf.slice(-overlap) : buf;
    hasNew = false;
  };
  for (const para of paras) {
    const pieces = para.length > size ? para.split(/(?<=[.!?;:])\s+/) : [para];
    for (const piece of pieces) {
      // Hard-split pathological pieces with no punctuation.
      for (let i = 0; i < piece.length; i += size - overlap) {
        const part = piece.slice(i, i + size - overlap);
        if (hasNew && buf.length + part.length + 1 > size) flush();
        buf += (buf ? "\n" : "") + part;
        hasNew = true;
      }
    }
  }
  flush();
  return chunks;
}

const STOP = new Set(
  (
    "a an and are as at be but by can could do does for from had has have how i if in into is it its " +
    "me my of on or our please should so than that the their them then there these they this to " +
    "us was we what when where which who why will with would you your about any also get tell " +
    "kya hai hain mera meri mujhe ka ki ke ko se"
  ).split(" "),
);

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => (t.length > 4 ? t.replace(/(ing|ed|es|s)$/, "") : t)); // crude stemming
}

export interface Excerpt {
  title: string;
  text: string;
  score: number;
}

/** BM25-lite retrieval over the snapshot's chunks for one module. */
export function retrieve(snap: Snapshot, query: string, module: ModuleId, k = 4): Excerpt[] {
  const q = [...new Set(tokenize(query))];
  if (!q.length) return [];
  const pool: { title: string; text: string; toks: string[] }[] = [];
  for (const d of snap.docs) {
    if (d.meta.scope !== module && d.meta.scope !== "both") continue;
    for (const c of d.chunks) pool.push({ title: d.meta.title, text: c, toks: tokenize(`${d.meta.title} ${c}`) });
  }
  if (!pool.length) return [];

  const N = pool.length;
  const avgLen = pool.reduce((s, p) => s + p.toks.length, 0) / N;
  const df = new Map<string, number>();
  for (const p of pool) for (const t of new Set(p.toks)) df.set(t, (df.get(t) ?? 0) + 1);

  const k1 = 1.4;
  const b = 0.75;
  const scored = pool.map((p) => {
    const tf = new Map<string, number>();
    for (const t of p.toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * p.toks.length) / avgLen));
    }
    return { title: p.title, text: p.text, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, k);
}

// ───────────────────────────── draft operations ─────────────────────────────

const now = () => new Date().toISOString();

export async function audit(by: string, action: string, detail?: string) {
  const entry: AuditEntry = { at: now(), by, action, detail };
  await store.lpushCapped(K.audit, entry, 200);
}

export async function listAudit(count = 30) {
  return store.lrangeJSON<AuditEntry>(K.audit, count);
}

export async function listDraftDocs(): Promise<DocMeta[]> {
  const idx = await store.hgetallJSON<DocMeta>(K.index);
  return Object.values(idx).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

export async function addDraftDoc(input: {
  title: string;
  scope: DocScope;
  text: string;
  source: DocMeta["source"];
  by: string;
  needsReview?: boolean;
}): Promise<DocMeta> {
  const text = cleanText(input.text);
  const chunks = chunkText(text);
  const meta: DocMeta = {
    id: crypto.randomUUID().slice(0, 12),
    title: input.title.slice(0, 120),
    scope: input.scope,
    chars: text.length,
    chunks: chunks.length,
    source: input.source,
    uploadedAt: now(),
    uploadedBy: input.by,
    ...(input.needsReview ? { needsReview: true } : {}),
  };
  await store.setJSON(K.doc(meta.id), chunks);
  await store.hsetJSON(K.index, meta.id, meta);
  await store.setJSON(K.changedAt, now());
  await audit(input.by, "upload", `${meta.title} (${meta.scope}, ${meta.chunks} chunks)`);
  return meta;
}

export async function deleteDraftDoc(id: string, by: string) {
  const idx = await store.hgetallJSON<DocMeta>(K.index);
  const meta = idx[id];
  if (!meta) return false;
  await store.hdel(K.index, id);
  await store.del(K.doc(id));
  await store.setJSON(K.changedAt, now());
  await audit(by, "delete", meta.title);
  return true;
}

/** Named sign-off for a web-sourced Pulse pack. The reviewer shows up in answers' source label. */
export async function approveDraftDoc(id: string, by: string) {
  const idx = await store.hgetallJSON<DocMeta>(K.index);
  const meta = idx[id];
  if (!meta) return null;
  const at = now();
  const next: DocMeta = {
    ...meta,
    needsReview: false,
    reviewedBy: by,
    reviewedAt: at,
    title: `${meta.title.replace(/ \(reviewed by .*\)$/, "")} (reviewed by ${by}, ${at.slice(0, 10)})`,
  };
  await store.hsetJSON(K.index, id, next);
  await store.setJSON(K.changedAt, at);
  await audit(by, "approve", next.title);
  return next;
}

export async function getDraftSettings(): Promise<OrgSettings> {
  return { ...DEFAULT_SETTINGS, ...((await store.getJSON<Partial<OrgSettings>>(K.settings)) ?? {}) };
}

export async function saveDraftSettings(patch: Partial<OrgSettings>, by: string) {
  const current = await getDraftSettings();
  const next: OrgSettings = { ...current };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof OrgSettings)[]) {
    const v = patch[key];
    if (typeof v === "string") next[key] = v.trim().slice(0, 300);
  }
  await store.setJSON(K.settings, next);
  await store.setJSON(K.changedAt, now());
  await audit(by, "settings", "Updated organisation settings");
  return next;
}

export async function markTested() {
  await store.setJSON(K.testedAt, now());
}

export async function draftStatus() {
  const [changedAt, testedAt, version, snap] = await Promise.all([
    store.getJSON<string>(K.changedAt),
    store.getJSON<string>(K.testedAt),
    store.getJSON<number>(K.liveVersion),
    getLiveSnapshot(),
  ]);
  return {
    changedAt,
    testedAt,
    testedSinceChange: Boolean(testedAt && (!changedAt || testedAt >= changedAt)),
    liveVersion: version ?? 0,
    publishedAt: snap?.publishedAt ?? null,
    publishedBy: snap?.publishedBy ?? null,
  };
}

/** Build a snapshot from the current draft (used for GO LIVE and admin test mode). */
export async function buildDraftSnapshot(): Promise<Snapshot> {
  const [metas, settings] = await Promise.all([listDraftDocs(), getDraftSettings()]);
  const docs = await Promise.all(
    metas.map(async (meta) => ({ meta, chunks: (await store.getJSON<string[]>(K.doc(meta.id))) ?? [] })),
  );
  return { version: 0, publishedAt: null, publishedBy: null, settings, docs };
}

// ───────────────────────────── live operations ─────────────────────────────

// Per-instance cache so each chat request costs ~1 Redis read, not a full download.
let liveCache: Snapshot | null = null;

export async function getLiveVersion(): Promise<number> {
  return (await store.getJSON<number>(K.liveVersion)) ?? 0;
}

export async function getLiveSnapshot(): Promise<Snapshot | null> {
  const version = await getLiveVersion();
  if (!version) return null;
  if (liveCache?.version === version) return liveCache;
  const snap = await store.getJSON<Snapshot>(K.liveSnapshot);
  if (snap && snap.version === version) liveCache = snap;
  return snap;
}

/** GO LIVE: freeze the draft into a new live version. */
export async function publish(by: string): Promise<Snapshot> {
  const draft = await buildDraftSnapshot();
  const version = ((await store.getJSON<number>(K.versionCounter)) ?? 0) + 1;
  const snap: Snapshot = { ...draft, version, publishedAt: now(), publishedBy: by };
  await store.setJSON(K.liveSnapshot, snap);
  await store.setJSON(K.versionCounter, version);
  await store.setJSON(K.liveVersion, version); // flip the pointer last
  liveCache = snap;
  await audit(by, "go-live", `Published v${version} (${snap.docs.length} documents)`);
  return snap;
}

/** Kill switch: take the assistant offline without deleting anything. */
export async function takeOffline(by: string) {
  await store.setJSON(K.liveVersion, 0);
  liveCache = null;
  await audit(by, "offline", "Assistant taken offline");
}
