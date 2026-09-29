"use client";
/**
 * components/TrainingPanel.tsx — the team training panel (admin drawer).
 *
 * Tabs:
 *   Knowledge → upload PDFs/text or paste content, scoped to L&D, Grievance or both
 *   Settings  → assistant name, IC (POSH) contacts, official grievance channel, booking link
 *   Launch    → Test Mode, pre-flight checklist, GO LIVE, kill switch, audit log
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Globe,
  RefreshCw,
  FileText,
  FlaskConical,
  LogOut,
  Power,
  Rocket,
  Settings2,
  ShieldAlert,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { DEFAULT_SETTINGS, type AuditEntry, type DocMeta, type DocScope, type OrgSettings } from "@/lib/types";

interface TrainState {
  admin: string;
  docs: DocMeta[];
  settings: OrgSettings;
  status: {
    changedAt: string | null;
    testedAt: string | null;
    testedSinceChange: boolean;
    liveVersion: number;
    publishedAt: string | null;
    publishedBy: string | null;
  };
  audit: AuditEntry[];
  storePersistent: boolean;
  webSearch: boolean;
  pulse: { at: string; ok: boolean; detail: string; docs: string[] } | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  admin: string | null;
  onAdminChange: (name: string | null) => void;
  testMode: boolean;
  onTestModeChange: (on: boolean) => void;
  /** Called after GO LIVE / offline / settings changes so the dashboard refreshes status. */
  onStatusChange: () => void;
}

type Tab = "knowledge" | "settings" | "launch";

const SCOPES: { id: DocScope; label: string }[] = [
  { id: "both", label: "Both modules" },
  { id: "ld", label: "L&D only" },
  { id: "hr", label: "Grievance / HR only" },
];

const SETTING_FIELDS: { key: keyof OrgSettings; label: string; placeholder: string; hint?: string }[] = [
  { key: "assistantName", label: "Assistant name", placeholder: "AEGIS / JARVIS / FRIDAY" },
  { key: "orgName", label: "Organisation name", placeholder: "Acme India Pvt Ltd" },
  { key: "icName", label: "Internal Committee name", placeholder: "Internal Committee (POSH)" },
  { key: "icEmail", label: "IC email", placeholder: "ic@company.com", hint: "Shown on every harassment-related message." },
  { key: "icPhone", label: "IC phone", placeholder: "+91 …" },
  {
    key: "grievanceChannelUrl",
    label: "Official grievance channel URL",
    placeholder: "https://hrms.company.com/grievance",
    hint: "Your HRMS ticket form or grievance mailbox link — where real complaints are filed.",
  },
  { key: "hrEmail", label: "HR contact email", placeholder: "hr@company.com" },
  { key: "coachingBookingUrl", label: "Coaching booking link", placeholder: "https://cal.com/ld-team" },
];

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

