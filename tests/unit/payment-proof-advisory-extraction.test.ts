// @vitest-environment node

/**
 * Payment-proof visual advisory extraction.
 *
 * The advisory runs through the single DeepSeek boundary: JSON travels as
 * `response_format: json_object` plus an explicit prompt instruction, an image
 * travels as a `user` content part, and a non-vision model is pinned to the
 * DeepSeek default. Every branch stays advisory-only — `approved: false` and a
 * visual input is always `manual_review` — and no credential or document content
 * can reach an error or a persisted result.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEEPSEEK_CHAT_COMPLETIONS_URL,
  DEEPSEEK_DEFAULT_MODEL,
} from '@/lib/ai/deepseek'
import { classifyPaymentProof } from '@/lib/payment-proofs/advisory-extraction'

const KEY = 'sk-deepseek-secret-advisory-key'
const DOCUMENT_MARKER = 'COMPROVANTE_TEXTO_INTEGRAL_MARKER'
const image = 'data:image/png;base64,iVBORw0KGgo='
const answer = { likely_payment_proof: true, confidence: 0.99, suggested_amount_cents: 1234, reason_code: 'payment_markers_present' }

const originalFetch = global.fetch

function completion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
}

function stub(content: string) {
  const fetchMock = vi.fn()
  fetchMock.mockResolvedValue(completion(content))
  global.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

function body(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit | undefined
  return JSON.parse(String(init?.body)) as Record<string, any>
}

function expectNoLeak(value: unknown) {
  const serialized = JSON.stringify(value)
  expect(serialized).not.toContain(KEY)
  expect(serialized).not.toContain('secret-advisory')
  expect(serialized).not.toContain(DOCUMENT_MARKER)
}

describe('payment-proof visual advisory extraction', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    global.fetch = originalFetch
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('asks DeepSeek for JSON through response_format and the prompt, without any json_schema', async () => {
    const fetchMock = stub(JSON.stringify(answer))
    const persist = vi.fn(async () => undefined)

    await classifyPaymentProof({
      proofId: 'proof-1',
      extractedText: `${DOCUMENT_MARKER} PIX recebido`,
      apiKey: KEY,
      model: DEEPSEEK_DEFAULT_MODEL,
      persist,
    })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(DEEPSEEK_CHAT_COMPLETIONS_URL)
    const payload = body(fetchMock)
    expect(payload.model).toBe(DEEPSEEK_DEFAULT_MODEL)
    expect(payload.response_format).toEqual({ type: 'json_object' })
    expect(JSON.stringify(payload)).not.toContain('json_schema')
    expect(payload.thinking).toEqual({ type: 'disabled' })
    expect(payload.stream).toBe(false)
    expect(String((payload.messages as any[])[0].content)).toMatch(/json/i)
    expect(String((payload.messages as any[])[1].content)).toContain('<untrusted_document>')
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${KEY}` })
  })

  it('sends a bounded canonical image as a user content part and remains manual-review only', async () => {
    const fetchMock = stub(JSON.stringify(answer))
    const persist = vi.fn(async () => undefined)

    const result = await classifyPaymentProof({
      proofId: 'proof-1',
      extractedText: '',
      imageDataUrl: image,
      apiKey: KEY,
      model: DEEPSEEK_DEFAULT_MODEL,
      persist,
    })

    expect(result).toMatchObject({ disposition: 'manual_review', approved: false, suggestedAmountCents: 1234, model: DEEPSEEK_DEFAULT_MODEL })
    const payload = body(fetchMock)
    const user = (payload.messages as any[])[1]
    expect(user.role).toBe('user')
    expect(user.content[1]).toEqual({ type: 'image_url', image_url: { url: image } })
    expect(JSON.stringify(payload)).not.toContain(DOCUMENT_MARKER)
  })

  it('pins an image away from a non-vision model and names the model actually used', async () => {
    const fetchMock = stub(JSON.stringify(answer))

    const result = await classifyPaymentProof({
      proofId: 'proof-1',
      extractedText: '',
      imageDataUrl: image,
      apiKey: KEY,
      model: 'deepseek-v4-pro',
    })

    expect(body(fetchMock).model).toBe(DEEPSEEK_DEFAULT_MODEL)
    expect(result).toMatchObject({ disposition: 'manual_review', approved: false, model: DEEPSEEK_DEFAULT_MODEL })
    expect(JSON.stringify(result)).not.toContain('deepseek-v4-pro')
  })

  it('maps a payload outside the schema to invalid_provider_output and manual review', async () => {
    stub(JSON.stringify({ likely_payment_proof: 'yes', confidence: 2 }))
    const persist = vi.fn(async () => undefined)

    const result = await classifyPaymentProof({
      proofId: 'proof-1',
      extractedText: `${DOCUMENT_MARKER} PIX recebido`,
      apiKey: KEY,
      model: DEEPSEEK_DEFAULT_MODEL,
      persist,
    })

    expect(result).toMatchObject({ disposition: 'manual_review', approved: false, reasonCode: 'invalid_provider_output' })
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ approved: false, disposition: 'manual_review', reasonCode: 'invalid_provider_output' }))
    expectNoLeak(result)
  })

  it('maps a provider failure to provider_unavailable and manual review', async () => {
    global.fetch = vi.fn(async () => { throw new Error(`provider down for ${KEY}`) }) as unknown as typeof fetch
    const persist = vi.fn(async () => undefined)

    const result = await classifyPaymentProof({
      proofId: 'proof-1',
      extractedText: `${DOCUMENT_MARKER} PIX recebido`,
      apiKey: KEY,
      model: DEEPSEEK_DEFAULT_MODEL,
      persist,
    })

    expect(result).toMatchObject({ disposition: 'manual_review', approved: false, reasonCode: 'provider_unavailable', model: DEEPSEEK_DEFAULT_MODEL })
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ approved: false, disposition: 'manual_review' }))
    expectNoLeak(result)
    expectNoLeak(persist.mock.calls)
  })

  it('fails closed to provider_unavailable without any request when the credential is absent', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch
    const persist = vi.fn(async () => undefined)

    const result = await classifyPaymentProof({
      proofId: 'proof-1',
      extractedText: `${DOCUMENT_MARKER} PIX recebido`,
      imageDataUrl: image,
      apiKey: '',
      model: DEEPSEEK_DEFAULT_MODEL,
      persist,
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result).toMatchObject({ disposition: 'manual_review', approved: false, reasonCode: 'provider_unavailable' })
    expectNoLeak(result)
  })
})

describe('payment-proof advisory guards', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    global.fetch = originalFetch
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it.each([
    ['no text and no image', { extractedText: '' }],
    ['text beyond the bounded input', { extractedText: 'x'.repeat(20_001) }],
    ['an image data URL outside the canonical shape', { extractedText: '', imageDataUrl: 'data:image/svg+xml;base64,AAAA' }],
  ])('keeps %s manual-review only and never calls the provider', async (_label, overrides) => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await classifyPaymentProof({
      proofId: 'proof-1',
      apiKey: KEY,
      model: DEEPSEEK_DEFAULT_MODEL,
      ...overrides,
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result).toMatchObject({ disposition: 'manual_review', approved: false, reasonCode: 'invalid_provider_output' })
  })
})
