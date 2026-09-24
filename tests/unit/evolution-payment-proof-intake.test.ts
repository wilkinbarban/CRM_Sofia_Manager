import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(), obterConfiguracaoSistema: vi.fn(), obterSofiaGlobalChannelConfig: vi.fn(),
  verificarHorarioAtendimento: vi.fn(), ingestEvolutionCanonicalPaymentProof: vi.fn(), downloadEvolutionMedia: vi.fn(),
  gates: { canonicalIngest: { effective: true }, whatsappIngest: { effective: true } },
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: mocks.createAdminClient }))
vi.mock('@/lib/config/sistema', () => ({ obterConfiguracaoSistema: mocks.obterConfiguracaoSistema, obterSofiaGlobalChannelConfig: mocks.obterSofiaGlobalChannelConfig }))
vi.mock('@/lib/horarios/verificar', () => ({ verificarHorarioAtendimento: mocks.verificarHorarioAtendimento }))
vi.mock('@/lib/payment-proofs/canonical-intake', () => ({ ingestEvolutionCanonicalPaymentProof: mocks.ingestEvolutionCanonicalPaymentProof }))
vi.mock('@/lib/whatsapp/evolution-media-download', () => ({ downloadEvolutionMedia: mocks.downloadEvolutionMedia }))
vi.mock('@/lib/payment-proofs/operational-gates', () => ({ paymentProofOperationalGates: mocks.gates }))

import { POST } from '@/app/api/webhooks/evolution/route'
import { EVOLUTION_PAYMENT_PROOF_FIXTURE_SHA256, EVOLUTION_PAYMENT_PROOF_PROFILE } from '@/lib/whatsapp/evolution-payment-proof-compatibility'
import messagesUpsertDocumentFixture from '../fixtures/evolution/messages-upsert-document-v2.3.7.sanitized.json'

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])
const config: Record<string, string> = {
  EVOLUTION_WEBHOOK_SECRET: 'webhook-secret', EVOLUTION_API_KEY: 'api-key', EVOLUTION_API_URL: 'https://evolution.test', EVOLUTION_INSTANCE_NAME: 'main',
  PAYMENT_PROOF_CANONICAL_INGEST_ENABLED: 'true', WHATSAPP_PAYMENT_PROOF_INGEST_ENABLED: 'true', PROVEDOR_WHATSAPP_ATIVO: 'evolution', WHATSAPP_PROVIDER: 'meta',
  EVOLUTION_PAYMENT_PROOF_ATTESTATION: JSON.stringify({
    release: 'v2.3.7', profile: EVOLUTION_PAYMENT_PROOF_PROFILE,
    fixtureSha256: EVOLUTION_PAYMENT_PROOF_FIXTURE_SHA256, attestedAt: new Date().toISOString(),
  }),
}
function request(
  headers: HeadersInit = { 'x-webhook-secret': 'webhook-secret' },
  mime?: unknown,
  key: Record<string, unknown> = { id: 'message-77', fromMe: false, remoteJid: '5541999990003@s.whatsapp.net' },
  fileLength: unknown = PDF.length,
) {
  const declaredMime = arguments.length < 2 ? 'application/pdf' : mime
  return new Request('https://asados.test/api/webhooks/evolution', { method: 'POST', headers, body: JSON.stringify({
    event: 'messages.upsert', instance: 'main', data: { key, pushName: 'Ana', message: { documentMessage: { mimetype: declaredMime, fileLength } } },
  }) })
}
function imageRequest(mime = 'image/png') {
  return new Request('https://asados.test/api/webhooks/evolution', { method: 'POST', headers: { 'x-webhook-secret': 'webhook-secret' }, body: JSON.stringify({
    event: 'messages.upsert', instance: 'main', data: { key: { id: 'image-77', fromMe: false, remoteJid: '5541999990003@s.whatsapp.net' }, pushName: 'Ana', message: { imageMessage: { mimetype: mime, fileLength: PDF.length } } },
  }) })
}
function textRequest(headers: HeadersInit = { apikey: 'api-key' }) {
  return new Request('https://asados.test/api/webhooks/evolution', { method: 'POST', headers, body: JSON.stringify({
    event: 'messages.upsert', data: { key: { id: 'text-77', fromMe: false, remoteJid: '5541999990003@s.whatsapp.net' }, message: { conversation: 'oi' } },
  }) })
}
function adminClient(options: { deliveryState?: unknown; deliveryStateError?: boolean; identityDestination?: unknown; identityDestinationError?: boolean } = {}) {
  const storageBucket = { upload: vi.fn(), remove: vi.fn() }
  const client: any = { storage: { from: vi.fn(() => storageBucket) }, rpc: vi.fn(async (name: string) => {
    if (name === 'get_payment_proof_delivery_state') return {
      data: options.deliveryState === undefined ? { state: 'missing' } : options.deliveryState,
      error: options.deliveryStateError ? { message: 'private rpc detail' } : null,
    }
    if (name === 'resolve_evolution_payment_proof_identity_destination') return {
      data: options.identityDestination === undefined ? [{ customer_id: '11111111-1111-4111-8111-111111111111', conversation_id: '22222222-2222-4222-8222-222222222222' }] : options.identityDestination,
      error: options.identityDestinationError ? { message: 'private rpc detail' } : null,
    }
    return { data: null, error: null }
  }), from: vi.fn((table: string) => {
    const builder: any = {
      select: vi.fn(() => builder), eq: vi.fn(() => builder), order: vi.fn(() => builder), limit: vi.fn(() => builder), insert: vi.fn(() => builder),
      maybeSingle: vi.fn(async () => ({ data: null, error: null })),
      single: vi.fn(async () => ({ data: { id: `${table}-1` }, error: null })),
    }
    return builder
  }) }
  return { client, storageBucket }
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.gates.canonicalIngest.effective = true; mocks.gates.whatsappIngest.effective = true; mocks.obterConfiguracaoSistema.mockImplementation(async (key: string) => config[key] ?? null)
  mocks.downloadEvolutionMedia.mockResolvedValue({ ok: true, bytes: PDF, mimeType: 'application/pdf' })
  mocks.ingestEvolutionCanonicalPaymentProof.mockResolvedValue({ status: 'accepted', proofId: 'proof-1' })
})

