/** Shared types used by both the browser and the API routes. */

export type ModuleId = "ld" | "hr";
/** Which module a knowledge document serves. */
export type DocScope = ModuleId | "both";
export type Stage = "draft" | "live";

export interface DocMeta {
  id: string;
  title: string;
  scope: DocScope;
  chars: number;
  chunks: number;
  source: "pdf" | "text" | "web";
  /** Web-sourced Pulse packs must be approved by a named admin before GO LIVE. */
  needsReview?: boolean;
  reviewedBy?: string;
  reviewedAt?: string;
  uploadedAt: string;
  uploadedBy: string;
}

/** Organisation settings editable in the Training Panel, published with GO LIVE. */
export interface OrgSettings {
  assistantName: string;
  orgName: string;
  /** Internal Committee (POSH) contact details. */
  icName: string;
  icEmail: string;
  icPhone: string;
  /** Official grievance channel (HRMS ticket link, form, or mailbox). */
  grievanceChannelUrl: string;
  hrEmail: string;
  /** Free booking link for coaching sessions (Cal.com, Google Calendar appointment page…). */
  coachingBookingUrl: string;
  /** "on" = voice calls allowed in the Grievance module too; "off" = text only. */
  grievanceVoice: string;
}

export const DEFAULT_SETTINGS: OrgSettings = {
  assistantName: "AEGIS",
  orgName: "Your Company",
  icName: "Internal Committee (POSH)",
  icEmail: "",
  icPhone: "",
  grievanceChannelUrl: "",
  hrEmail: "",
  coachingBookingUrl: "",
  grievanceVoice: "on",
};

export interface PublicStatus {
  live: boolean;
  version: number;
  publishedAt: string | null;
  settings: OrgSettings;
  llmConfigured: boolean;
  storePersistent: boolean;
  pilot: boolean;
  grievanceLlm: "redacted" | "off";
  /** Live web search available for L&D (key present + enabled). */
  webSearch: boolean;
  stage: Stage;
}

/** How the chat engine answered — sent in the `x-aegis-route` header. */
/** A web source attached to an answer (x-aegis-web header). */
export interface WebSource {
  title: string;
  url: string;
  domain: string;
  checkedAt: string;
}

export type ChatRoute = "llm" | "fallback" | "posh" | "crisis" | "safety" | "offline" | "ratelimited";

export interface AuditEntry {
  at: string;
  by: string;
  action: string;
  detail?: string;
}
