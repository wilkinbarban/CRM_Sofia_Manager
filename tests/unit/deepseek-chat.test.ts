// @vitest-environment node

/**
 * General DeepSeek chat boundary.
 *
 * `chamarDeepSeekChat` is the single provider call behind Sofia's generation and
 * the customer-memory JSON extraction. It mirrors the server-only guarantees of
 * the model catalog client: the key travels only in the Authorization header,
 * the response read is bounded by a byte cap plus a character cap, and every
 * failure is a stable error code instead of a provider body or a transport
 * message.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  obterConfiguracaoSistema: vi.fn(),
}))

vi.mock('@/lib/config/sistema', () => ({
  obterConfiguracaoSistema: mocks.obterConfiguracaoSistema,
}))

import {
  DEEPSEEK_CHAT_COMPLETIONS_URL,
  DEEPSEEK_CHAT_MAX_ATTEMPTS,
  DEEPSEEK_CHAT_RETRY_BASE_DELAY_MS,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_VISION_MODELS,
  chamarDeepSeekChat,
  isDeepSeekVisionModel,
  normalizarModeloDeepSeek,
  resolverModeloDeepSeek,
} from '@/lib/ai/deepseek'
import { chamarModeloEconomicoJson } from '@/lib/ai/llm-json'

const OPERATOR_KEY = 'sk-deepseek-secret-chat-key'
const PROVIDER_BODY_MARKER = 'PROVIDER_COMPLETION_BODY_MARKER'

const originalFetch = global.fetch
const originalEnv = process.env

function chatResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function completion(content: string) {
  return { id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content } }] }
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    apiKey: OPERATOR_KEY,
    model: 'deepseek-flash',
    messages: [{ role: 'user' as const, content: 'Olá' }],
    temperature: 0.1,
    maxTokens: 64,
    ...overrides,
  }
}

function expectNoSecret(value: unknown) {
  expect(JSON.stringify(value)).not.toContain(OPERATOR_KEY)
  expect(JSON.stringify(value)).not.toContain('secret-chat')
}

describe('chamarDeepSeekChat', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mocks.obterConfiguracaoSistema.mockResolvedValue(null)
    process.env = { ...originalEnv }
    delete process.env.DEEPSEEK_API_KEY
    delete process.env.DEEPSEEK_MODEL
  })

  afterEach(() => {
    global.fetch = originalFetch
    process.env = originalEnv
    vi.unstubAllGlobals()
  })

  it('refuses to run in a browser runtime', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch
    vi.stubGlobal('window', {})

    await expect(chamarDeepSeekChat(baseInput())).rejects.toThrow('DEEPSEEK_SERVER_ONLY_CLIENT')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects an absent or placeholder key before any request', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    for (const apiKey of ['', '   ', 'sk-placeholder', null, undefined]) {
      const result = await chamarDeepSeekChat(baseInput({ apiKey }))
      expect(result).toEqual({ success: false, error: 'DEEPSEEK_NOT_CONFIGURED', attempts: 0, retried: false })
    }

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a missing model id before any request', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await chamarDeepSeekChat(baseInput({ model: '   ' }))

    expect(result).toEqual({ success: false, error: 'DEEPSEEK_MODEL_REQUIRED', attempts: 0, retried: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts the disabled-thinking body without response_format by default', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatResponse(completion('  Costela Premium  ')))
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await chamarDeepSeekChat(baseInput())

    expect(result).toEqual({ success: true, content: 'Costela Premium' })
    expectNoSecret(result)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(DEEPSEEK_CHAT_COMPLETIONS_URL)
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${OPERATOR_KEY}` })
    expect(init.signal).toBeInstanceOf(AbortSignal)

    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'Olá' }],
      temperature: 0.1,
      max_tokens: 64,
      thinking: { type: 'disabled' },
      stream: false,
    })
    expect(body).not.toHaveProperty('response_format')
    expect(JSON.stringify(body)).not.toContain(OPERATOR_KEY)
  })

  it('adds response_format json_object only when JSON output is requested', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatResponse(completion('{"assunto":"cliente","fatos":[]}')))
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await chamarDeepSeekChat(baseInput({ jsonResponse: true }))

    expect(result).toEqual({ success: true, content: '{"assunto":"cliente","fatos":[]}' })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.thinking).toEqual({ type: 'disabled' })
  })

  it('aborts a stalled request and reports a timeout', async () => {
    let capturedSignal: AbortSignal | undefined
    global.fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        capturedSignal = init?.signal ?? undefined
        capturedSignal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
        })
      })
    }) as unknown as typeof fetch

    const result = await chamarDeepSeekChat(baseInput({ timeoutMs: 10 }))

    expect(result).toEqual({ success: false, error: 'DEEPSEEK_TIMEOUT', attempts: 1, retried: false })
    expect(capturedSignal?.aborted).toBe(true)
    expectNoSecret(result)
  })

  it('reports a stable HTTP error with the status and never reads the provider body', async () => {
    const text = vi.fn(async () => `invalid credentials for ${OPERATOR_KEY}`)
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      statusText: 'Payment Required',
      text,
      json: async () => ({ error: { message: `invalid credentials for ${OPERATOR_KEY}` } }),
    } as unknown as Response) as unknown as typeof fetch

    const result = await chamarDeepSeekChat(baseInput())

    expect(result).toEqual({ success: false, error: 'DEEPSEEK_HTTP_ERROR', status: 402, attempts: 1, retried: false })
    expect(text).not.toHaveBeenCalled()
    expectNoSecret(result)
    expect(JSON.stringify(result)).not.toContain('invalid credentials')
  })

  it('reports a stable request failure when the transport quotes the key', async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(new Error(`fetch failed for key ${OPERATOR_KEY}`)) as unknown as typeof fetch

    const result = await chamarDeepSeekChat(baseInput())

    expect(result).toEqual({ success: false, error: 'DEEPSEEK_REQUEST_FAILED', attempts: 1, retried: false })
    expectNoSecret(result)
  })

  it('reports an invalid response when the payload carries no assistant content', async () => {
    for (const payload of [{}, { choices: [] }, { choices: [{}] }, { choices: [{ message: { content: 7 } }] }]) {
      global.fetch = vi.fn().mockResolvedValue(chatResponse(payload)) as unknown as typeof fetch

      const result = await chamarDeepSeekChat(baseInput())

      expect(result).toEqual({ success: false, error: 'DEEPSEEK_INVALID_RESPONSE', attempts: 1, retried: false })
      expect(JSON.stringify(result)).not.toContain(PROVIDER_BODY_MARKER)
    }
  })

  it('reports an empty response for blank assistant content', async () => {
    global.fetch = vi.fn().mockResolvedValue(chatResponse(completion('   '))) as unknown as typeof fetch

    const result = await chamarDeepSeekChat(baseInput())

    expect(result).toEqual({ success: false, error: 'DEEPSEEK_EMPTY_RESPONSE', attempts: 1, retried: false })
  })

  it('rejects an oversized response from the declared content-length before reading it', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(completion('ok')), {
        status: 200,
        headers: { 'content-length': String(8 * 1024 * 1024) },
      }),
    ) as unknown as typeof fetch

    const result = await chamarDeepSeekChat(baseInput({ maxResponseBytes: 1024 }))

    expect(result).toEqual({ success: false, error: 'DEEPSEEK_RESPONSE_TOO_LARGE', attempts: 1, retried: false })
  })

  it('rejects a streamed body that overflows the byte cap', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(completion(PROVIDER_BODY_MARKER.repeat(50))), { status: 200 }),
    ) as unknown as typeof fetch

    const result = await chamarDeepSeekChat(baseInput({ maxResponseBytes: 64 }))

    expect(result).toEqual({ success: false, error: 'DEEPSEEK_RESPONSE_TOO_LARGE', attempts: 1, retried: false })
    expect(JSON.stringify(result)).not.toContain(PROVIDER_BODY_MARKER)
  })

  it('rejects accepted content that overflows the character cap', async () => {
    global.fetch = vi.fn().mockResolvedValue(chatResponse(completion('abcdef'))) as unknown as typeof fetch

    const result = await chamarDeepSeekChat(baseInput({ maxContentChars: 3 }))

    expect(result).toEqual({ success: false, error: 'DEEPSEEK_RESPONSE_TOO_LARGE', attempts: 1, retried: false })
  })
})

describe('chamarModeloEconomicoJson', () => {
  const params = {
    system: 'Responda APENAS com um objeto JSON.',
    user: 'MENSAGENS RECEBIDAS NESTE LOTE',
    maxTokens: 400,
    timeoutMs: 5000,
  }

  beforeEach(() => {
    vi.restoreAllMocks()
    mocks.obterConfiguracaoSistema.mockResolvedValue(null)
    process.env = { ...originalEnv }
    delete process.env.DEEPSEEK_API_KEY
    delete process.env.DEEPSEEK_MODEL
  })

  afterEach(() => {
    global.fetch = originalFetch
    process.env = originalEnv
    vi.unstubAllGlobals()
  })

  it('resolves the key and model from configuration and asks for JSON output', async () => {
    mocks.obterConfiguracaoSistema.mockImplementation(async (key: string) => {
      if (key === 'DEEPSEEK_API_KEY') return OPERATOR_KEY
      if (key === 'DEEPSEEK_MODEL') return 'deepseek-v4-pro'
      return null
    })
    const fetchMock = vi.fn().mockResolvedValue(chatResponse(completion('{"assunto":"cliente","fatos":[]}')))
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await chamarModeloEconomicoJson(params)

    expect(result).toBe('{"assunto":"cliente","fatos":[]}')
    expect(mocks.obterConfiguracaoSistema).toHaveBeenCalledWith('DEEPSEEK_API_KEY')
    expect(mocks.obterConfiguracaoSistema).toHaveBeenCalledWith('DEEPSEEK_MODEL')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(DEEPSEEK_CHAT_COMPLETIONS_URL)
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.model).toBe('deepseek-v4-pro')
    expect(body.temperature).toBe(0)
    expect(body.max_tokens).toBe(400)
    expect(body.response_format).toEqual({ type: 'json_object' })
  })

  it('falls back to the environment key and the default model', async () => {
    process.env.DEEPSEEK_API_KEY = OPERATOR_KEY
    const fetchMock = vi.fn().mockResolvedValue(chatResponse(completion('{}')))
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await chamarModeloEconomicoJson(params)

    expect(result).toBe('{}')
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.model).toBe(DEEPSEEK_DEFAULT_MODEL)
  })

  it('returns null for an absent or placeholder key without any request', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    for (const stored of [null, '', 'sk-your-api-key-placeholder']) {
      mocks.obterConfiguracaoSistema.mockResolvedValue(stored)
      expect(await chamarModeloEconomicoJson(params)).toBeNull()
    }

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns null on provider failure and never throws', async () => {
    mocks.obterConfiguracaoSistema.mockImplementation(async (key: string) => (
      key === 'DEEPSEEK_API_KEY' ? OPERATOR_KEY : null
    ))
    global.fetch = vi
      .fn()
      .mockRejectedValue(new Error(`provider down for ${OPERATOR_KEY}`)) as unknown as typeof fetch

    await expect(chamarModeloEconomicoJson(params)).resolves.toBeNull()
  })

  it('honors the caller timeout and returns null when the provider stalls', async () => {
    mocks.obterConfiguracaoSistema.mockImplementation(async (key: string) => (
      key === 'DEEPSEEK_API_KEY' ? OPERATOR_KEY : null
    ))
    let capturedSignal: AbortSignal | undefined
    global.fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        capturedSignal = init?.signal ?? undefined
        capturedSignal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
        })
      })
    }) as unknown as typeof fetch

    await expect(chamarModeloEconomicoJson({ ...params, timeoutMs: 10 })).resolves.toBeNull()
    expect(capturedSignal?.aborted).toBe(true)
  })

  it('returns null for an unparseable assistant payload', async () => {
    mocks.obterConfiguracaoSistema.mockImplementation(async (key: string) => (
      key === 'DEEPSEEK_API_KEY' ? OPERATOR_KEY : null
    ))
    global.fetch = vi.fn().mockResolvedValue(chatResponse({ not: 'a completion' })) as unknown as typeof fetch

    await expect(chamarModeloEconomicoJson(params)).resolves.toBeNull()
  })
})

describe('chamarDeepSeekChat — bounded retry', () => {
  it('pins the exported retry policy so a silent change cannot ship', () => {
    expect(DEEPSEEK_CHAT_MAX_ATTEMPTS).toBe(2)
    expect(DEEPSEEK_CHAT_RETRY_BASE_DELAY_MS).toBe(250)
  })

  it('retries a transient per-attempt timeout once and succeeds on the second attempt', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
      .mockResolvedValueOnce(chatResponse(completion('Costela Premium')))
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await chamarDeepSeekChat(baseInput())

    expect(result).toEqual({ success: true, content: 'Costela Premium' })
    expect(fetchMock).toHaveBeenCalledTimes(DEEPSEEK_CHAT_MAX_ATTEMPTS)
  })

  it('stops at exactly two requests for a persistent 429 and reports the honest failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatResponse({}, 429))
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await chamarDeepSeekChat(baseInput())

    expect(result).toEqual({
      success: false,
      error: 'DEEPSEEK_HTTP_ERROR',
      status: 429,
      attempts: DEEPSEEK_CHAT_MAX_ATTEMPTS,
      retried: true,
    })
    expect(fetchMock).toHaveBeenCalledTimes(DEEPSEEK_CHAT_MAX_ATTEMPTS)
  })

  it('retries a 429 once and succeeds on the second attempt', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(chatResponse({}, 429))
      .mockResolvedValueOnce(chatResponse(completion('Costela Premium')))
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await chamarDeepSeekChat(baseInput())

    expect(result).toEqual({ success: true, content: 'Costela Premium' })
    expect(fetchMock).toHaveBeenCalledTimes(DEEPSEEK_CHAT_MAX_ATTEMPTS)
  })

  it('never retries a permanent 4xx and reports a single attempt', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatResponse({}, 401))
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await chamarDeepSeekChat(baseInput())

    expect(result).toEqual({ success: false, error: 'DEEPSEEK_HTTP_ERROR', status: 401, attempts: 1, retried: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('DeepSeek vision content parts', () => {
  const imageParts = [
    { type: 'text' as const, text: 'Inspect this untrusted canonical payment-proof image.' },
    { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
  ]

  beforeEach(() => {
    vi.restoreAllMocks()
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    global.fetch = originalFetch
    process.env = originalEnv
    vi.unstubAllGlobals()
  })

  it('refuses an image for a known non-vision model before any request', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await chamarDeepSeekChat(baseInput({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: imageParts }],
    }))

    expect(result).toEqual({ success: false, error: 'DEEPSEEK_VISION_UNSUPPORTED', attempts: 0, retried: false })
    expect(fetchMock).not.toHaveBeenCalled()
    expectNoSecret(result)
  })

  it('posts the content-parts body for a vision model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatResponse(completion('{"ok":true}')))
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await chamarDeepSeekChat(baseInput({
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: imageParts }],
      jsonResponse: true,
    }))

    expect(result).toEqual({ success: true, content: '{"ok":true}' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(DEEPSEEK_CHAT_COMPLETIONS_URL)
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.messages).toEqual([{ role: 'user', content: imageParts }])
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(JSON.stringify(body)).not.toContain(OPERATOR_KEY)
  })

  it('keeps the vision allowlist anchored on the default model and rejects every text-only id', () => {
    expect(DEEPSEEK_VISION_MODELS).toEqual([
      'deepseek-flash',
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
    ])
    expect(DEEPSEEK_VISION_MODELS).toContain(DEEPSEEK_DEFAULT_MODEL)
    for (const modelo of DEEPSEEK_VISION_MODELS) expect(isDeepSeekVisionModel(modelo)).toBe(true)
    for (const model of ['deepseek-v4-pro', 'deepseek-flash-vision', 'deepseek-vl2', '', '   ', null, undefined, 7]) {
      expect(isDeepSeekVisionModel(model)).toBe(false)
    }
  })

  it('reports the honest attempt count when a retry ends in an invalid body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(chatResponse({}, 429))
      .mockResolvedValueOnce(chatResponse({ choices: [{ message: { content: 7 } }] }))
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await chamarDeepSeekChat(baseInput())

    expect(result).toEqual({ success: false, error: 'DEEPSEEK_INVALID_RESPONSE', attempts: 2, retried: true })
    expect(fetchMock).toHaveBeenCalledTimes(DEEPSEEK_CHAT_MAX_ATTEMPTS)
  })
})

describe('DeepSeek model resolution', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mocks.obterConfiguracaoSistema.mockResolvedValue(null)
    process.env = { ...originalEnv }
    delete process.env.DEEPSEEK_MODEL
  })

  afterEach(() => {
    process.env = originalEnv
    vi.unstubAllGlobals()
  })

  it('falls back to the default for an unusable model id and keeps a usable one', () => {
    for (const impossivel of ['', '   ', 'deepseek flash', undefined]) {
      expect(normalizarModeloDeepSeek(impossivel)).toBe(DEEPSEEK_DEFAULT_MODEL)
    }

    expect(normalizarModeloDeepSeek(' deepseek-v4-pro ')).toBe('deepseek-v4-pro')
  })

  it('prefers a usable stored model over the environment', async () => {
    mocks.obterConfiguracaoSistema.mockImplementation(async (key: string) => (
      key === 'DEEPSEEK_MODEL' ? 'deepseek-v4-pro' : null
    ))
    process.env.DEEPSEEK_MODEL = 'deepseek-flash'

    await expect(resolverModeloDeepSeek()).resolves.toBe('deepseek-v4-pro')
  })

  it('falls through an unusable stored model to the environment, then to the default', async () => {
    // An unusable operator entry never wins over a usable deployment value.
    mocks.obterConfiguracaoSistema.mockImplementation(async (key: string) => (
      key === 'DEEPSEEK_MODEL' ? 'deepseek v4 pro' : null
    ))
    process.env.DEEPSEEK_MODEL = 'deepseek-v4-flash'

    await expect(resolverModeloDeepSeek()).resolves.toBe('deepseek-v4-flash')

    process.env.DEEPSEEK_MODEL = '   '

    await expect(resolverModeloDeepSeek()).resolves.toBe(DEEPSEEK_DEFAULT_MODEL)
  })
})
