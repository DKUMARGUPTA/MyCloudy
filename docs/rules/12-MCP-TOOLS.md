# 12 · MCP & AI Tooling Rules

How agents and the app use AI capabilities. Two distinct things live here:
(A) the z-ai skills the AGENT uses during work, (B) the in-app AI features
that call the SDK from the backend.

## A. Agent-side skills (available via the Skill tool)

| Skill | Use for | Rules of engagement |
|-------|---------|---------------------|
| LLM | chat-with-pdf/summarize/translate backends, copy drafting | backend only (`z-ai-web-dev-sdk`); never client import |
| VLM | i18n/tofu visual verification (P7-c battery), screenshot QA | pass `public/qa/*.png` artifacts, judge rendering honestly |
| Image-Generation | brand/OG/illustration assets when needed | output to `public/`, optimize size |
| TTS / ASR | future accessibility features | backend only; no voice data retention |
| Web-Search / Page-Reader | competitor research, docs lookup | never fetch user URLs into logs |
| agent-browser | E2E QA (mandatory every round) | pointer events: down → **150ms wait** → moves → up; menus: `focus()`+Enter; toasts are `ol.fixed > li` |

Skill discipline: before using a skill, read its SKILL.md; invoke via the
Skill tool, never hand-roll SDK calls for these in the agent loop.

## B. In-app AI features (production code)

- SDK calls happen ONLY inside `src/app/api/*` handlers (chat, summarize,
  translate) or mini-services — **never in client components**.
- Inputs: extracted text snippets only; file bytes never leave the device
  (Mode-D boundary, `03-ARCHITECTURE.md`).
- Responses are i18n-keyed errors on failure (`ai.failed` family), rate
  limited per-IP, and never logged with user content.
- Model outputs are treated as untrusted content — escape before render.

## C. Cron (agent scheduler)

- QA loop: `webDevReview` job, fixed_rate 900s, priority 1,
  tz Asia/Calcutta. Payload = the mandatory description + MUST first read
  `AGENTS.md` + `docs/rules/INDEX.md` + `CONTEXT-MEMORY.md`.
- If disabled by exec limits → delete + recreate (known platform quirk).
- One-time ops tasks: `kind="one_time"` with epoch millis; recurring:
  `cron`/`fixed_rate`. Timezone ALWAYS explicit.
- Cron rounds follow `07-AGENT-PROTOCOL.md` fully (they are first-class
  developers here, not babysitters).