describe('Evolution canonical payment-proof intake', () => {
  it('routes a dedicated-secret PNG image directly to canonical intake', async () => {
    const { client, storageBucket } = adminClient(); mocks.createAdminClient.mockReturnValue(client)
    mocks.downloadEvolutionMedia.mockResolvedValue({ ok: true, bytes: PDF, mimeType: 'image/png' })

    const response = await POST(imageRequest())

    expect(response.status).toBe(202)
    expect(client.from).not.toHaveBeenCalledWith('mensagens')
    expect(mocks.downloadEvolutionMedia).toHaveBeenCalledWith(expect.objectContaining({ declaredMimeType: 'image/png', declaredSize: PDF.length }))
    expect(mocks.ingestEvolutionCanonicalPaymentProof).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: 'evolution:main:image-77', bytes: PDF, mimeType: 'image/png', storage: storageBucket }))
  })

  it('rejects unsupported dedicated-secret image formats before download or persistence', async () => {
    const { client } = adminClient(); mocks.createAdminClient.mockReturnValue(client)
    const response = await POST(imageRequest('image/webp'))

    expect(response.status).toBe(422)
    expect(mocks.downloadEvolutionMedia).not.toHaveBeenCalled()
    expect(mocks.ingestEvolutionCanonicalPaymentProof).not.toHaveBeenCalled()
    expect(client.from).not.toHaveBeenCalled()
  })
  it.each([
    ['object', { valueOf: (): string => 'message-77' }], ['array', ['message-77']], ['number', 77], ['empty', ''], ['trimmed', ' message-77 '], ['control', 'message-\u0001-77'], ['oversized', 'a'.repeat(257)],
  ])('rejects dedicated-secret document candidates with an invalid delivery ID (%s) before admin or downstream work', async (_name, id) => {
    const { client } = adminClient(); mocks.createAdminClient.mockReturnValue(client)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const response = await POST(request(undefined, 'application/pdf', { id, fromMe: false, remoteJid: '5541999990003@s.whatsapp.net' }))
    expect(response.status).toBe(422); expect(await response.json()).toEqual({ success: false, status: 'payment_proof_rejected' })
    expect(mocks.createAdminClient).not.toHaveBeenCalled(); expect(client.from).not.toHaveBeenCalled(); expect(client.rpc).not.toHaveBeenCalled()
    expect(mocks.downloadEvolutionMedia).not.toHaveBeenCalled(); expect(mocks.ingestEvolutionCanonicalPaymentProof).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[Evolution Webhook] CANONICAL_ENVELOPE_REJECTED'); warn.mockRestore()
  })

  it.each([
    ['truthy fromMe', { id: 'message-77', fromMe: 'false', remoteJid: '5541999990003@s.whatsapp.net' }, { documentMessage: { mimetype: 'application/pdf', fileLength: PDF.length } }],
    ['array key', [], { documentMessage: { mimetype: 'application/pdf', fileLength: PDF.length } }],
    ['array message', { id: 'message-77', fromMe: false, remoteJid: '5541999990003@s.whatsapp.net' }, []],
    ['array document', { id: 'message-77', fromMe: false, remoteJid: '5541999990003@s.whatsapp.net' }, { documentMessage: [] }],
  ])('rejects malformed dedicated-secret canonical envelopes (%s) before admin or downstream work', async (_name, key, message) => {
    const { client } = adminClient(); mocks.createAdminClient.mockReturnValue(client)
    const payload = { event: 'messages.upsert', instance: 'main', data: { key, message } }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const response = await POST(new Request('https://asados.test/api/webhooks/evolution', { method: 'POST', headers: { 'x-webhook-secret': 'webhook-secret' }, body: JSON.stringify(payload) }))
    expect(response.status).toBe(422); expect(await response.json()).toEqual({ success: false, status: 'payment_proof_rejected' })
    expect(mocks.createAdminClient).not.toHaveBeenCalled(); expect(client.from).not.toHaveBeenCalled(); expect(client.rpc).not.toHaveBeenCalled()
    expect(mocks.downloadEvolutionMedia).not.toHaveBeenCalled(); expect(mocks.ingestEvolutionCanonicalPaymentProof).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[Evolution Webhook] CANONICAL_ENVELOPE_REJECTED'); warn.mockRestore()
  })

  it('accepts a 256-byte dedicated-secret canonical delivery ID', async () => {
    const { client } = adminClient(); mocks.createAdminClient.mockReturnValue(client)
    const response = await POST(request(undefined, 'application/pdf', { id: 'a'.repeat(256), fromMe: false, remoteJid: '5541999990003@s.whatsapp.net' }))
    expect(response.status).toBe(202); expect(client.rpc).toHaveBeenCalledWith('get_payment_proof_delivery_state', { p_channel: 'whatsapp', p_delivery_key: `evolution:main:${'a'.repeat(256)}` })
  })

  it('authenticates before parsing, blocks API-key documents when WhatsApp intake is open, and preserves API-key text legacy behavior', async () => {
    const malformed: any = { headers: new Headers(), json: vi.fn() }
    const response = await POST(malformed)
    expect(response.status).toBe(401); expect(malformed.json).not.toHaveBeenCalled()

    const { client } = adminClient(); mocks.createAdminClient.mockReturnValue(client); mocks.obterSofiaGlobalChannelConfig.mockResolvedValue({ enabled: false })
    const documentResponse = await POST(request({ apikey: 'api-key' }))
    expect(documentResponse.status).toBe(401); expect(await documentResponse.json()).toEqual({ error: 'Unauthorized' })
    expect(mocks.createAdminClient).not.toHaveBeenCalled(); expect(client.from).not.toHaveBeenCalled()
    expect(mocks.downloadEvolutionMedia).not.toHaveBeenCalled(); expect(mocks.ingestEvolutionCanonicalPaymentProof).not.toHaveBeenCalled()

    const textResponse = await POST(textRequest())
    expect(textResponse.status).toBe(200); expect(client.from).toHaveBeenCalledWith('mensagens')
  })

  it.each([
    ['provider', () => { config.PROVEDOR_WHATSAPP_ATIVO = 'meta' }],
    ['invalid attestation', () => { config.EVOLUTION_PAYMENT_PROOF_ATTESTATION = 'invalid' }],
    ['stale attestation', () => { config.EVOLUTION_PAYMENT_PROOF_ATTESTATION = JSON.stringify({ release: 'v2.3.7', profile: EVOLUTION_PAYMENT_PROOF_PROFILE, fixtureSha256: EVOLUTION_PAYMENT_PROOF_FIXTURE_SHA256, attestedAt: '2000-01-01T00:00:00.000Z' }) }],
  ])('fails closed for dedicated-secret documents with %s compatibility before admin, persistence, or media', async (_name, arrange) => {
    const originalProvider = config.PROVEDOR_WHATSAPP_ATIVO
    const originalAttestation = config.EVOLUTION_PAYMENT_PROOF_ATTESTATION
    arrange()
    const { client } = adminClient(); mocks.createAdminClient.mockReturnValue(client)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const response = await POST(request())
    expect(response.status).toBe(422); expect(await response.json()).toEqual({ success: false, status: 'payment_proof_rejected' })
    expect(mocks.createAdminClient).not.toHaveBeenCalled(); expect(client.from).not.toHaveBeenCalled(); expect(client.rpc).not.toHaveBeenCalled()
    expect(mocks.downloadEvolutionMedia).not.toHaveBeenCalled(); expect(mocks.ingestEvolutionCanonicalPaymentProof).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[Evolution Webhook] CANONICAL_COMPATIBILITY_REJECTED')
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining(_name)); warn.mockRestore()
    config.PROVEDOR_WHATSAPP_ATIVO = originalProvider; config.EVOLUTION_PAYMENT_PROOF_ATTESTATION = originalAttestation
  })

  it('rejects an open canonical PDF candidate with a structurally invalid sender before any persistence or download', async () => {
    const { client } = adminClient(); mocks.createAdminClient.mockReturnValue(client)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const response = await POST(request(undefined, 'application/pdf', { id: 'message-77', fromMe: false, remoteJid: 'invalid-sender' }))

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ success: false, status: 'payment_proof_rejected' })
    expect(client.from).not.toHaveBeenCalled()
    expect(mocks.downloadEvolutionMedia).not.toHaveBeenCalled()
    expect(mocks.ingestEvolutionCanonicalPaymentProof).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[Evolution Webhook] CANONICAL_SENDER_REJECTED')
    warn.mockRestore()
  })

  it.each([undefined, '', 'unconfigured-instance'])('rejects an open canonical PDF candidate with a missing or mismatched instance before any persistence or download', async (instance) => {
    const { client } = adminClient(); mocks.createAdminClient.mockReturnValue(client)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const payload = JSON.parse(JSON.stringify(messagesUpsertDocumentFixture))
    payload.instance = instance; payload.data.key.remoteJid = '5541999990003@s.whatsapp.net'; payload.data.key.remoteJidAlt = '5541999990003@s.whatsapp.net'

    const response = await POST(new Request('https://asados.test/api/webhooks/evolution', {
      method: 'POST', headers: { 'x-webhook-secret': 'webhook-secret' }, body: JSON.stringify(payload),
    }))

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ success: false, status: 'payment_proof_rejected' })
    expect(client.from).not.toHaveBeenCalled()
    expect(mocks.downloadEvolutionMedia).not.toHaveBeenCalled()
    expect(mocks.ingestEvolutionCanonicalPaymentProof).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[Evolution Webhook] CANONICAL_INSTANCE_REJECTED')
    warn.mockRestore()
  })

  it.each([
    ['queued', { state: 'queued' }, 200, 'payment_proof_duplicate'], ['complete', { state: 'complete' }, 200, 'payment_proof_duplicate'],
    ['repairable', { state: 'repairable' }, 422, 'payment_proof_rejected'], ['missing', { state: 'missing' }, 202, 'payment_proof_received'],
    ['RPC error', { state: 'missing' }, 503, 'payment_proof_retryable', true], ['unexpected', { state: 'future' }, 503, 'payment_proof_retryable'],
    ['legacy string', 'missing', 503, 'payment_proof_retryable'], ['malformed object', {}, 503, 'payment_proof_retryable'],
  ])('short-circuits delivery state %s before persistence or media work', async (_case, deliveryState, status, resultStatus, deliveryStateError = false) => {
    const { client } = adminClient({ deliveryState, deliveryStateError }); mocks.createAdminClient.mockReturnValue(client)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const response = await POST(request())
    expect(response.status).toBe(status); expect(await response.json()).toEqual({ success: status < 300, status: resultStatus })
    expect(client.rpc).toHaveBeenCalledWith('get_payment_proof_delivery_state', { p_channel: 'whatsapp', p_delivery_key: 'evolution:main:message-77' })
    if (status === 202) {
      expect(mocks.ingestEvolutionCanonicalPaymentProof).toHaveBeenCalled()
    } else {
      expect(client.from).not.toHaveBeenCalled(); expect(mocks.downloadEvolutionMedia).not.toHaveBeenCalled(); expect(mocks.ingestEvolutionCanonicalPaymentProof).not.toHaveBeenCalled()
    }
    if (status === 503) expect(warn).toHaveBeenCalledWith('[Evolution Webhook] CANONICAL_503_DELIVERY_STATE')
    if (status === 422) expect(warn).toHaveBeenCalledWith('[Evolution Webhook] CANONICAL_DELIVERY_PROVENANCE_INCOMPLETE')
    warn.mockRestore()
  })

  it('routes the sanitized Evolution 2.3.7 MESSAGES_UPSERT document fixture directly to canonical intake', async () => {
    const { client, storageBucket } = adminClient(); mocks.createAdminClient.mockReturnValue(client)
    const payload = JSON.parse(JSON.stringify(messagesUpsertDocumentFixture))
    payload.instance = 'main'; payload.data.key.id = 'fixture-message-77'; payload.data.key.remoteJid = '5541999990003@s.whatsapp.net'; payload.data.key.remoteJidAlt = '5541999990003@s.whatsapp.net'; payload.data.message.documentMessage.fileLength = PDF.length

    const response = await POST(new Request('https://asados.test/api/webhooks/evolution', {
      method: 'POST', headers: { 'x-webhook-secret': 'webhook-secret' }, body: JSON.stringify(payload),
    }))

    expect(response.status).toBe(202)
    expect(client.from).not.toHaveBeenCalledWith('mensagens')
    expect(client.from).not.toHaveBeenCalledWith('comprovantes')
    expect(client.rpc).not.toHaveBeenCalledWith('resolve_evolution_payment_proof_identity_destination', expect.anything())
    expect(mocks.downloadEvolutionMedia).toHaveBeenCalledWith(expect.objectContaining({ instanceName: 'main' }))
    expect(mocks.ingestEvolutionCanonicalPaymentProof).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: 'evolution:main:fixture-message-77', sender: '5541999990003', displayName: 'Sanitized Contact', bytes: PDF, storage: storageBucket }))
  })

  it('routes a compatible PDF with a Long-shaped size directly to canonical intake without legacy message dedupe', async () => {
    const { client, storageBucket } = adminClient(); mocks.createAdminClient.mockReturnValue(client)
    const response = await POST(request(undefined, 'application/pdf', undefined, { low: PDF.length, high: 0, unsigned: true }))
    expect(response.status).toBe(202); expect(await response.json()).toEqual({ success: true, status: 'payment_proof_received' })
    expect(client.from).not.toHaveBeenCalledWith('mensagens')
    expect(mocks.downloadEvolutionMedia).toHaveBeenCalledWith(expect.objectContaining({ instanceName: 'main', declaredMimeType: 'application/pdf', declaredSize: PDF.length }))
    expect(mocks.ingestEvolutionCanonicalPaymentProof).toHaveBeenCalledWith(expect.objectContaining({ channel: 'whatsapp', deliveryId: 'evolution:main:message-77', orderId: null, sender: '5541999990003', displayName: 'Ana', bytes: PDF, db: client, storage: storageBucket }))
  })

  it('rejects a noncanonical document size before download with only a static marker', async () => {
    const { client } = adminClient(); mocks.createAdminClient.mockReturnValue(client)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const response = await POST(request(undefined, 'application/pdf', undefined, { low: PDF.length, high: 0, unsigned: true, extra: 'private' }))
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ success: false, status: 'payment_proof_rejected' })
    expect(mocks.downloadEvolutionMedia).not.toHaveBeenCalled()
    expect(mocks.ingestEvolutionCanonicalPaymentProof).not.toHaveBeenCalled()
    expect(client.from).not.toHaveBeenCalledWith('mensagens')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[Evolution Webhook] CANONICAL_DOCUMENT_SIZE_REJECTED')
    warn.mockRestore()
  })

  it('routes an Evolution 2.3.7 LID sender through its structurally valid phone alternate', async () => {
    const { client } = adminClient(); mocks.createAdminClient.mockReturnValue(client)
    const response = await POST(request(undefined, 'application/pdf', {
      id: 'message-77', fromMe: false, addressingMode: 'lid',
      remoteJid: '123456789012345@lid', remoteJidAlt: '5541999990003@s.whatsapp.net',
    }))
    expect(response.status).toBe(202)
    expect(mocks.ingestEvolutionCanonicalPaymentProof).toHaveBeenCalledWith(expect.objectContaining({ sender: '5541999990003' }))
  })

  it.each([
    ['CANONICAL_503_EVOLUTION_CONFIG', () => adminClient(), () => mocks.obterConfiguracaoSistema.mockImplementation(async (key: string) => key === 'EVOLUTION_API_URL' ? null : config[key] ?? null), mocks.downloadEvolutionMedia],
    ['CANONICAL_503_MEDIA_TIMEOUT', () => adminClient(), () => mocks.downloadEvolutionMedia.mockResolvedValue({ ok: false, error: 'EVOLUTION_MEDIA_DOWNLOAD_TIMEOUT', retryable: true }), mocks.ingestEvolutionCanonicalPaymentProof],
    ['CANONICAL_503_PROCESSING', () => adminClient(), () => mocks.ingestEvolutionCanonicalPaymentProof.mockResolvedValue({ status: 'retryable' }), vi.fn()],
  ])('returns the canonical 503 body with only static marker %s and stops later work', async (marker, makeAdmin, arrange, laterStage) => {
    const { client } = makeAdmin(); mocks.createAdminClient.mockReturnValue(client); arrange()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const response = await POST(request())
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ success: false, status: 'payment_proof_retryable' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(`[Evolution Webhook] ${marker}`)
    expect(laterStage).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it.each([
    ['EVOLUTION_MEDIA_HTTP_UPSTREAM', 'CANONICAL_503_MEDIA_UPSTREAM'],
    ['EVOLUTION_MEDIA_NETWORK', 'CANONICAL_503_MEDIA_NETWORK'],
    ['EVOLUTION_MEDIA_DOWNLOAD_TIMEOUT', 'CANONICAL_503_MEDIA_TIMEOUT'],
    ['EVOLUTION_MEDIA_FUTURE_RETRYABLE', 'CANONICAL_503_MEDIA_UNKNOWN'],
  ])('maps retryable media category %s to exact static marker %s and stops processing', async (error, marker) => {
    const { client } = adminClient(); mocks.createAdminClient.mockReturnValue(client)
    mocks.downloadEvolutionMedia.mockResolvedValue({ ok: false, error, retryable: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const response = await POST(request())

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ success: false, status: 'payment_proof_retryable' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(`[Evolution Webhook] ${marker}`)
    expect(mocks.ingestEvolutionCanonicalPaymentProof).not.toHaveBeenCalled()
    expect(client.from).not.toHaveBeenCalledWith('mensagens')
    warn.mockRestore()
  })

  it.each([
    'EVOLUTION_MEDIA_HTTP_AUTH',
    'EVOLUTION_MEDIA_HTTP_CONTRACT',
    'EVOLUTION_MEDIA_HTTP_UNEXPECTED',
    'EVOLUTION_MEDIA_MIME_INVALID',
  ])('rejects non-retryable media category %s generically without logging or later processing', async (error) => {
    const { client } = adminClient(); mocks.createAdminClient.mockReturnValue(client)
    mocks.downloadEvolutionMedia.mockResolvedValue({ ok: false, error, retryable: false })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const response = await POST(request())

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ success: false, status: 'payment_proof_rejected' })
    expect(warn).not.toHaveBeenCalled()
    expect(errorLog).not.toHaveBeenCalled()
    expect(mocks.ingestEvolutionCanonicalPaymentProof).not.toHaveBeenCalled()
    expect(client.from).not.toHaveBeenCalledWith('mensagens')
    warn.mockRestore()
    errorLog.mockRestore()
  })

  it.each([
    [{ status: 'duplicate' }, 200, 'payment_proof_duplicate'], [{ status: 'accepted' }, 202, 'payment_proof_received'], [{ status: 'retryable' }, 503, 'payment_proof_retryable'], [{ status: 'rejected' }, 422, 'payment_proof_rejected'],
  ])('maps canonical outcomes without approval or order association', async (processed, status, resultStatus) => {
    const { client } = adminClient(); mocks.createAdminClient.mockReturnValue(client); mocks.ingestEvolutionCanonicalPaymentProof.mockResolvedValue(processed)
    const response = await POST(request()); expect(response.status).toBe(status); expect(await response.json()).toEqual({ success: status < 300, status: resultStatus })
  })

  it('does not admit a PDF when immutable gates are closed despite DB values being open', async () => {
    const { client } = adminClient(); mocks.createAdminClient.mockReturnValue(client)
    mocks.gates.canonicalIngest.effective = false
    mocks.obterSofiaGlobalChannelConfig.mockResolvedValue({ enabled: false })
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(mocks.downloadEvolutionMedia).not.toHaveBeenCalled()
    expect(mocks.ingestEvolutionCanonicalPaymentProof).not.toHaveBeenCalled()
    expect(mocks.obterConfiguracaoSistema).not.toHaveBeenCalledWith('PAYMENT_PROOF_CANONICAL_INGEST_ENABLED')
    expect(mocks.obterConfiguracaoSistema).not.toHaveBeenCalledWith('WHATSAPP_PAYMENT_PROOF_INGEST_ENABLED')
  })

  it('makes no media request when compatibility is closed and follows the exact legacy path', async () => {
    const { client } = adminClient(); mocks.createAdminClient.mockReturnValue(client)
    mocks.gates.whatsappIngest.effective = false
    mocks.obterSofiaGlobalChannelConfig.mockResolvedValue({ enabled: false })
    const response = await POST(request()); expect(response.status).toBe(200); expect((await response.json()).message).toBe('Sofia globalmente desativada para WhatsApp')
    expect(mocks.downloadEvolutionMedia).not.toHaveBeenCalled(); expect(mocks.ingestEvolutionCanonicalPaymentProof).not.toHaveBeenCalled(); expect(client.from).toHaveBeenCalledWith('mensagens')
  })

  it('never writes an Evolution payment document to the legacy proof table when canonical compatibility is closed', async () => {
    const { client } = adminClient(); mocks.createAdminClient.mockReturnValue(client)
    mocks.gates.whatsappIngest.effective = false
    mocks.obterSofiaGlobalChannelConfig.mockResolvedValue({ enabled: true })
    mocks.verificarHorarioAtendimento.mockResolvedValue({ dentro: true })

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(client.from).not.toHaveBeenCalledWith('comprovantes')
  })

  it.each([undefined, null, 'application/zip'])('rejects an open dedicated-secret document with invalid MIME before table or media work', async (mime) => {
    const { client } = adminClient(); mocks.createAdminClient.mockReturnValue(client)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const response = await POST(request(undefined, mime))

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ success: false, status: 'payment_proof_rejected' })
    expect(client.from).not.toHaveBeenCalled()
    expect(mocks.downloadEvolutionMedia).not.toHaveBeenCalled()
    expect(mocks.ingestEvolutionCanonicalPaymentProof).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[Evolution Webhook] CANONICAL_DOCUMENT_MIME_REJECTED')
    warn.mockRestore()
  })

  it('accepts case- and whitespace-normalized PDF MIME at the download boundary', async () => {
    const { client } = adminClient(); mocks.createAdminClient.mockReturnValue(client)
    const response = await POST(request(undefined, ' Application/PDF '))
    expect(response.status).toBe(202)
    expect(mocks.downloadEvolutionMedia).toHaveBeenCalledWith(expect.objectContaining({ declaredMimeType: 'application/pdf' }))
  })

  it.each([
    ['closed compatibility', { 'x-webhook-secret': 'webhook-secret' }, () => { mocks.gates.whatsappIngest.effective = false }],
    ['WhatsApp intake gate closed with legacy API-key authentication', { apikey: 'api-key' }, () => { mocks.gates.whatsappIngest.effective = false }],
  ])('keeps invalid documents on the legacy path with %s', async (_boundary, headers, arrange) => {
    const { client } = adminClient(); mocks.createAdminClient.mockReturnValue(client)
    mocks.obterSofiaGlobalChannelConfig.mockResolvedValue({ enabled: false }); arrange()

    const response = await POST(request(headers, 'image/png'))

    expect(response.status).toBe(200)
    expect(client.from).toHaveBeenCalledWith('mensagens')
    expect(mocks.downloadEvolutionMedia).not.toHaveBeenCalled()
    expect(mocks.ingestEvolutionCanonicalPaymentProof).not.toHaveBeenCalled()
  })
})
