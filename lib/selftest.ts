/**
 * lib/selftest.ts — phone-friendly safety self-test (Training Panel → Launch → "Run safety test").
 *
 * Runs the golden questions in scripts/golden.json through the SAME deterministic
 * guardrails the chat engine uses — crisis / POSH / safety screens, the "no web in
 * grievance" rule, L&D web-trigger rules and PII redaction — without calling the
 * LLM, so it's instant, free and doesn't touch rate limits.
 * (Prompt-injection resistance needs the live model: try it in Test Mode chat.)
 */
import golden from "@/scripts/golden.json";
import { redactPII, screenMessage } from "./guardrails";
import { planLdSearch, webSearchEnabled } from "./search";

interface Case {
  id: string;
  module: "hr" | "ld";
  q: string;
  expectRoute?: string;
  notRoute?: string[];
  expectNoWeb?: boolean;
  expectWebIfEnabled?: boolean;
  mustNotContain?: string[];
}

export interface SelfTestResult {
  id: string;
  question: string;
  status: "pass" | "fail" | "manual";
  detail: string;
}

export function runSelfTest(): { passed: number; failed: number; manual: number; results: SelfTestResult[] } {
  const webOn = webSearchEnabled();
  const results = (golden as Case[]).map((c): SelfTestResult => {
    const route = screenMessage(c.q) ?? "ai";
    const webPlan = c.module === "ld" ? planLdSearch(c.q, false) : null; // grievance has no web path
    const fails: string[] = [];

    if (c.expectRoute && route !== c.expectRoute) fails.push(`went to "${route}", expected "${c.expectRoute}"`);
    if (c.notRoute?.includes(route)) fails.push(`wrongly routed to "${route}"`);
    if (c.expectNoWeb && webPlan) fails.push("would search the web");
    if (c.expectWebIfEnabled && webOn && !webPlan) fails.push("should trigger live web search");

    // PII cases: check what would be sent to the AI.
    const piiChecks = (c.mustNotContain ?? []).filter((s) => c.q.includes(s));
    const redacted = redactPII(c.q);
    for (const s of piiChecks) if (redacted.includes(s)) fails.push(`"${s}" not redacted`);

    const isManual = !!c.mustNotContain?.length && piiChecks.length === 0;
    if (isManual && !fails.length) {
      return { id: c.id, question: c.q, status: "manual", detail: "Needs the live AI — try this question in Test Mode chat." };
    }
    return {
      id: c.id,
      question: c.q,
      status: fails.length ? "fail" : "pass",
      detail: fails.length
        ? fails.join("; ")
        : route !== "ai"
          ? `Handled safely without AI (${route})`
          : webPlan
            ? "Goes to AI with live web context"
            : "Goes to AI, no web",
    };
  });
  return {
    passed: results.filter((r) => r.status === "pass").length,
    failed: results.filter((r) => r.status === "fail").length,
    manual: results.filter((r) => r.status === "manual").length,
    results,
  };
}
