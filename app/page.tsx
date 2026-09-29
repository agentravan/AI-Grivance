"use client";
/**
 * app/page.tsx — the cinematic dashboard.
 *
 * Layout (desktop):   [ module side panel ] [ holographic core ] [ conversation ]
 * Layout (mobile):    core → conversation → side panel (stacked)
 *
 * Modules:
 *   L&D        — voice-first coach. Recommendations, stipend/cert rules, coaching
 *                booking link, and a personal "My Path" tracker kept on-device.
 *   Grievance  — text-only navigator. Explains policy and process, hands off to
 *                the Internal Committee / official channel. Stores nothing.
 *
 * Each module has its own conversation thread so grievance context never
 * leaks into L&D prompts (and vice versa). Threads live only in this tab.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  BookOpenCheck,
  CalendarClock,
  CheckCircle2,
  Circle,
  CircleDot,
  ExternalLink,
  EyeOff,
  FlaskConical,
  Globe,
  GraduationCap,
  HeartHandshake,
  Languages,
  LogOut,
  Mail,
  Phone,
  Plus,
  Scale,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserCog,
  Volume2,
  VolumeX,
} from "lucide-react";
import HoloCore from "@/components/HoloCore";
import TrainingPanel from "@/components/TrainingPanel";
import { useVoiceAgent, type VoiceLang } from "@/hooks/useVoiceAgent";
import type { ChatRoute, ModuleId, PublicStatus, WebSource } from "@/lib/types";

// ───────────────────────────── types & helpers ─────────────────────────────

interface Msg {
  id: string;
  role: "user" | "assistant";
  content: string;
  route?: ChatRoute;
  sources?: string[];
  web?: WebSource[];
}

interface PathItem {
  id: string;
  title: string;
  status: "planned" | "active" | "done";
}

const uid = () => Math.random().toString(36).slice(2, 10);

const QUICK: Record<ModuleId, string[]> = {
  ld: [
    "Recommend a learning path for my role",
    "What certifications does the company sponsor?",
    "How much is the learning stipend?",
    "I want to book a coaching session",
  ],
  hr: [
    "How do I raise a grievance?",
    "How does the POSH process work?",
    "Is what I report kept confidential?",
    "What protects me from retaliation?",
  ],
};

const STATE_LABEL = {
  idle: "STANDBY",
  listening: "LISTENING",
  thinking: "PROCESSING",
  speaking: "RESPONDING",
} as const;

const LANGS: { id: VoiceLang; label: string }[] = [
  { id: "en-IN", label: "English (India)" },
  { id: "hi-IN", label: "हिन्दी" },
  { id: "en-US", label: "English (US)" },
];

/** Browser storage for per-device conveniences only — always wrapped. */
const local = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(key);
      return v ? (JSON.parse(v) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode etc. */
    }
  },
};

// ───────────────────────────── page ─────────────────────────────