export default function TrainingPanel({
  open,
  onClose,
  admin,
  onAdminChange,
  testMode,
  onTestModeChange,
  onStatusChange,
}: Props) {
  const [tab, setTab] = useState<Tab>("knowledge");
  const [data, setData] = useState<TrainState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string; list?: string[] } | null>(null);

  // login
  const [name, setName] = useState("");
  const [passcode, setPasscode] = useState("");

  // upload
  const [scope, setScope] = useState<DocScope>("both");
  const [title, setTitle] = useState("");
  const [pasted, setPasted] = useState("");
  const [file, setFile] = useState<File | null>(null);

  // settings form
  const [form, setForm] = useState<OrgSettings>(DEFAULT_SETTINGS);

  const load = useCallback(async () => {
    const r = await fetch("/api/train", { cache: "no-store" });
    if (r.status === 401) {
      onAdminChange(null);
      setData(null);
      return;
    }
    const j = await r.json();
    if (!r.ok) {
      setMsg({ kind: "err", text: j.error ?? "Could not load training data." });
      return;
    }
    setData(j);
    setForm(j.settings);
  }, [onAdminChange]);

  useEffect(() => {
    if (open && admin) void load();
  }, [open, admin, load]);

  const call = async (fn: () => Promise<Response>, okText: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      const j = await r.json().catch(() => ({}));
      if (!r.ok) setMsg({ kind: "err", text: j.error ?? "Something went wrong.", list: j.problems });
      else {
        setMsg({ kind: "ok", text: okText });
        await load();
        onStatusChange();
      }
      return r.ok;
    } finally {
      setBusy(false);
    }
  };

  const login = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const r = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, passcode }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return setMsg({ kind: "err", text: j.error ?? "Sign-in failed." });
    setPasscode("");
    onAdminChange(j.admin);
  };

  const logout = async () => {
    await fetch("/api/auth", { method: "DELETE" });
    onTestModeChange(false);
    onAdminChange(null);
    setData(null);
  };

  const upload = async () => {
    if (file) {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("scope", scope);
      if (title.trim()) fd.append("title", title.trim());
      const ok = await call(() => fetch("/api/train", { method: "POST", body: fd }), `Added “${title || file.name}”.`);
      if (ok) {
        setFile(null);
        setTitle("");
      }
    } else {
      const ok = await call(
        () =>
          fetch("/api/train", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "text", title, scope, text: pasted }),
          }),
        `Added “${title}”.`,
      );
      if (ok) {
        setPasted("");
        setTitle("");
      }
    }
  };

  const goLive = (force = false) =>
    call(
      () =>
        fetch("/api/train", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force }),
        }),
      "You're live. Employees now see the published version.",
    );

  const tabs: { id: Tab; label: string; icon: typeof BookOpen }[] = [
    { id: "knowledge", label: "Knowledge", icon: BookOpen },
    { id: "settings", label: "Settings", icon: Settings2 },
    { id: "launch", label: "Launch", icon: Rocket },
  ];

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.aside
            role="dialog"
            aria-label="Team training panel"
            className="glass thin-scroll fixed right-0 top-0 z-50 flex h-full w-full max-w-xl flex-col overflow-y-auto rounded-none p-5 sm:rounded-l-2xl"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 260, damping: 30 }}
          >
            <header className="mb-4 flex items-center justify-between">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-white/50">Team only</p>
                <h2 className="font-display text-xl font-bold tracking-wider accent glow-text">TRAINING PANEL</h2>
              </div>
              <div className="flex items-center gap-2">
                {admin && (
                  <button onClick={logout} className="rounded-lg p-2 text-white/60 hover:bg-white/5 hover:text-white" title="Sign out">
                    <LogOut className="h-4 w-4" />
                  </button>
                )}
                <button onClick={onClose} className="rounded-lg p-2 text-white/60 hover:bg-white/5 hover:text-white" aria-label="Close">
                  <X className="h-5 w-5" />
                </button>
              </div>
            </header>

            {msg && (
              <div
                className={`mb-4 rounded-xl border px-3 py-2 text-sm ${
                  msg.kind === "ok" ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200" : "border-rose-400/30 bg-rose-400/10 text-rose-200"
                }`}
              >
                {msg.text}
                {msg.list && (
                  <ul className="mt-1 list-disc pl-5">
                    {msg.list.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {!admin ? (
              <form onSubmit={login} className="space-y-3">
                <p className="text-sm text-white/70">
                  Sign in to upload policies and course catalogs, test the assistant, and publish it to employees.
                </p>
                <input
                  className="input-hud w-full px-3 py-2 text-sm"
                  placeholder="Your name (recorded in the audit log)"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                />
                <input
                  className="input-hud w-full px-3 py-2 text-sm"
                  placeholder="Team passcode"
                  type="password"
                  value={passcode}
                  onChange={(e) => setPasscode(e.target.value)}
                  autoComplete="current-password"
                />
                <button disabled={busy} className="btn-accent w-full rounded-xl py-2 font-display text-sm font-bold tracking-widest">
                  {busy ? "VERIFYING…" : "AUTHENTICATE"}
                </button>
              </form>
            ) : (
              <>
                {data && !data.storePersistent && (
                  <div className="mb-4 flex gap-2 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-xs text-amber-100">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    Storage is in-memory. Uploads will be lost on redeploy and won't be shared between servers. Connect Upstash
                    Redis (Vercel → Storage → Marketplace) before going live.
                  </div>
                )}

                <nav className="mb-4 grid grid-cols-3 gap-1 rounded-xl bg-black/30 p-1">
                  {tabs.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setTab(t.id)}
                      className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold tracking-wide transition ${
                        tab === t.id ? "bg-[rgba(var(--accent-rgb),0.18)] accent" : "text-white/60 hover:text-white"
                      }`}
                    >
                      <t.icon className="h-3.5 w-3.5" />
                      {t.label}
                    </button>
                  ))}
                </nav>

                {tab === "knowledge" && (
                  <section className="space-y-4">
                    <div className="space-y-2 rounded-xl border border-white/10 p-3">
                      <div className="flex items-center justify-between">
                        <p className="flex items-center gap-2 text-sm font-semibold">
                          <Globe className="h-4 w-4 accent" /> Regulatory & Skills Pulse
                        </p>
                        <span className={`font-mono text-[10px] ${data?.webSearch ? "text-emerald-300" : "text-white/40"}`}>
                          LIVE WEB: {data?.webSearch ? "ON" : "OFF"}
                        </span>
                      </div>
                      <p className="text-[11px] leading-relaxed text-white/55">
                        Searches fixed topics (Labour Codes, DPDP, POSH, certification fees, in-demand skills) — never employee
                        messages. Results arrive here as drafts that you must approve before GO LIVE. Runs daily automatically.
                      </p>
                      {data?.pulse && (
                        <p className={`text-[11px] ${data.pulse.ok ? "text-emerald-200/80" : "text-amber-200/90"}`}>
                          Last run {fmt(data.pulse.at)} — {data.pulse.detail}
                        </p>
                      )}
                      <button
                        disabled={busy || !data?.webSearch}
                        onClick={() =>
                          call(
                            () =>
                              fetch("/api/train", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ action: "pulse" }),
                              }),
                            "Pulse complete — review the new draft updates below.",
                          )
                        }
                        className="flex w-full items-center justify-center gap-2 rounded-xl border border-[rgba(var(--accent-rgb),0.35)] py-2 text-xs font-semibold hover:bg-white/5 disabled:opacity-40"
                      >
                        <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
                        {data?.webSearch ? "Run Pulse now" : "Add TAVILY_API_KEY to enable"}
                      </button>
                    </div>

                    <div className="space-y-3 rounded-xl border border-white/10 p-3">
                      <div className="flex flex-wrap gap-2">
                        {SCOPES.map((s) => (
                          <button
                            key={s.id}
                            onClick={() => setScope(s.id)}
                            className={`rounded-full border px-3 py-1 text-xs ${
                              scope === s.id ? "border-[var(--accent)] accent" : "border-white/15 text-white/60"
                            }`}
                          >
                            {s.label}
                          </button>
                        ))}
                      </div>
                      <input
                        className="input-hud w-full px-3 py-2 text-sm"
                        placeholder="Title (e.g. Leave Policy 2026, Q3 Course Catalog)"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                      />
                      <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-[rgba(var(--accent-rgb),0.35)] px-3 py-4 text-sm text-white/70 hover:bg-white/5">
                        <Upload className="h-5 w-5 accent" />
                        <span className="truncate">{file ? file.name : "Choose a PDF, TXT, MD, CSV or JSON (max 4 MB)"}</span>
                        <input
                          type="file"
                          accept=".pdf,.txt,.md,.markdown,.csv,.json,application/pdf,text/*"
                          className="hidden"
                          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                        />
                      </label>
                      {!file && (
                        <textarea
                          className="input-hud thin-scroll h-28 w-full resize-y px-3 py-2 text-sm"
                          placeholder="…or paste handbook / policy / catalog text here"
                          value={pasted}
                          onChange={(e) => setPasted(e.target.value)}
                        />
                      )}
                      <button
                        onClick={upload}
                        disabled={busy || (!file && (!pasted.trim() || !title.trim()))}
                        className="btn-accent w-full rounded-xl py-2 text-sm font-bold tracking-wider disabled:opacity-40"
                      >
                        {busy ? "Processing…" : "Add to draft knowledge"}
                      </button>
                      <p className="text-[11px] leading-relaxed text-white/45">
                        Scanned PDFs have no readable text — OCR them first. Content is treated as reference data; the assistant
                        ignores any instructions written inside documents.
                      </p>
                    </div>

                    <div>
                      <h3 className="mb-2 font-mono text-[11px] uppercase tracking-[0.25em] text-white/50">
                        Draft documents ({data?.docs.length ?? 0})
                      </h3>
                      <ul className="space-y-2">
                        {data?.docs.map((d) => (
                          <li key={d.id} className="flex items-center gap-3 rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                            <FileText className="h-4 w-4 shrink-0 accent" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm">{d.title}</p>
                              <p className="text-[11px] text-white/45">
                                {d.scope === "both" ? "Both" : d.scope === "ld" ? "L&D" : "Grievance"} · {d.chunks} chunks ·{" "}
                                {d.uploadedBy}
                                {d.source === "web" && !d.needsReview && " · web-sourced"}
                              </p>
                              {d.needsReview && (
                                <p className="mt-0.5 text-[11px] text-amber-200">Web-sourced · needs your review before GO LIVE</p>
                              )}
                            </div>
                            {d.needsReview && (
                              <button
                                onClick={() =>
                                  confirm(
                                    `Approve “${d.title}”? Your name will be shown to employees as the reviewer. Open the linked sources to verify before approving.`,
                                  ) &&
                                  call(
                                    () =>
                                      fetch("/api/train", {
                                        method: "POST",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({ action: "approve", id: d.id }),
                                      }),
                                    "Approved.",
                                  )
                                }
                                className="rounded-lg border border-emerald-400/40 px-2 py-1 text-[11px] text-emerald-200 hover:bg-emerald-400/10"
                              >
                                Approve
                              </button>
                            )}
                            <button
                              onClick={() =>
                                confirm(`Remove “${d.title}” from the draft?`) &&
                                call(() => fetch(`/api/train?id=${d.id}`, { method: "DELETE" }), "Removed.")
                              }
                              className="rounded-lg p-1.5 text-white/40 hover:bg-rose-500/10 hover:text-rose-300"
                              aria-label={`Remove ${d.title}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </li>
                        ))}
                        {data && !data.docs.length && <li className="text-sm text-white/50">Nothing uploaded yet.</li>}
                      </ul>
                    </div>
                  </section>
                )}

                {tab === "settings" && (
                  <section className="space-y-3">
                    {SETTING_FIELDS.map((f) => (
                      <label key={f.key} className="block">
                        <span className="mb-1 block text-xs font-semibold text-white/70">{f.label}</span>
                        <input
                          className="input-hud w-full px-3 py-2 text-sm"
                          placeholder={f.placeholder}
                          value={form[f.key]}
                          onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                        />
                        {f.hint && <span className="mt-1 block text-[11px] text-white/45">{f.hint}</span>}
                      </label>
                    ))}
                    <button
                      disabled={busy}
                      onClick={() =>
                        call(
                          () =>
                            fetch("/api/train", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ action: "settings", settings: form }),
                            }),
                          "Settings saved to draft. They reach employees at the next GO LIVE.",
                        )
                      }
                      className="btn-accent w-full rounded-xl py-2 text-sm font-bold tracking-wider"
                    >
                      Save settings
                    </button>
                  </section>
                )}

                {tab === "launch" && data && (
                  <section className="space-y-4">
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <Stat label="Live version" value={data.status.liveVersion ? `v${data.status.liveVersion}` : "Offline"} />
                      <Stat label="Published" value={fmt(data.status.publishedAt)} />
                      <Stat label="Draft changed" value={fmt(data.status.changedAt)} />
                      <Stat label="Last test chat" value={fmt(data.status.testedAt)} />
                    </div>

                    <button
                      onClick={() => {
                        onTestModeChange(!testMode);
                        if (!testMode) onClose();
                      }}
                      className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left text-sm ${
                        testMode ? "border-amber-400/50 bg-amber-400/10" : "border-white/10 hover:bg-white/5"
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <FlaskConical className="h-4 w-4 text-amber-300" />
                        <span>
                          <b>Test Mode</b> — chat against the draft before publishing
                        </span>
                      </span>
                      <span className="font-mono text-xs">{testMode ? "ON" : "OFF"}</span>
                    </button>

                    <ul className="space-y-1.5 text-sm">
                      <Check ok={data.docs.length > 0} text="At least one document uploaded" />
                      <Check
                        ok={Boolean(data.settings.icEmail || data.settings.icPhone || data.settings.grievanceChannelUrl)}
                        text="IC / official grievance contact configured"
                      />
                      <Check ok={!data.docs.some((d) => d.needsReview)} text="Web-sourced updates reviewed" />
                      <Check ok={data.status.testedSinceChange} text="Tested since the last change" />
                      <Check ok={data.storePersistent} text="Persistent storage connected" />
                    </ul>

                    {/* The master GO LIVE button */}
                    <motion.button
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.97 }}
                      disabled={busy}
                      onClick={() => goLive(false)}
                      className="relative w-full overflow-hidden rounded-2xl py-5 font-display text-2xl font-black tracking-[0.35em] text-[#02101c] disabled:opacity-50"
                      style={{
                        background: "linear-gradient(135deg, #5cffc8, var(--accent), var(--accent-2))",
                        boxShadow: "0 0 60px -10px var(--accent), inset 0 0 20px rgba(255,255,255,0.35)",
                      }}
                    >
                      <motion.span
                        className="absolute inset-0 bg-[linear-gradient(110deg,transparent_30%,rgba(255,255,255,0.55)_50%,transparent_70%)]"
                        animate={{ x: ["-120%", "120%"] }}
                        transition={{ repeat: Infinity, duration: 2.6, ease: "easeInOut" }}
                      />
                      <span className="relative flex items-center justify-center gap-3">
                        <Rocket className="h-6 w-6" /> GO LIVE
                      </span>
                    </motion.button>
                    <p className="text-center text-[11px] text-white/45">
                      Publishes the current draft as a new version. Employees never see drafts.
                    </p>

                    {data.status.liveVersion > 0 && (
                      <button
                        onClick={() =>
                          confirm("Take the assistant offline for everyone?") &&
                          call(() => fetch("/api/train?action=offline", { method: "DELETE" }), "Assistant is now offline.")
                        }
                        className="flex w-full items-center justify-center gap-2 rounded-xl border border-rose-400/30 py-2 text-sm text-rose-200 hover:bg-rose-500/10"
                      >
                        <Power className="h-4 w-4" /> Take offline (kill switch)
                      </button>
                    )}

                    <div className="flex gap-2 rounded-xl border border-white/10 bg-black/20 p-3 text-[11px] leading-relaxed text-white/55">
                      <ShieldAlert className="h-4 w-4 shrink-0 text-amber-300" />
                      This assistant routes grievances and stores no complaint text. Before switching off the Pilot banner, get
                      sign-off from Legal/IT on data flows (browser speech services, LLM provider) under the DPDP Act and POSH Act.
                    </div>

                    <div>
                      <h3 className="mb-2 font-mono text-[11px] uppercase tracking-[0.25em] text-white/50">Audit log</h3>
                      <ul className="thin-scroll max-h-48 space-y-1 overflow-y-auto font-mono text-[11px] text-white/55">
                        {data.audit.map((a, i) => (
                          <li key={i}>
                            <span className="text-white/35">{new Date(a.at).toLocaleString()}</span> · {a.by} · {a.action}
                            {a.detail ? ` — ${a.detail}` : ""}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </section>
                )}
              </>
            )}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-2.5">
      <p className="text-white/45">{label}</p>
      <p className="mt-0.5 truncate font-mono text-white/85">{value}</p>
    </div>
  );
}

function Check({ ok, text }: { ok: boolean; text: string }) {
  return (
    <li className={`flex items-center gap-2 ${ok ? "text-emerald-200" : "text-white/50"}`}>
      {ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4 text-amber-300" />}
      {text}
    </li>
  );
}
