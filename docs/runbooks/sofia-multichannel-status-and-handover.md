# Sofia Multichannel Status, Evolution Limitations & Handover Runbook

**Date:** 2026-09-16
**Repository:** `github.com/wilkinbarban/CRM_Sofia_Manager`
**Release HEAD on `main`:** `303a757`
**Current Production Web Image:** `asados-web:evolution-text-optin-303a757-20260916T010928Z` (`sha256:f92fa9326954e238be69c9798fe9cb963580625701a21c363b0f64dc0c12ba08`)
**Previous Web Image (Rollback Tag):** `asados-web:rollback-e7628e776c1f27f8c07f5b0dc136454a7adbbebea6eba6503d9a78db05178054`
**Production Database Identity:** `asados-supabase-db` (ID: `0bff70962b42e9757f1ecd9aa5b8ffaf4e4dbb051ade52f4ee30497cbffa9f54`, port 5432)

---

## 1. Executive Summary & Purpose

This runbook documents the exact technical state, empirical discoveries, protocol limitations, and deployment procedures for Sofia's multichannel conversational assistant across **Telegram** and **WhatsApp (Evolution API v2.3.7 / Baileys)**.

The operator intends to clone this repository to a fresh VPS and develop the next iteration differently (e.g. evaluating official Meta Cloud API, decoupling the queue scheduler, or redesigning the conversational pipeline). This document serves as the complete handover record.

---

## 2. Channel Feature Parity Matrix

