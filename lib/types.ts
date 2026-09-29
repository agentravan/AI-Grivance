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
  source: "pdf" | "text";
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
  stage: Stage;
}

/** How the chat engine answered — sent in the `x-aegis-route` header. */
export type ChatRoute = "llm" | "fallback" | "posh" | "crisis" | "safety" | "offline" | "ratelimited";

export interface AuditEntry {
  at: string;
  by: string;
  action: string;
  detail?: string;
}
