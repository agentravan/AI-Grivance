/**
 * lib/pulse.ts — the "Regulatory & Skills Pulse".
 *
 * Runs FIXED topic searches (no employee data at all) and drops the results into
 * the Training Panel as DRAFT documents flagged "needs review". Nothing reaches
 * employees until a named admin approves the pack and presses GO LIVE.
 *
 * Triggered by:
 *   • Vercel Cron (vercel.json → /api/cron/pulse, once a day — the Hobby limit)
 *   • "Run Pulse now" in the Training Panel (POST /api/train {action:"pulse"})
 *
 * Customise topics with PULSE_TOPICS (JSON array of {q, scope, domains?}) and add
 * state-specific rules with PULSE_STATE (e.g. "Haryana").
 */
import { addDraftDoc, audit } from "./knowledge";
import { store } from "./store";
import { webSearch, webSearchEnabled } from "./search";
import type { DocScope } from "./types";

interface Topic {
  q: string;
  scope: DocScope;
  domains?: string[];
}

const LEGAL_DOMAINS = [
  "labour.gov.in",
  "pib.gov.in",
  "egazette.gov.in",
  "meity.gov.in",
  "wcd.gov.in",
  "indiacode.nic.in",
  "prsindia.org",
  "livelaw.in",
  "barandbench.com",
];

function topics(): Topic[] {
  try {
    const custom = JSON.parse(process.env.PULSE_TOPICS || "null");
    if (Array.isArray(custom) && custom.length) return custom as Topic[];
  } catch {
    /* fall through to defaults */
  }
  const state = process.env.PULSE_STATE?.trim();
  return [
    { q: "Labour Codes implementation rules employers India latest update", scope: "hr", domains: LEGAL_DOMAINS },
    { q: "DPDP Rules employer obligations employee personal data latest", scope: "hr", domains: LEGAL_DOMAINS },
    { q: "POSH Act Internal Committee compliance latest update", scope: "hr", domains: LEGAL_DOMAINS },
    ...(state
      ? [{ q: `${state} Shops and Establishments Act amendment latest`, scope: "hr" as DocScope, domains: LEGAL_DOMAINS }]
      : []),
    { q: "most in-demand workplace skills India corporate upskilling report this year", scope: "ld" },
    { q: "professional certification exam fee changes this year India", scope: "ld" },
  ];
}

export interface PulseRun {
  at: string;
  ok: boolean;
  detail: string;
  docs: string[];
}

export async function lastPulse(): Promise<PulseRun | null> {
  return store.getJSON<PulseRun>("pulse:last");
}

export async function runPulse(by: string): Promise<PulseRun> {
  const at = new Date().toISOString();
  const day = at.slice(0, 10);

  if (!webSearchEnabled()) {
    const run = { at, ok: false, detail: "TAVILY_API_KEY is not set (or ENABLE_WEB_SEARCH=false).", docs: [] };
    await store.setJSON("pulse:last", run);
    return run;
  }

  const sections: Record<"hr" | "ld", string[]> = { hr: [], ld: [] };
  let found = 0;

  // Run topic searches in parallel (keeps the cron/function well under its time limit).
  const all = topics();
  const resultsPerTopic = await Promise.all(
    all.map((t) =>
      webSearch(t.q, {
        maxResults: 4,
        includeDomains: t.domains,
        topic: t.scope === "hr" ? "news" : "general",
        timeRange: "month",
      }),
    ),
  );
  all.forEach((t, i) => {
    const results = resultsPerTopic[i];
    found += results.length;
    const bucket = t.scope === "ld" ? "ld" : "hr";
    sections[bucket].push(
      `TOPIC: ${t.q}\n` +
        (results.length
          ? results.map((r) => `- ${r.title} (${r.domain}, ${r.url}): ${r.snippet}`).join("\n")
          : "- No recent results."),
    );
  });

  const docs: string[] = [];
  const header = (kind: string) =>
    `${kind} generated ${day} from public web sources. UNVERIFIED until approved by a named reviewer. ` +
    `Summaries of news or draft rules are not the law; check the linked official source before relying on them.\n\n`;

  if (sections.hr.length) {
    const d = await addDraftDoc({
      title: `Regulatory Pulse ${day}`,
      scope: "hr",
      text: header("Regulatory Pulse") + sections.hr.join("\n\n"),
      source: "web",
      by,
      needsReview: true,
    });
    docs.push(d.title);
  }
  if (sections.ld.length) {
    const d = await addDraftDoc({
      title: `Skills Pulse ${day}`,
      scope: "ld",
      text: header("Skills Pulse") + sections.ld.join("\n\n"),
      source: "web",
      by,
      needsReview: true,
    });
    docs.push(d.title);
  }

  const run: PulseRun = {
    at,
    ok: found > 0,
    detail: found > 0 ? `${found} web results collected — review and approve before GO LIVE.` : "Searches returned no results.",
    docs,
  };
  await store.setJSON("pulse:last", run);
  await audit(by, "pulse", run.detail);
  return run;
}