| Feature | Telegram | WhatsApp (Evolution v2.3.7 / Baileys) | Status / Notes |
|---|---|---|---|
| **Inbound Message Intake** | ✅ Production Active | ✅ Production Active | Both webhooks process text and attachments safely. |
| **Sliding Inbound Batching** | ✅ Working (25s / 60s cap) | ✅ Working (25s / 60s cap) | Groups sequential inbound messages into single prompt. Confirmed by user. |
| **Post-Generation Pacing** | ✅ Working (2–6s delay) | ✅ Working (2–6s delay) | Durable pacing calculated from UTF-16 code units; prevents instantaneous bot responses. |
| **Outbound Text Responses** | ✅ Working | ✅ Working | Sofia generates and delivers full RAG responses. |
| **Typing Indicator ("escribiendo…")** | ✅ Working (100% reliable) | ❌ Broken on WhatsApp clients | Telegram `sendChatAction('typing')` works. Evolution `/chat/sendPresence` returns HTTP 201, but Baileys presence updates are dropped/ignored by WhatsApp client devices. |
| **Catalog Opt-In Prompt** | ✅ Working (Inline Button) | ❌ Broken on WhatsApp clients | Telegram inline keyboard button works. Evolution `sendButtons` returns HTTP 201 but is dropped by WhatsApp (Meta blocks Baileys native flow buttons; Issue #2404). Text prompt + "1" confirmation failed live. |
| **Catalog Cards Delivery** | ✅ Working (Media Cards) | ⚠️ Code exists, but opt-in gate failed | `/message/sendMedia` works for isolated images, but end-to-end trigger via opt-in failed live. |

---

## 3. Deep Root-Cause Analysis: Why WhatsApp / Evolution Failed

### 3.1 Defect: WhatsApp Typing Presence Indicator
- **Application Level**: In commit `5342abe`, the presence capability check was switched from `provider.constructor.name === 'EvolutionProvider'` (which broke under Next.js production minification) to `provider.iniciarPresenca`. However, `iniciarPresenca` was omitted from the `EvolutionProvider` class definition in `apps/web/src/lib/whatsapp/evolution.ts`. Commit `210b52f` added `iniciarPresenca` to `EvolutionProvider`.
- **Protocol Level (Evolution / Baileys)**: When `startEvolutionPresence` calls Evolution's `/chat/sendPresence/${instance}` with `{ number, presence: 'composing', delay: 4000 }` and valid `Origin`, Evolution API returns HTTP 201 `{ presence: 'composing' }`.
- **WhatsApp Client Level (Meta)**: Despite Evolution returning 201, WhatsApp Android/iOS clients **did not display the typing indicator**. In Baileys, `client.presenceSubscribe(remoteJid)` and `client.sendPresenceUpdate('composing', remoteJid)` only render reliably when:
  1. The bot's phone number is saved in the recipient's phone contacts (bidirectional address book match).
  2. The recipient's WhatsApp Privacy Settings allow presence subscriptions from non-contacts.
  3. The addressing mode is standard JID (`@s.whatsapp.net`), not Privacy LID (`@lid`).
  For arbitrary numbers chatting with a WhatsApp Web instance, Meta silently ignores composing updates.

### 3.2 Defect: WhatsApp Interactive Catalog Buttons
- **Application Level**: The catalog opt-in originally called `enviarPromptCatalogoWhatsApp` via `/message/sendButtons`.
- **Upstream Evolution v2.3.7 Flaw**: Evolution API v2.3.7 wraps `sendButtons` in a `viewOnceMessage` containing an `interactiveMessage` with `nativeFlowMessage` (quick_reply).
- **Meta / WhatsApp Web Protocol Block**: Meta explicitly deprecated and blocks interactive native flow buttons and lists sent over non-official WhatsApp Web (Baileys) connections.
  - Evolution API GitHub Issue [#2404](https://github.com/EvolutionAPI/evolution-api/issues/2404): *"Button messages (sendButtons) return 201 but are never delivered to WhatsApp"*.
  - Evolution API GitHub PR [#2651](https://github.com/evolution-foundation/evolution-api/pull/2651): *"fix: interactive buttons not rendering (viewOnceMessage -> relayMessage)"*.
  - The message arrives at Evolution API, Evolution returns HTTP 201, stores the message as `PENDING` in `asados-evolution-db`, but WhatsApp servers never deliver it to the phone.
  - Because `route.ts` received 201 from Evolution, it returned `catalog_prompt_sent` and exited early without falling back to Sofia/RAG — leaving the customer with zero response.

### 3.3 Defect: Addressing Mode (`@lid` vs `@s.whatsapp.net`)
- Modern WhatsApp clients use Linked Identity (`@lid`) addressing modes (e.g. `120697674321960@lid`).
- Inbound messages arrive with `key.remoteJid = "...@lid"` and `key.remoteJidAlt = "...@s.whatsapp.net"`.
- All outbound messages sent to `@s.whatsapp.net` in the Evolution database remain in `status = PENDING` permanently because delivery acknowledgements are routed to the LID session.

---

## 4. Architectural Lessons for the New VPS Implementation

If you develop this differently on a new VPS, heed these architectural principles:

1. **Do not use Baileys / WhatsApp Web for Interactive Features**:
   - If you need interactive buttons, carousels, lists, or native flows on WhatsApp, use the **official Meta Cloud API** (WhatsApp Business API).
   - WhatsApp Web / Baileys is only suitable for plain text, images, documents, and audio. Interactive native flows are actively fought and dropped by Meta on unofficial connections.
2. **Never inspect `constructor.name` in production TypeScript / Next.js**:
   - Production bundlers (Next.js/Turbopack/Webpack) rename classes during minification (`EvolutionProvider` becomes `q`).
   - Use explicit capability probes (`typeof provider.iniciarPresenca === 'function'`) or typed discriminating tags (`provider.kind === 'evolution'`).
3. **Evolution API CORS Invariant**:
   - Evolution API v2.3.7 has a custom CORS callback that rejects any request without an allowed `Origin` header (HTTP 500 `"Not allowed by CORS"`).
   - Every internal HTTP request from the web app container to Evolution MUST send:
     ```ts
     headers: {
       'apikey': apiKey,
       'Content-Type': 'application/json',
       'Origin': process.env.NEXT_PUBLIC_APP_URL || 'https://crmsofiamanager.duckdns.org',
     }
     ```
4. **Decouple Queue Scheduler from Web Container**:
   - Currently, `asados-sofia-inbound-batch-maintenance` (an Alpine container) curls `asados-web:3000/api/internal/sofia/inbound-batches/maintenance` every 2 seconds.
   - Recreating the `web` container temporarily interrupts this loop.
   - In a new design, consider running a standalone queue worker process (e.g. BullMQ, PgBoss, or a dedicated Go/Node daemon) directly against Postgres/Redis.

---

## 5. Security Incident Record (Credentials to Rotate)

During a prior diagnostic audit, an over-broad allowlist grep pattern `[A-Z_]+` matched non-boolean keys and printed credential values in the terminal log. The following internal secrets **must be rotated** before/during VPS redeployment:

| Secret Key | Service Affected | Location in `.env` |
|---|---|---|
| `NOTIFICATION_OUTBOX_MAINTENANCE_SECRET` | Notification maintenance scheduler | `.env` |
| `PAYMENT_PROOF_MAINTENANCE_SECRET` | Payment proof maintenance scheduler | `.env` |
| `PAYMENT_PROOF_METRICS_SECRET` | Internal payment proof metrics endpoint | `.env` |

**Safe reading rule for gates**: Always filter strictly on suffix `_ENABLED=`:
```bash
grep '_ENABLED=' .env
# OR inside container:
printenv | grep '_ENABLED='
```

---

## 6. Current Production Deployment State

### 6.1 Container Stack (`docker compose ps`)
- `asados-web`: Image `asados-web:evolution-text-optin-303a757-20260916T010928Z` (Port `127.0.0.1:3020:3000`)
- `asados-sofia-inbound-batch-maintenance`: Loop scheduler (Alpine 3.20)
- `asados-evolution-api`: Evolution v2.3.7 (Port `8080`)
- `asados-evolution-db`: Postgres 16 Alpine
- `asados-evolution-redis`: Redis
- `asados-supabase-db`: Primary PostgreSQL container (`0bff70962b42...`)

### 6.2 Active Feature Gates (4 true / 12 false)
- `SOFIA_INBOUND_BATCH_EVOLUTION_ENQUEUE_ENABLED=true`
- `SOFIA_INBOUND_BATCH_PROCESSING_ENABLED=true`
- `SOFIA_INBOUND_BATCH_RUNTIME_ENABLED=true`
- `SOFIA_INBOUND_BATCH_TELEGRAM_ENQUEUE_ENABLED=true`
- All 8 payment proof gates: `false`
- All 4 notification gates: `false`

### 6.3 Deployment & Rollback Levers
- Deploy state file: `/var/lib/asados/deploy/release.env`
- Rollback command: `/home/wilkin/proyectos/Asados/scripts/deploy-web.sh rollback`
- Immediate kill switch for Evolution queue without redeploying:
  Set `SOFIA_INBOUND_BATCH_EVOLUTION_ENQUEUE_ENABLED=false` in `.env` and run `docker compose up -d --no-deps --force-recreate web`.

### 6.4 Shedding and Restoring AI Generation (`SOFIA_AI_GENERATION_ENABLED`)

The generation entry point reads `SOFIA_AI_GENERATION_ENABLED` on every inbound message and only the exact value `false` disables Sofia's conversational generation. Purpose: shed that generation during a DeepSeek outage or a bad rollout without a code change, sending no provider request instead of paying the provider timeout on every inbound message. Outside mock-mode environments it then fails closed at once — `IA_INDISPONIVEL` for a channel message and `SOFIA_BATCH_GENERATION_FAILED` for the batch pipeline — and never dispatches an empty answer; under `NODE_ENV=development` or `test`, where the integration mock is allowed, the disabled switch takes the pipeline's existing contingency branch and answers with the mock text instead. The switch covers Sofia's conversational generation only: the payment-proof advisory and the JSON extraction call DeepSeek under their own gates and are unaffected. Shed it with `SOFIA_AI_GENERATION_ENABLED=false` in the service environment (`.env`) plus `docker compose up -d --no-deps --force-recreate web`, and restore it by removing the variable (or setting `true`) and recreating `web` the same way. The disabled path logs `GERACAO_DESABILITADA` together with the switch name, so the `_ENABLED=` reading rule of section 5 applies. `.env.example` is not updated in this unit: the safety policy refuses that path and the maintainer adds those entries in a later unit, so the variable only needs to exist in the deployment environment.
