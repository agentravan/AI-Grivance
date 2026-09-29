"use client";
/**
 * components/HoloCore.tsx — the central holographic "arc reactor" visualizer.
 *
 * • A <canvas> draws a radial spectrum ring driven by getLevel() every frame
 *   (real mic levels while listening, synthetic TTS levels while speaking).
 * • Framer Motion rotates layered SVG rings at different speeds per state.
 * • The core itself is the voice button.
 */
import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { Loader2, Lock, Mic, PhoneOff, Volume2 } from "lucide-react";
import type { VoiceState } from "@/hooks/useVoiceAgent";

interface Props {
  state: VoiceState;
  getLevel: () => number;
  onPress: () => void;
  callActive: boolean;
  /** Grievance mode: voice disabled for privacy. */
  locked?: boolean;
  disabled?: boolean;
  size?: number;
}

const SPEED: Record<VoiceState, number> = { idle: 40, listening: 14, thinking: 5, speaking: 10 };

export default function HoloCore({ state, getLevel, onPress, callActive, locked, disabled, size = 340 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const getLevelRef = useRef(getLevel);
  getLevelRef.current = getLevel;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    const accent = getComputedStyle(canvas).getPropertyValue("--accent-rgb").trim() || "56, 225, 255";
    const BARS = 96;
    const cx = size / 2;
    const cy = size / 2;
    const inner = size * 0.27;
    let smooth = 0;
    let raf = 0;

    const draw = () => {
      const t = performance.now() / 1000;
      const target = getLevelRef.current();
      smooth += (target - smooth) * 0.18;
      ctx.clearRect(0, 0, size, size);

      // Core glow
      const g = ctx.createRadialGradient(cx, cy, inner * 0.2, cx, cy, inner * (1.25 + smooth * 0.5));
      g.addColorStop(0, `rgba(${accent}, ${0.35 + smooth * 0.4})`);
      g.addColorStop(0.55, `rgba(${accent}, ${0.08 + smooth * 0.12})`);
      g.addColorStop(1, `rgba(${accent}, 0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, inner * 1.8, 0, Math.PI * 2);
      ctx.fill();

      // Radial spectrum bars
      for (let i = 0; i < BARS; i++) {
        const a = (i / BARS) * Math.PI * 2 - Math.PI / 2;
        const wobble =
          0.55 +
          0.45 * Math.sin(i * 0.9 + t * 3.1) * Math.sin(i * 0.37 - t * 1.7) +
          0.25 * Math.sin(i * 2.3 + t * 7);
        const len = 4 + smooth * size * 0.17 * Math.max(0.15, wobble);
        const r0 = inner + 10;
        const x0 = cx + Math.cos(a) * r0;
        const y0 = cy + Math.sin(a) * r0;
        const x1 = cx + Math.cos(a) * (r0 + len);
        const y1 = cy + Math.sin(a) * (r0 + len);
        ctx.strokeStyle = `rgba(${accent}, ${0.35 + 0.6 * Math.min(1, len / (size * 0.14))})`;
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }

      // Orbiting particle
      const pa = t * (0.6 + smooth * 2);
      ctx.fillStyle = `rgba(${accent}, 0.9)`;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(pa) * size * 0.46, cy + Math.sin(pa) * size * 0.46, 2.2, 0, Math.PI * 2);
      ctx.fill();

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size, locked]);

  const Icon = locked ? Lock : state === "thinking" ? Loader2 : state === "speaking" ? Volume2 : callActive ? PhoneOff : Mic;
  const label = locked
    ? "Voice is off in Grievance mode for your privacy"
    : state === "speaking"
      ? "Tap to interrupt"
      : callActive
        ? "Tap to end the voice call"
        : "Tap to start a voice call";

  return (
    <div className="relative select-none" style={{ width: size, height: size }}>
      {/* Rotating HUD rings */}
      <motion.svg
        viewBox="0 0 200 200"
        className="absolute inset-0 h-full w-full"
        animate={{ rotate: 360 }}
        transition={{ repeat: Infinity, ease: "linear", duration: SPEED[state] }}
        aria-hidden
      >
        <circle cx="100" cy="100" r="97" fill="none" stroke="var(--accent)" strokeOpacity="0.25" strokeWidth="0.6" />
        <circle
          cx="100"
          cy="100"
          r="92"
          fill="none"
          stroke="var(--accent)"
          strokeOpacity="0.6"
          strokeWidth="1.2"
          strokeDasharray="2 6 18 6"
        />
      </motion.svg>
      <motion.svg
        viewBox="0 0 200 200"
        className="absolute inset-0 h-full w-full"
        animate={{ rotate: -360 }}
        transition={{ repeat: Infinity, ease: "linear", duration: SPEED[state] * 1.6 }}
        aria-hidden
      >
        <circle
          cx="100"
          cy="100"
          r="84"
          fill="none"
          stroke="var(--accent)"
          strokeOpacity="0.35"
          strokeWidth="3"
          strokeDasharray="1 3"
        />
        <path d="M100 12 A88 88 0 0 1 188 100" fill="none" stroke="var(--accent)" strokeOpacity="0.8" strokeWidth="1.5" />
        <path d="M100 188 A88 88 0 0 1 12 100" fill="none" stroke="var(--accent)" strokeOpacity="0.8" strokeWidth="1.5" />
      </motion.svg>

      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" style={{ width: size, height: size }} aria-hidden />

      {/* The core button */}
      <motion.button
        type="button"
        onClick={onPress}
        disabled={disabled || locked}
        aria-label={label}
        title={label}
        whileHover={!locked && !disabled ? { scale: 1.06 } : undefined}
        whileTap={!locked && !disabled ? { scale: 0.94 } : undefined}
        className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border backdrop-blur-md transition-colors disabled:cursor-not-allowed"
        style={{
          width: size * 0.36,
          height: size * 0.36,
          borderColor: "rgba(var(--accent-rgb), 0.55)",
          background:
            "radial-gradient(circle at 50% 40%, rgba(var(--accent-rgb),0.35), rgba(2,10,20,0.85) 70%)",
          boxShadow: "0 0 50px rgba(var(--accent-rgb),0.45), inset 0 0 30px rgba(var(--accent-rgb),0.35)",
        }}
      >
        <Icon
          className={`h-10 w-10 ${state === "thinking" && !locked ? "animate-spin" : ""}`}
          style={{ color: "var(--accent)", filter: "drop-shadow(0 0 8px var(--accent))" }}
        />
      </motion.button>
    </div>
  );
}
