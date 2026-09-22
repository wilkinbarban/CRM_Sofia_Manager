import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => fs.readFileSync(path, 'utf8')

describe('validated security boundary regressions', () => {
  it('does not accept Evolution secrets from URLs', () => {
    const source = read('apps/web/src/app/api/webhooks/evolution/route.ts')
    expect(source).not.toContain("searchParams.get('webhook_secret')")
  })

  it('uses an authenticated instance webhook instead of an unauthenticated global webhook', () => {
    const compose = read('docker-compose.yml')
    expect(compose).toContain('WEBHOOK_GLOBAL_ENABLED=false')
    expect(compose).not.toContain('WEBHOOK_GLOBAL_URL=')
    expect(compose).not.toContain('?webhook_secret=')
    const provisioner = read('ops/configure-evolution-webhook.sh')
    expect(provisioner).toContain('/webhook/set/${instance}')
    expect(provisioner).toContain('"x-webhook-secret": process.env.EVOLUTION_WEBHOOK_SECRET')
  })

  it('verifies Evolution with a header secret instead of a URL secret', () => {
    const verifier = read('ops/verify-integrations.sh')
    expect(verifier).toContain('-H "x-webhook-secret: $webhook_secret"')
    expect(verifier).not.toContain('?webhook_secret=')
  })

  it('bounds WhatsApp media downloads', () => {
    const source = read('apps/web/src/app/api/webhooks/whatsapp/route.ts')
    expect(source).toContain('MAX_WHATSAPP_MEDIA_BYTES')
    expect(source).toContain('readBoundedResponseBody')
    const evolution = read('apps/web/src/lib/whatsapp/evolution-media-download.ts')
    expect(evolution).toContain('MAX_EVOLUTION_PDF_BYTES')
    expect(evolution).toContain("redirect: 'error'")
    expect(evolution).not.toMatch(/console\.(?:log|warn|error)/)
  })

  it('bounds the legacy LLM fallback', () => {
    const source = read('apps/web/src/lib/ai/openrouter.ts')
    expect(source).toContain('LEGACY_LLM_MAX_RESPONSE_BYTES')
    expect(source).toContain('maxTokens: LEGACY_LLM_MAX_TOKENS')
    // The byte cap is enforced by the DeepSeek boundary the generation path now
    // delegates to: the declared length is rejected up front and an oversized
    // stream cancels the reader instead of buffering the whole body.
    const boundary = read('apps/web/src/lib/ai/deepseek.ts')
    expect(boundary).toContain('maxResponseBytes')
    expect(boundary).toContain('reader.cancel()')
  })

  it('ships forward-only database hardening', () => {
    const sofia = read('supabase/migrations/20260828100000_sofia_handoff_authorization.sql')
    expect(sofia).toContain("and p.ativo")
    expect(sofia).toContain("set search_path = ''")
    const receipts = read('supabase/migrations/20260828101000_comprovantes_active_staff_rls.sql')
    expect(receipts).toContain('p.ativo')
  })
})
