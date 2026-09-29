"use client";
/**
 * hooks/useVoiceAgent.ts — zero-cost "phone call" voice agent.
 *
 * Speech-to-text : window.SpeechRecognition / webkitSpeechRecognition
 * Text-to-speech : window.speechSynthesis
 * Visualizer     : Web Audio AnalyserNode on the mic stream (real levels while
 *                  listening) + synthetic levels driven by TTS word boundaries.
 *
 * Call flow (hands-free):
 *   startCall() → listening → user pauses → onUserUtterance(text) → thinking
 *   → page streams reply into pushResponseText() → sentences are spoken as they
 *     arrive → endResponse() → when the last sentence finishes → listening again.
 *   Tap the orb while it's speaking → interrupt() (barge-in by tap).
 *
 * PRIVACY — tell your users:
 *   Browser speech recognition is NOT on-device in most browsers. Chrome/Edge
 *   send audio to Google/Microsoft servers; Safari to Apple. Firefox has no
 *   recognition at all (text fallback is shown). That's why the dashboard asks
 *   for consent first and disables voice in the grievance module.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type VoiceState = "idle" | "listening" | "thinking" | "speaking";
export type VoiceLang = "en-IN" | "hi-IN" | "en-US";

export interface UseVoiceAgentOptions {
  lang: VoiceLang;
  /** Called with each final user utterance. */
  onUserUtterance: (text: string) => void;
  /** Speak assistant replies aloud (default true). */
  speakReplies?: boolean;
}

