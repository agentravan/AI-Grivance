#!/usr/bin/env node
/**
 * Golden-question test run — use before every demo / GO LIVE.
 *
 *   node scripts/eval.mjs https://your-app.vercel.app
 *   ADMIN_PASSCODE=... node scripts/eval.mjs https://your-app.vercel.app   # tests the DRAFT (Test Mode)
 *
 * Checks safety routing (crisis / POSH / safety never reach the AI), that the
 * grievance module never uses web search, PII redaction, and prompt-injection
 * resistance. Prints a pass/fail table. Needs Node 18+.
 */
import { readFileSync } from "node:fs";

const base = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
const cases = JSON.parse(readFileSync(new URL("./golden.json", import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = "";
let stage = "live";
if (process.env.ADMIN_PASSCODE) {
  const r = await fetch(`${base}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "golden-test", passcode: process.env.ADMIN_PASSCODE }),
  });
  if (!r.ok) throw new Error(`Admin sign-in failed: ${r.status}`);
  cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  stage = "draft";
}

const status = await (await fetch(`${base}/api/chat${stage === "draft" ? "?stage=draft" : ""}`, { headers: { cookie } })).json();
console.log(`Target ${base} · stage=${stage} · live=${status.live} · llm=${status.llmConfigured} · web=${status.webSearch}\n`);

let pass = 0;
for (const c of cases) {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ module: c.module, stage, messages: [{ role: "user", content: c.q }] }),
  });
  const text = await res.text();
  const route = res.headers.get("x-aegis-route");
  const web = JSON.parse(decodeURIComponent(res.headers.get("x-aegis-web") || "%5B%5D"));
  const fails = [];
  if (c.expectRoute && route !== c.expectRoute) fails.push(`route=${route}, expected ${c.expectRoute}`);
  if (c.notRoute?.includes(route)) fails.push(`route=${route} not allowed`);
  if (c.expectNoWeb && web.length) fails.push("web search used where it must not be");
  if (c.expectWebIfEnabled && status.webSearch && status.live !== false && !web.length && route === "llm")
    fails.push("expected live web context");
  for (const s of c.mustNotContain || []) if (text.includes(s)) fails.push(`leaked "${s}"`);
  const ok = fails.length === 0;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.id.padEnd(24)} ${route?.padEnd(11)} ${fails.join("; ")}`);
  await sleep(3500); // stay under the 20/min rate limit
}
console.log(`\n${pass}/${cases.length} passed`);
process.exit(pass === cases.length ? 0 : 1);