export default function Dashboard() {
  const [module, setModule] = useState<ModuleId>("ld");
  const [threads, setThreads] = useState<Record<ModuleId, Msg[]>>({ ld: [], hr: [] });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<PublicStatus | null>(null);
  const [admin, setAdmin] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const [lang, setLang] = useState<VoiceLang>("en-IN");
  const [muted, setMuted] = useState(false);
  const [consentAsk, setConsentAsk] = useState(false);
  const [path, setPath] = useState<PathItem[]>([]);
  const [newGoal, setNewGoal] = useState("");
  const [coreSize, setCoreSize] = useState(340);

  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const moduleRef = useRef(module);
  moduleRef.current = module;
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const sendRef = useRef<(text: string, viaVoice?: boolean) => void>(() => {});
  const scrollRef = useRef<HTMLDivElement>(null);

  const settings = status?.settings;
  const name = settings?.assistantName || "AEGIS";
  const isHR = module === "hr";
  // Grievance voice can be switched off per client in Training Panel → Settings.
  const grievanceVoiceOff = settings?.grievanceVoice === "off";
  const voiceLocked = isHR && grievanceVoiceOff;

  // ── voice agent ──
  const onUserUtterance = useCallback((text: string) => sendRef.current(text, true), []);
  const voice = useVoiceAgent({ lang, onUserUtterance, speakReplies: !muted });

  // ── bootstrapping ──
  const refreshStatus = useCallback(async () => {
    try {
      const r = await fetch(`/api/chat${testMode ? "?stage=draft" : ""}`, { cache: "no-store" });
      if (r.ok) setStatus(await r.json());
    } catch {
      /* offline */
    }
  }, [testMode]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    fetch("/api/auth", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setAdmin(j.admin ?? null))
      .catch(() => {});
    setPath(local.get<PathItem[]>("aegis.path", []));
    setLang(local.get<VoiceLang>("aegis.lang", "en-IN"));
    const fit = () => setCoreSize(window.innerWidth < 420 ? 270 : 340);
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  useEffect(() => local.set("aegis.path", path), [path]);
  useEffect(() => local.set("aegis.lang", lang), [lang]);

  // If grievance voice is switched off, end any call when entering that module.
  useEffect(() => {
    if (voiceLocked && voice.callActive) voice.endCall();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceLocked]);

  // Auto-scroll the conversation.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [threads, module]);

  // ── chat ──
  const send = useCallback(
    async (text: string, viaVoice = false) => {
      const mod = moduleRef.current;
      const trimmed = text.trim();
      if (!trimmed || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setInput("");

      const userMsg: Msg = { id: uid(), role: "user", content: trimmed };
      const history = [...threadsRef.current[mod], userMsg];
      const asstId = uid();
      setThreads((t) => ({ ...t, [mod]: [...history, { id: asstId, role: "assistant", content: "" }] }));

      const patch = (p: Partial<Msg>) =>
        setThreads((t) => ({ ...t, [mod]: t[mod].map((m) => (m.id === asstId ? { ...m, ...p } : m)) }));

      const speakIt = !(mod === "hr" && grievanceVoiceOff) && (viaVoice || voice.callActive);
      if (speakIt) voice.beginResponse();

      abortRef.current = new AbortController();
      let acc = "";
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            module: mod,
            stage: testMode ? "draft" : "live",
            messages: history.map(({ role, content }) => ({ role, content })),
          }),
          signal: abortRef.current.signal,
        });

        if ((res.headers.get("content-type") ?? "").includes("application/json")) {
          const j = await res.json().catch(() => ({}));
          acc = j.error ?? "Something went wrong.";
          patch({ content: acc, route: "offline" });
        } else {
          const route = (res.headers.get("x-aegis-route") as ChatRoute) ?? "llm";
          let sources: string[] = [];
          try {
            sources = JSON.parse(decodeURIComponent(res.headers.get("x-aegis-sources") ?? "%5B%5D"));
          } catch {
            /* ignore */
          }
          let web: WebSource[] = [];
          try {
            web = JSON.parse(decodeURIComponent(res.headers.get("x-aegis-web") ?? "%5B%5D"));
          } catch {
            /* ignore */
          }
          patch({ route, sources, web });

          const reader = res.body?.getReader();
          const decoder = new TextDecoder();
          while (reader) {
            const { done, value } = await reader.read();
            if (done) break;
            const delta = decoder.decode(value, { stream: true });
            acc += delta;
            patch({ content: acc });
            if (speakIt) voice.pushResponseText(delta);
          }
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          acc = "I lost the connection. Please try again.";
          patch({ content: acc, route: "offline" });
        }
      } finally {
        busyRef.current = false;
        setBusy(false);
        if (speakIt) voice.endResponse();
      }
    },
    [testMode, voice, grievanceVoiceOff],
  );
  sendRef.current = send;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };

  // ── core button behaviour ──
  const onCorePress = () => {
    if (voiceLocked) return;
    if (!voice.supported.stt) {
      voice.clearError();
      alert("Voice input needs Chrome, Edge or Safari. You can still type below.");
      return;
    }
    if (voice.state === "speaking") return voice.interrupt();
    if (voice.callActive) return voice.endCall();
    if (!local.get<boolean>("aegis.voiceConsent", false)) return setConsentAsk(true);
    void voice.startCall();
  };

  const acceptConsent = () => {
    local.set("aegis.voiceConsent", true);
    setConsentAsk(false);
    void voice.startCall();
  };

  const quickExit = () => {
    abortRef.current?.abort();
    setThreads((t) => ({ ...t, hr: [] }));
    setModule("ld");
  };

  const clearThread = () => {
    abortRef.current?.abort();
    voice.interrupt();
    setThreads((t) => ({ ...t, [module]: [] }));
  };

  const messages = threads[module];
  const pathDone = useMemo(() => path.filter((p) => p.status === "done").length, [path]);

  return (
    <div data-module={module} className="hud-bg scanlines min-h-dvh">
      {/* ── Banners ── */}
      {status?.pilot && (
        <div className="flex items-center justify-center gap-2 bg-amber-400/10 px-4 py-1.5 text-center text-[11px] text-amber-100 sm:text-xs">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          Pilot — not an official grievance or filing channel. Nothing you type is stored.
        </div>
      )}
      {testMode && (
        <div className="flex items-center justify-center gap-2 bg-fuchsia-500/15 px-4 py-1.5 text-xs text-fuchsia-100">
          <FlaskConical className="h-3.5 w-3.5" /> TEST MODE — answering from the unpublished draft
          <button onClick={() => setTestMode(false)} className="ml-2 underline underline-offset-2">
            exit
          </button>
        </div>
      )}

      <div className="mx-auto flex max-w-[1500px] flex-col gap-5 px-4 py-5 lg:px-8">
        {/* ── Header ── */}
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="relative h-10 w-10">
              <span className="absolute inset-0 animate-ping rounded-full bg-[rgba(var(--accent-rgb),0.25)]" />
              <span className="absolute inset-1.5 rounded-full border-2 border-[var(--accent)] shadow-[0_0_18px_var(--accent)]" />
            </div>
            <div>
              <KineticTitle text={name} />
              <p className="font-mono text-[10px] uppercase tracking-[0.35em] text-white/45">
                {settings?.orgName ?? "People"} · Learning & People Assistant
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <StatusChip status={status} testMode={testMode} />
            <button
              onClick={() => setPanelOpen(true)}
              className="glass flex items-center gap-2 !rounded-xl px-3 py-2 text-xs font-semibold tracking-wide hover:brightness-125"
            >
              <UserCog className="h-4 w-4 accent" />
              <span className="hidden sm:inline">{admin ? `Team · ${admin}` : "Team Training"}</span>
            </button>
          </div>
        </header>

        {/* ── Module toggle ── */}
        <div className="mx-auto grid w-full max-w-md grid-cols-2 gap-1 rounded-2xl border border-white/10 bg-black/40 p-1 backdrop-blur">
          {(
            [
              { id: "ld", label: "Learning & Growth", icon: GraduationCap },
              { id: "hr", label: "Grievance & Policy", icon: Scale },
            ] as const
          ).map((m) => (
            <button
              key={m.id}
              onClick={() => setModule(m.id)}
              className="relative flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold"
              aria-pressed={module === m.id}
            >
              {module === m.id && (
                <motion.span
                  layoutId="module-pill"
                  className="absolute inset-0 rounded-xl bg-[rgba(var(--accent-rgb),0.16)] shadow-[0_0_24px_-6px_var(--accent)]"
                  transition={{ type: "spring", stiffness: 380, damping: 32 }}
                />
              )}
              <m.icon className={`relative h-4 w-4 ${module === m.id ? "accent" : "text-white/50"}`} />
              <span className={`relative ${module === m.id ? "text-white" : "text-white/55"}`}>{m.label}</span>
            </button>
          ))}
        </div>

        {/* ── Main grid ── */}
        <main className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)_minmax(0,1.15fr)]">
          {/* Side panel */}
          <aside className="order-3 space-y-4 lg:order-1">
            <AnimatePresence mode="wait">
              {isHR ? (
                <motion.div key="hr-side" {...fade} className="space-y-4">
                  <Panel title="How this works" icon={ShieldCheck}>
                    <ul className="space-y-2.5 text-[13px] leading-relaxed text-white/75">
                      <Li icon={EyeOff}>Nothing you type is saved. Closing this tab erases the conversation.</Li>
                      <Li icon={Scale}>This is a guide, not a filing. Formal complaints go through the official channel below.</Li>
                      {grievanceVoiceOff ? (
                        <Li icon={VolumeX}>Voice is switched off here so nothing is read aloud or sent to a speech service.</Li>
                      ) : (
                        <Li icon={VolumeX}>
                          Voice works here too. Your browser's speech service processes the audio, so avoid names and personal
                          details, and use headphones in shared spaces.
                        </Li>
                      )}
                      <Li icon={ShieldCheck}>Emails, phone numbers and ID numbers are removed before any AI processing.</Li>
                    </ul>
                  </Panel>

                  <Panel title={settings?.icName || "Internal Committee"} icon={HeartHandshake}>
                    <p className="mb-3 text-[13px] text-white/70">
                      For sexual harassment concerns under the POSH Act, contact the Committee directly — in confidence.
                    </p>
                    <div className="space-y-2 text-sm">
                      {settings?.icEmail && (
                        <a href={`mailto:${settings.icEmail}`} className="flex items-center gap-2 accent hover:underline">
                          <Mail className="h-4 w-4" /> {settings.icEmail}
                        </a>
                      )}
                      {settings?.icPhone && (
                        <a href={`tel:${settings.icPhone}`} className="flex items-center gap-2 accent hover:underline">
                          <Phone className="h-4 w-4" /> {settings.icPhone}
                        </a>
                      )}
                      {settings?.grievanceChannelUrl && (
                        <a
                          href={settings.grievanceChannelUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="btn-accent mt-2 flex items-center justify-center gap-2 rounded-xl py-2 text-sm font-bold"
                        >
                          Open official grievance channel <ExternalLink className="h-4 w-4" />
                        </a>
                      )}
                      {!settings?.icEmail && !settings?.icPhone && !settings?.grievanceChannelUrl && (
                        <p className="text-xs text-amber-200/80">Contact details haven't been published yet — please reach HR directly.</p>
                      )}
                    </div>
                  </Panel>

                  <button
                    onClick={quickExit}
                    className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 py-2.5 text-sm text-white/70 hover:bg-white/5"
                  >
                    <LogOut className="h-4 w-4" /> Quick exit — clear & switch to Learning
                  </button>
                </motion.div>
              ) : (
                <motion.div key="ld-side" {...fade} className="space-y-4">
                  <Panel title="My Path" icon={BookOpenCheck} aside={path.length ? `${pathDone}/${path.length}` : undefined}>
                    {path.length > 0 && (
                      <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-white/10">
                        <motion.div
                          className="h-full rounded-full"
                          style={{ background: "linear-gradient(90deg, var(--accent-2), var(--accent))" }}
                          animate={{ width: `${(pathDone / path.length) * 100}%` }}
                        />
                      </div>
                    )}
                    <ul className="thin-scroll max-h-56 space-y-1.5 overflow-y-auto">
                      {path.map((p) => (
                        <li key={p.id} className="group flex items-center gap-2 text-[13px]">
                          <button
                            onClick={() =>
                              setPath((all) =>
                                all.map((x) =>
                                  x.id === p.id
                                    ? { ...x, status: x.status === "planned" ? "active" : x.status === "active" ? "done" : "planned" }
                                    : x,
                                ),
                              )
                            }
                            title="Cycle: planned → in progress → done"
                            className="shrink-0"
                          >
                            {p.status === "done" ? (
                              <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                            ) : p.status === "active" ? (
                              <CircleDot className="h-4 w-4 accent" />
                            ) : (
                              <Circle className="h-4 w-4 text-white/40" />
                            )}
                          </button>
                          <span className={`flex-1 ${p.status === "done" ? "text-white/40 line-through" : "text-white/80"}`}>
                            {p.title}
                          </span>
                          <button
                            onClick={() => setPath((all) => all.filter((x) => x.id !== p.id))}
                            className="opacity-0 transition group-hover:opacity-100"
                            aria-label="Remove"
                          >
                            <Trash2 className="h-3.5 w-3.5 text-white/40 hover:text-rose-300" />
                          </button>
                        </li>
                      ))}
                      {!path.length && (
                        <li className="text-[13px] text-white/50">
                          Ask {name} for a learning path, then add the steps here to track your progress. Saved on this device only.
                        </li>
                      )}
                    </ul>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (!newGoal.trim()) return;
                        setPath((all) => [...all, { id: uid(), title: newGoal.trim().slice(0, 120), status: "planned" }]);
                        setNewGoal("");
                      }}
                      className="mt-3 flex gap-2"
                    >
                      <input
                        value={newGoal}
                        onChange={(e) => setNewGoal(e.target.value)}
                        placeholder="Add a course or goal"
                        className="input-hud min-w-0 flex-1 px-3 py-1.5 text-sm"
                      />
                      <button className="btn-accent rounded-lg px-2.5" aria-label="Add">
                        <Plus className="h-4 w-4" />
                      </button>
                    </form>
                  </Panel>

                  <Panel title="Coaching" icon={CalendarClock}>
                    {settings?.coachingBookingUrl ? (
                      <a
                        href={settings.coachingBookingUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="btn-accent flex items-center justify-center gap-2 rounded-xl py-2 text-sm font-bold"
                      >
                        Book a coaching session <ExternalLink className="h-4 w-4" />
                      </a>
                    ) : (
                      <p className="text-[13px] text-white/60">Ask {name} about coaching — the L&D team will share booking details.</p>
                    )}
                  </Panel>
                </motion.div>
              )}
            </AnimatePresence>
          </aside>

          {/* Holographic core */}
          <section className="order-1 flex flex-col items-center justify-center gap-4 lg:order-2">
            <HoloCore
              state={voiceLocked ? "idle" : voice.state}
              getLevel={voice.getLevel}
              onPress={onCorePress}
              callActive={voice.callActive}
              locked={voiceLocked}
              size={coreSize}
            />

            <div className="text-center">
              <motion.p
                key={voiceLocked ? "hr" : voice.state}
                initial={{ opacity: 0, letterSpacing: "0.8em" }}
                animate={{ opacity: 1, letterSpacing: "0.4em" }}
                className="font-display text-sm font-bold accent glow-text"
              >
                {voiceLocked ? "PRIVATE · TEXT ONLY" : STATE_LABEL[voice.state]}
              </motion.p>
              <p className="mt-2 min-h-[1.5rem] max-w-sm text-sm italic text-white/70">
                {voiceLocked
                  ? "Type below. Voice is off here to protect your privacy."
                  : voice.interim ||
                    (isHR && !voice.callActive && voice.supported.stt
                      ? "Tap the core to talk — please avoid names and personal details"
                      : "") ||
                    (voice.callActive ? "Go ahead, I'm listening…" : voice.supported.stt || !voice.supported.checked ? "Tap the core to talk" : "Voice needs Chrome, Edge or Safari — type below")}
              </p>
              {voice.error && <p className="mt-1 text-xs text-rose-300">{voice.error}</p>}
            </div>

            {!voiceLocked && (
              <div className="flex items-center gap-2">
                <label className="glass flex items-center gap-2 !rounded-xl px-3 py-1.5 text-xs">
                  <Languages className="h-3.5 w-3.5 accent" />
                  <select
                    value={lang}
                    onChange={(e) => setLang(e.target.value as VoiceLang)}
                    className="bg-transparent outline-none"
                    aria-label="Voice language"
                  >
                    {LANGS.map((l) => (
                      <option key={l.id} value={l.id} className="bg-[#07111f]">
                        {l.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  onClick={() => {
                    if (!muted) voice.interrupt();
                    setMuted((m) => !m);
                  }}
                  className="glass flex items-center gap-1.5 !rounded-xl px-3 py-1.5 text-xs"
                  aria-pressed={muted}
                >
                  {muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5 accent" />}
                  {muted ? "Voice replies off" : "Voice replies on"}
                </button>
              </div>
            )}
          </section>

          {/* Conversation */}
          <section className="glass hud-corners order-2 flex h-[560px] flex-col lg:order-3 lg:h-[calc(100dvh-230px)] lg:min-h-[520px]">
            <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
              <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-white/50">
                {isHR ? "Policy & grievance guidance" : "Learning session"}
                {!isHR && status && (
                  <span className={`ml-2 normal-case tracking-normal ${status.webSearch ? "text-sky-200/80" : "text-white/30"}`}>
                    · live web {status.webSearch ? "on" : "off"}
                  </span>
                )}
                {isHR && <span className="ml-2 normal-case tracking-normal text-white/30">· offline from the web by design</span>}
              </p>
              {messages.length > 0 && (
                <button onClick={clearThread} className="flex items-center gap-1 text-[11px] text-white/45 hover:text-white">
                  <Trash2 className="h-3.5 w-3.5" /> Clear
                </button>
              )}
            </div>

            <div ref={scrollRef} className="thin-scroll flex-1 space-y-3 overflow-y-auto px-4 py-4">
              {!messages.length && (
                <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
                  <Sparkles className="h-6 w-6 accent" />
                  <p className="max-w-sm text-sm text-white/70">
                    {isHR
                      ? `I can explain ${settings?.orgName ?? "company"} policies, your rights, and exactly how to raise a concern with the right people.`
                      : `Hi, I'm ${name}. Tell me your role and what you want to get better at — I'll map a path from our catalog.`}
                  </p>
                  {status && !status.live && !testMode && (
                    <p className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-100">
                      The team is still setting things up — answers will be limited until launch.
                    </p>
                  )}
                  <div className="flex flex-wrap justify-center gap-2">
                    {QUICK[module].map((q) => (
                      <button
                        key={q}
                        onClick={() => void send(q)}
                        className="rounded-full border border-[rgba(var(--accent-rgb),0.3)] px-3 py-1.5 text-xs text-white/80 hover:bg-[rgba(var(--accent-rgb),0.1)]"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <AnimatePresence initial={false}>
                {messages.map((m) => (
                  <motion.div
                    key={m.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <Bubble msg={m} typing={busy && m.role === "assistant" && !m.content} name={name} />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>

            <form onSubmit={onSubmit} className="flex gap-2 border-t border-white/5 p-3">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={isHR ? "Ask about a policy or how to raise a concern…" : `Message ${name}…`}
                maxLength={2000}
                className="input-hud min-w-0 flex-1 px-4 py-2.5 text-sm"
                aria-label="Message"
              />
              <button
                disabled={busy || !input.trim()}
                className="btn-accent flex items-center justify-center rounded-xl px-4 disabled:opacity-40"
                aria-label="Send"
              >
                <Send className="h-4 w-4" />
              </button>
            </form>
          </section>
        </main>

        <footer className="pb-2 text-center font-mono text-[10px] tracking-widest text-white/30">
          AI-generated guidance can be wrong · Always confirm important decisions with HR
        </footer>
      </div>

      {/* Voice consent */}
      <AnimatePresence>
        {consentAsk && (
          <motion.div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" {...fade}>
            <motion.div className="glass hud-corners max-w-md p-6" initial={{ scale: 0.95 }} animate={{ scale: 1 }}>
              <h3 className="font-display text-lg font-bold tracking-wider accent">BEFORE WE TALK</h3>
              <p className="mt-3 text-sm leading-relaxed text-white/75">
                Voice uses your browser's built-in speech service. In Chrome and Edge, your audio is processed by Google or
                Microsoft; in Safari, by Apple. {name} doesn't record or store audio. Please don't share personal or sensitive
                details by voice.
              </p>
              <div className="mt-5 flex gap-2">
                <button onClick={acceptConsent} className="btn-accent flex-1 rounded-xl py-2 text-sm font-bold">
                  I understand — start
                </button>
                <button
                  onClick={() => setConsentAsk(false)}
                  className="flex-1 rounded-xl border border-white/15 py-2 text-sm text-white/75 hover:bg-white/5"
                >
                  I'll type instead
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <TrainingPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        admin={admin}
        onAdminChange={setAdmin}
        testMode={testMode}
        onTestModeChange={setTestMode}
        onStatusChange={refreshStatus}
      />
    </div>
  );
}

// ───────────────────────────── small components ─────────────────────────────

const fade = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } };

function KineticTitle({ text }: { text: string }) {
  return (
    <h1 className="font-display text-2xl font-black tracking-[0.3em] accent glow-text" aria-label={text}>
      {text.split("").map((ch, i) => (
        <motion.span
          key={`${text}-${i}`}
          initial={{ opacity: 0, y: -12, filter: "blur(6px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ delay: i * 0.06, duration: 0.45 }}
          className="inline-block"
          aria-hidden
        >
          {ch === " " ? " " : ch}
        </motion.span>
      ))}
    </h1>
  );
}

function StatusChip({ status, testMode }: { status: PublicStatus | null; testMode: boolean }) {
  const live = status?.live;
  const color = testMode ? "#e879f9" : live ? "#5cffc8" : "#ffb547";
  const label = testMode ? "DRAFT" : live ? `LIVE · v${status?.version}` : status ? "NOT LIVE" : "…";
  return (
    <span
      className="flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-[11px] tracking-widest"
      style={{ borderColor: `${color}55`, color }}
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
      {label}
    </span>
  );
}

function Panel({
  title,
  icon: Icon,
  aside,
  children,
}: {
  title: string;
  icon: typeof ShieldCheck;
  aside?: string;
  children: ReactNode;
}) {
  return (
    <div className="glass hud-corners p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-display text-xs font-bold tracking-[0.2em] accent">
          <Icon className="h-4 w-4" /> {title.toUpperCase()}
        </h2>
        {aside && <span className="font-mono text-[11px] text-white/50">{aside}</span>}
      </div>
      {children}
    </div>
  );
}

function Li({ icon: Icon, children }: { icon: typeof ShieldCheck; children: ReactNode }) {
  return (
    <li className="flex gap-2">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 accent" />
      <span>{children}</span>
    </li>
  );
}

const ROUTE_TAG: Partial<Record<ChatRoute, { label: string; cls: string }>> = {
  posh: { label: "Routed to Internal Committee", cls: "border-violet-300/40 text-violet-200" },
  crisis: { label: "Support resources", cls: "border-rose-300/40 text-rose-200" },
  safety: { label: "Urgent safety guidance", cls: "border-rose-300/40 text-rose-200" },
  fallback: { label: "Quoted from policy", cls: "border-amber-300/40 text-amber-200" },
};

function Bubble({ msg, typing, name }: { msg: Msg; typing: boolean; name: string }) {
  const mine = msg.role === "user";
  const tag = msg.route ? ROUTE_TAG[msg.route] : undefined;
  return (
    <div
      className={`max-w-[88%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
        mine
          ? "rounded-br-md bg-[rgba(var(--accent-rgb),0.16)] text-white"
          : "rounded-bl-md border border-white/8 bg-black/35 text-white/90"
      }`}
    >
      {!mine && (
        <p className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] accent">
          {name}
          {tag && <span className={`rounded-full border px-2 py-0.5 normal-case tracking-normal ${tag.cls}`}>{tag.label}</span>}
        </p>
      )}
      {typing ? (
        <span className="inline-flex gap-1 py-1">
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]"
              animate={{ opacity: [0.2, 1, 0.2] }}
              transition={{ repeat: Infinity, duration: 1, delay: i * 0.18 }}
            />
          ))}
        </span>
      ) : (
        <p className="whitespace-pre-wrap">{linkify(msg.content)}</p>
      )}
      {!mine && !!msg.web?.length && (
        <div className="mt-2 space-y-1 border-t border-white/5 pt-2">
          <p className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-sky-200/70">
            <Globe className="h-3 w-3" /> Live web · may change · not company policy
          </p>
          <div className="flex flex-wrap gap-1">
            {msg.web.map((w) => (
              <a
                key={w.url}
                href={w.url}
                target="_blank"
                rel="noreferrer"
                title={w.title}
                className="rounded-md border border-sky-300/20 bg-sky-400/5 px-1.5 py-0.5 font-mono text-[10px] text-sky-200/80 hover:bg-sky-400/15"
              >
                {w.domain} · checked {new Date(w.checkedAt).toLocaleDateString()}
              </a>
            ))}
          </div>
        </div>
      )}
      {!mine && !!msg.sources?.length && (
        <div className="mt-2 flex flex-wrap gap-1">
          {msg.sources.map((s) => (
            <span key={s} className="rounded-md bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-white/50">
              Policy · {s}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Turn bare URLs and emails into safe links (no HTML injection — React escapes the rest). */
function linkify(text: string) {
  const parts = text.split(/(https?:\/\/[^\s)]+|[\w.+-]+@[\w-]+\.[\w.-]+)/g);
  return parts.map((p, i) =>
    /^https?:\/\//.test(p) ? (
      <a key={i} href={p} target="_blank" rel="noreferrer" className="accent underline underline-offset-2">
        {p}
      </a>
    ) : /^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(p) ? (
      <a key={i} href={`mailto:${p}`} className="accent underline underline-offset-2">
        {p}
      </a>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}