// ── Minimal typings: the Web Speech recognition API isn't in TS's DOM lib. ──
interface SRAlternative {
  transcript: string;
}
interface SRResult {
  isFinal: boolean;
  length: number;
  [i: number]: SRAlternative;
}
interface SREvent extends Event {
  resultIndex: number;
  results: { length: number; [i: number]: SRResult };
}
interface SRErrorEvent extends Event {
  error: string;
}
interface SpeechRec extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SREvent) => void) | null;
  onerror: ((e: SRErrorEvent) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecCtor = new () => SpeechRec;

function getRecognitionCtor(): SpeechRecCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: SpeechRecCtor; webkitSpeechRecognition?: SpeechRecCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Make text pleasant to hear: drop markdown, shorten URLs. */
function speakable(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "the link on screen")
    .replace(/[*_#`>|~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Pull complete sentences off the front of a streaming buffer. */
function takeSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  // A boundary is end punctuation FOLLOWED by whitespace (so "3.5" or "e.g.x"
  // isn't split mid-stream), or a line break.
  const re = /[.!?।]+["')\]]*\s+|\n+/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buffer)) !== null) {
    const end = m.index + m[0].length;
    const s = buffer.slice(start, end).trim();
    if (s.length < 4) continue; // tiny fragments ("1.") merge into the next sentence
    sentences.push(s);
    start = end;
  }
  return { sentences, rest: buffer.slice(start) };
}

export function useVoiceAgent({ lang, onUserUtterance, speakReplies = true }: UseVoiceAgentOptions) {
  const [supported, setSupported] = useState({ stt: false, tts: false, checked: false });
  const [state, setStateRaw] = useState<VoiceState>("idle");
  const [interim, setInterim] = useState("");
  const [callActive, setCallActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs keep the event handlers in sync without re-creating recognizers.
  const stateRef = useRef<VoiceState>("idle");
  const callRef = useRef(false);
  const recRef = useRef<SpeechRec | null>(null);
  const onUtteranceRef = useRef(onUserUtterance);
  const speakRef = useRef(speakReplies);
  const langRef = useRef(lang);

  const queueRef = useRef<string[]>([]);
  const bufferRef = useRef("");
  const responseDoneRef = useRef(true);
  const speakingRef = useRef(false);
  const genRef = useRef(0); // invalidates stale TTS callbacks after interrupt()
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const sampleRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const boundaryRef = useRef(0);

  useEffect(() => void (onUtteranceRef.current = onUserUtterance), [onUserUtterance]);
  useEffect(() => void (speakRef.current = speakReplies), [speakReplies]);
  useEffect(() => void (langRef.current = lang), [lang]);

  const setState = useCallback((s: VoiceState) => {
    stateRef.current = s;
    setStateRaw(s);
  }, []);

  // ── Feature detection + voice list (client only) ──
  useEffect(() => {
    const tts = typeof window !== "undefined" && "speechSynthesis" in window;
    setSupported({ stt: !!getRecognitionCtor(), tts, checked: true });
    if (!tts) return;
    const load = () => (voicesRef.current = window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);

  const pickVoice = useCallback((): SpeechSynthesisVoice | undefined => {
    const voices = voicesRef.current;
    const l = langRef.current.toLowerCase();
    const base = l.split("-")[0];
    const rank = (v: SpeechSynthesisVoice) =>
      (v.lang.toLowerCase().replace("_", "-") === l ? 10 : v.lang.toLowerCase().startsWith(base) ? 5 : 0) +
      (/google|natural|neural|online/i.test(v.name) ? 2 : 0);
    return [...voices].sort((a, b) => rank(b) - rank(a)).find((v) => rank(v) >= 5);
  }, []);

  // ── Microphone level meter for the visualizer ──
  const ensureMic = useCallback(async () => {
    if (analyserRef.current || !navigator.mediaDevices?.getUserMedia) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AC();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      micStreamRef.current = stream;
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
      sampleRef.current = new Uint8Array(new ArrayBuffer(analyser.fftSize));
    } catch {
      // Meter is cosmetic; recognition will surface real permission errors.
    }
  }, []);

  const releaseMic = useCallback(() => {
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    void audioCtxRef.current?.close().catch(() => {});
    micStreamRef.current = null;
    audioCtxRef.current = null;
    analyserRef.current = null;
  }, []);

  /** 0..1 level for the visualizer. Call from requestAnimationFrame. */
  const getLevel = useCallback((): number => {
    const t = performance.now() / 1000;
    switch (stateRef.current) {
      case "listening": {
        const a = analyserRef.current;
        const buf = sampleRef.current;
        if (!a || !buf) return 0.25 + 0.1 * Math.sin(t * 4);
        a.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        return Math.min(1, Math.sqrt(sum / buf.length) * 4 + 0.08);
      }
      case "speaking": {
        boundaryRef.current *= 0.92;
        return Math.min(1, 0.35 + 0.18 * Math.abs(Math.sin(t * 9)) + boundaryRef.current * 0.5);
      }
      case "thinking":
        return 0.18 + 0.1 * Math.sin(t * 3);
      default:
        return 0.06 + 0.03 * Math.sin(t * 1.5);
    }
  }, []);

  // ── Speech recognition ──
  const startListening = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setError("Voice input isn't supported in this browser. Try Chrome or Edge, or type instead.");
      return;
    }
    recRef.current?.abort();
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();

    const rec = new Ctor();
    rec.lang = langRef.current;
    rec.continuous = false; // one utterance per turn → natural call rhythm
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    let handled = false;

    rec.onresult = (e) => {
      let finalText = "";
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interimText += r[0].transcript;
      }
      setInterim(interimText);
      if (finalText.trim() && !handled) {
        handled = true;
        setInterim("");
        rec.stop();
        setState("thinking");
        onUtteranceRef.current(finalText.trim());
      }
    };

    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return; // onend decides what next
      const msg =
        e.error === "not-allowed" || e.error === "service-not-allowed"
          ? "Microphone access was blocked. Allow it in the address bar, or type instead."
          : e.error === "network"
            ? "The browser's speech service couldn't be reached. Check your connection or type instead."
            : `Voice error: ${e.error}`;
      setError(msg);
      callRef.current = false;
      setCallActive(false);
    };

    rec.onend = () => {
      if (recRef.current === rec) recRef.current = null;
      if (handled || stateRef.current !== "listening") return;
      // Silence timeout: keep the line open during a call, otherwise go idle.
      if (callRef.current) setTimeout(() => callRef.current && stateRef.current === "listening" && startListening(), 250);
      else setState("idle");
    };

    recRef.current = rec;
    setError(null);
    setState("listening");
    try {
      rec.start();
    } catch {
      // start() throws if a previous session is still closing; retry shortly.
      setTimeout(() => {
        try {
          rec.start();
        } catch {
          setState("idle");
        }
      }, 300);
    }
  }, [setState]);

  const stopListening = useCallback(() => {
    recRef.current?.abort();
    recRef.current = null;
    setInterim("");
    if (stateRef.current === "listening") setState("idle");
  }, [setState]);

  // ── Speech synthesis queue ──
  const afterSpeech = useCallback(() => {
    if (queueRef.current.length || !responseDoneRef.current || speakingRef.current) return;
    if (callRef.current) startListening();
    else setState("idle");
  }, [setState, startListening]);

  const pump = useCallback(() => {
    if (speakingRef.current) return;
    const next = queueRef.current.shift();
    if (!next) return afterSpeech();
    const text = speakable(next);
    if (!text) return pump();

    const gen = genRef.current;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = langRef.current;
    const v = pickVoice();
    if (v) u.voice = v;
    u.rate = 1.03;
    u.pitch = 0.95;
    u.onstart = () => gen === genRef.current && setState("speaking");
    u.onboundary = () => void (boundaryRef.current = 1);
    const done = () => {
      if (gen !== genRef.current) return;
      speakingRef.current = false;
      pump();
    };
    u.onend = done;
    u.onerror = done;
    speakingRef.current = true;
    window.speechSynthesis.speak(u);
  }, [afterSpeech, pickVoice, setState]);

  /** Call before streaming a reply. */
  const beginResponse = useCallback(() => {
    genRef.current++;
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    speakingRef.current = false;
    queueRef.current = [];
    bufferRef.current = "";
    responseDoneRef.current = false;
    setState("thinking");
  }, [setState]);

  /** Feed streamed text; complete sentences start speaking immediately. */
  const pushResponseText = useCallback(
    (delta: string) => {
      if (!speakRef.current || !supported.tts) return;
      bufferRef.current += delta;
      const { sentences, rest } = takeSentences(bufferRef.current);
      bufferRef.current = rest;
      if (sentences.length) {
        queueRef.current.push(...sentences);
        pump();
      }
    },
    [pump, supported.tts],
  );

  /** Call when the reply stream has finished. */
  const endResponse = useCallback(() => {
    responseDoneRef.current = true;
    if (speakRef.current && supported.tts && bufferRef.current.trim()) {
      queueRef.current.push(bufferRef.current.trim());
    }
    bufferRef.current = "";
    if (speakRef.current && supported.tts) pump();
    else afterSpeech();
  }, [afterSpeech, pump, supported.tts]);

  /** Speak a one-off line (e.g. a greeting). */
  const speak = useCallback(
    (text: string) => {
      beginResponse();
      pushResponseText(text);
      endResponse();
    },
    [beginResponse, endResponse, pushResponseText],
  );

  /** Stop talking now; during a call, hand the floor back to the user. */
  const interrupt = useCallback(() => {
    genRef.current++;
    queueRef.current = [];
    bufferRef.current = "";
    responseDoneRef.current = true;
    speakingRef.current = false;
    window.speechSynthesis?.cancel();
    if (callRef.current) startListening();
    else setState("idle");
  }, [setState, startListening]);

  // ── Call controls ──
  const startCall = useCallback(async () => {
    callRef.current = true;
    setCallActive(true);
    await ensureMic();
    startListening();
  }, [ensureMic, startListening]);

  const endCall = useCallback(() => {
    callRef.current = false;
    setCallActive(false);
    genRef.current++;
    queueRef.current = [];
    speakingRef.current = false;
    recRef.current?.abort();
    recRef.current = null;
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    releaseMic();
    setInterim("");
    setState("idle");
  }, [releaseMic, setState]);

  /** Push-to-talk: capture a single utterance without starting a call. */
  const listenOnce = useCallback(async () => {
    await ensureMic();
    startListening();
  }, [ensureMic, startListening]);

  // Clean up on unmount.
  useEffect(
    () => () => {
      callRef.current = false;
      recRef.current?.abort();
      if (typeof window !== "undefined") window.speechSynthesis?.cancel();
      releaseMic();
    },
    [releaseMic],
  );

  return {
    supported,
    state,
    interim,
    callActive,
    error,
    clearError: () => setError(null),
    startCall,
    endCall,
    listenOnce,
    stopListening,
    beginResponse,
    pushResponseText,
    endResponse,
    speak,
    interrupt,
    getLevel,
  };
}

export type VoiceAgent = ReturnType<typeof useVoiceAgent>;
