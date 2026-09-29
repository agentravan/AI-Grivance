# AEGIS: a people assistant for L&D and HR grievances

AEGIS is a voice-first, JARVIS-style assistant for Learning & Development and HR policy guidance. It is built with Next.js (App Router), Tailwind CSS v4, Framer Motion and Lucide React. Voice uses the browser's built-in Web Speech API, so it adds no API cost.

| Module | What it does | Voice |
|---|---|---|
| **Learning & Growth** | Recommends courses from your catalog and answers stipend and certification questions. It shares a coaching booking link and has a "My Path" progress tracker that stays on the employee's device. | ✅ Hands-free "call" mode in `en-IN`, `hi-IN` or `en-US` |
| **Grievance & Policy** | Explains policies, rights and the escalation process with empathy, then **hands off to the Internal Committee or your official grievance channel**. It stores no complaint text. | 🔒 Text only, for privacy |

---

## 1. Design decisions (read before deploying)

These come from a design review of the brief. They are intentional.

1. **Grievances are routed, not stored.** The assistant is a navigator, not a filing system. Suppose a bot "logged" a complaint. The employee could believe they had filed it and miss the POSH Act's three-month window. It would also put your most sensitive data on free-tier infrastructure. For that reason no chat text is saved anywhere. Conversation history lives only in the browser tab.
2. **Some messages never reach the AI.** Crisis or self-harm language triggers a fixed reply with Tele-MANAS 14416 and 112. An immediate safety threat triggers a fixed urgent reply. A message that describes sexual harassment gets a card with Internal Committee contact details. These replies are hard-coded, not generated. General POSH process questions still get an answer.
3. **Personal data is stripped before the LLM sees it.** Emails, Indian phone numbers, PAN, Aadhaar-like numbers and employee IDs are redacted before any text goes to the model. Set `GRIEVANCE_LLM=off` to keep grievance mode fully offline. It then answers only by quoting your published policy text.
4. **Groq, not Gemini's free tier.** Groq says it doesn't train on API inputs. Gemini's free tier may use inputs to improve Google products.
5. **"Training" means publishing your documents.** No model is fine-tuned. The assistant searches the uploaded text by keyword and answers only from what it finds. Uploaded documents are treated as data, and any instructions written inside them are ignored.
6. **Browser voice is not on-device.** Chrome and Edge send audio to Google or Microsoft, and Safari sends it to Apple. Firefox has no speech recognition, so it falls back to text. Users see a consent prompt before their first voice session.

---

## 2. What this costs

| Piece | Service | Free tier |
|---|---|---|
| Hosting | Vercel **Hobby** | Free, but **personal and non-commercial use only** |
| LLM | **OpenRouter** (`openrouter/free`, auto-picks a free model) or Groq | Free, rate-limited. Degrades to quoting policy text when the limit is hit |
| Knowledge store | Upstash Redis (Vercel Marketplace) | Free: 256 MB, about 500K commands/month |
| Voice | Browser Web Speech API | Free |

> ⚠️ **An internal tool for an employer counts as commercial use.** Vercel's Hobby terms don't allow it. Use Hobby for the pilot and demo. For production, move to **Vercel Pro (US$20/month, about ₹1,700)** or your company's own hosting. Also move to a paid LLM plan that has a data-processing agreement. The code runs unchanged in both places.

---

## 3. Local setup (about 10 minutes)

```bash
# 1. Install dependencies
npm install

# 2. Create your env file
cp .env.example .env.local
#   - OPENROUTER_API_KEY → https://openrouter.ai/settings/keys (free models via openrouter/free)
#     (or GROQ_API_KEY → https://console.groq.com/keys)
#   - ADMIN_PASSCODE → any strong passcode for the HR/L&D content team
#   - AUTH_SECRET    → node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
#   (Upstash vars are optional locally — in-memory storage is used without them)

# 3. Run
npm run dev
# open http://localhost:3000 in Chrome or Edge
```

## 4. Deploy to Vercel

