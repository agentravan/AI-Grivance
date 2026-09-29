/**
 * lib/llm.ts — pick the LLM provider from environment variables.
 *
 * Priority:
 *   1. OpenRouter  (OPENROUTER_API_KEY)  — default model "openrouter/free", a router
 *      that picks an available free model per request, so it keeps working when
 *      OpenRouter's free lineup changes. Set OPENROUTER_MODEL to pin a model.
 *   2. Groq        (GROQ_API_KEY)        — default "llama-3.3-70b-versatile".
 *   3. none        → the chat route answers in retrieval-only mode (quotes policies).
 *
 * PRIVACY NOTE: free models on OpenRouter are served by third-party providers,
 * some of which may log or train on prompts. For the grievance module, either
 * set GRIEVANCE_LLM=off, or use a paid model and enable "zero data retention"
 * in OpenRouter → Settings → Privacy.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createGroq } from "@ai-sdk/groq";

export type LlmInfo = { provider: "openrouter" | "groq" | "none"; model: string };

export function llmInfo(): LlmInfo {
  if (process.env.OPENROUTER_API_KEY) {
    return { provider: "openrouter", model: process.env.OPENROUTER_MODEL || "openrouter/free" };
  }
  if (process.env.GROQ_API_KEY) {
    return { provider: "groq", model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile" };
  }
  return { provider: "none", model: "" };
}

/** Returns an AI SDK language model, or null when no key is configured. */
export function getModel() {
  const info = llmInfo();
  if (info.provider === "openrouter") {
    const openrouter = createOpenAICompatible({
      name: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY,
      headers: {
        // Optional attribution headers shown in your OpenRouter dashboard.
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://ai-grivance.vercel.app",
        "X-Title": "AEGIS People Assistant",
      },
    });
    return openrouter.chatModel(info.model);
  }
  if (info.provider === "groq") {
    return createGroq({ apiKey: process.env.GROQ_API_KEY })(info.model);
  }
  return null;
}