1. Push this folder to a GitHub repo.
2. In Vercel, go to **Add New → Project**, import the repo and keep the defaults.
3. Open the project's **Storage** tab, then **Marketplace → Upstash for Redis → Create → Connect to project**. This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically.
4. Under **Settings → Environment Variables**, add `OPENROUTER_API_KEY` (or `GROQ_API_KEY`), `ADMIN_PASSCODE`, `AUTH_SECRET`, `GRIEVANCE_LLM` and `PILOT_MODE`.
5. Under **Settings → Deployment Protection**, turn on protection for **Preview** deployments. Previews share your secrets and data.
6. Redeploy so the new variables take effect.

## 5. Going live (the content team's checklist)

1. Open the app and click **Team Training**. Sign in with your name and the passcode. Your name goes into the audit log.
2. **Knowledge tab:** upload the HR handbook, grievance policy, POSH policy, L&D catalog and stipend policy. Upload one file at a time, up to 4 MB each. Mark each one as *L&D*, *Grievance* or *Both*.
   - Scanned PDFs contain no readable text. Run OCR first, for example by opening the file in Google Drive with Google Docs.
   - For Word files, save them as PDF or paste the text.
3. **Settings tab:** set the assistant name (AEGIS, JARVIS, FRIDAY…), the Internal Committee's email and phone, the **official grievance channel URL** (your HRMS form), the HR email and a coaching booking link. A free Cal.com or Google Calendar appointment page works for booking.
4. **Launch tab:** turn on **Test Mode** and chat with the draft. Try the tricky questions too.
5. Press **GO LIVE**. It only succeeds once three things are true: at least one document is uploaded, IC contacts are set, and you've tested since your last change.
6. The **kill switch** takes the assistant offline instantly without deleting anything.
7. Leave `PILOT_MODE=on` (the banner) **until Legal and IT sign off** on the data flows under the DPDP Act and the POSH Act.

---

## 6. Project structure

```
app/
  page.tsx               Cinematic dashboard: module toggle, holographic core, chat, My Path
  layout.tsx, globals.css
  api/chat/route.ts      Chat & grievance engine: guardrails, retrieval, Groq streaming, fallback
  api/train/route.ts     Training & knowledge handler: upload, settings, GO LIVE, kill switch
  api/auth/route.ts      Admin sign-in (passcode → signed httpOnly cookie)
hooks/
  useVoiceAgent.ts       Speech recognition + synthesis "phone call" loop + visualizer levels
components/
  HoloCore.tsx           Arc-reactor visualizer (canvas + Framer Motion rings) = voice button
  TrainingPanel.tsx      Team drawer: Knowledge / Settings / Launch (GO LIVE)
lib/
  guardrails.ts          Crisis/POSH/safety screens, PII redaction, system prompts, fallback
  knowledge.ts           Chunking, BM25 keyword retrieval, draft → live publishing, audit log
  store.ts               Upstash Redis (prod) / in-memory (dev) key-value layer
  auth.ts                jose sessions, timing-safe passcode check, hashed rate-limit keys
  types.ts               Shared types
```

## 7. Customising

- **Guardrail keywords** are in `lib/guardrails.ts`. They are deliberately over-inclusive. Review them with your IC and Legal team.
- **Tone and persona** are in the `SHARED`, `HR_PROMPT` and `LD_PROMPT` constants in `lib/guardrails.ts`.
- **Switching models:** set `OPENROUTER_MODEL` (e.g. a paid model with zero data retention for production) or `GROQ_MODEL`. Provider selection lives in `lib/llm.ts`.
- **Privacy with OpenRouter free models:** free endpoints may log or train on prompts. For grievances, set `GRIEVANCE_LLM=off` or use a paid model and turn on zero data retention in OpenRouter → Settings → Privacy. To move to another provider, replace `createGroq` in `app/api/chat/route.ts` with any Vercel AI SDK provider, such as `@ai-sdk/openai` or `@ai-sdk/azure`.
- **Colours:** each module's accent is set in `app/globals.css` under `[data-module="ld"]` and `[data-module="hr"]`.
- **SSO:** replace `lib/auth.ts` with Auth.js and your Google Workspace or Entra ID tenant before a wider rollout.

## 8. Browser support

| | Voice in | Voice out | Notes |
|---|---|---|---|
| Chrome / Edge (desktop, Android) | ✅ | ✅ | Recommended |
| Safari (macOS / iOS) | ✅ | ✅ | |
| Firefox | ❌ | ✅ | Text input fallback is shown automatically |
