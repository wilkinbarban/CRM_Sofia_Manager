// @vitest-environment node

/**
 * DeepSeek model catalog client.
 *
 * The client is server-only: it must never run in a browser runtime, it must
 * never place the API key anywhere except the Authorization header, and it must
 * never echo the key through results or logs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEEPSEEK_MODELS_TIMEOUT_MS,
  DEEPSEEK_MODELS_URL,
  isUsableDeepSeekApiKey,
  listDeepSeekModels,
} from '@/lib/ai/deepseek'

const OPERATOR_KEY = 'sk-deepseek-secret-operator-key'

const originalFetch = global.fetch

function mockJsonResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response
}

function spyOnConsole() {
  return {
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  }
}

function expectNoSecret(value: unknown) {
  expect(JSON.stringify(value)).not.toContain(OPERATOR_KEY)
  expect(JSON.stringify(value)).not.toContain('secret-operator')
}

describe('listDeepSeekModels', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.unstubAllGlobals()
  })

  it('uses a bounded timeout and a fixed authenticated endpoint', () => {
    expect(DEEPSEEK_MODELS_URL).toBe('https://api.deepseek.com/models')
    expect(DEEPSEEK_MODELS_TIMEOUT_MS).toBeGreaterThan(0)
    expect(DEEPSEEK_MODELS_TIMEOUT_MS).toBeLessThanOrEqual(10_000)
  })

  it('returns only safe { id, label } entries and sends the key only as a bearer header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse(200, {
        object: 'list',
        data: [
          { id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' },
          { id: 'deepseek-reasoner', object: 'model', owned_by: 'deepseek', name: 'DeepSeek Reasoner' },
        ],
      }),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await listDeepSeekModels({ apiKey: OPERATOR_KEY })

    expect(result).toEqual({
      success: true,
      models: [
        { id: 'deepseek-chat', label: 'deepseek-chat' },
        { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
      ],
    })

    if (!result.success) throw new Error('expected success')
    expect(Object.keys(result.models[0])).toEqual(['id', 'label'])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(DEEPSEEK_MODELS_URL)
    expect(init.method).toBe('GET')
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${OPERATOR_KEY}` })
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expectNoSecret(result)
  })

  it('skips malformed entries and keeps the valid ones', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      mockJsonResponse(200, {
        data: [
          { id: 'deepseek-chat' },
          { id: 42 },
          { id: '   ' },
          { nope: true },
          null,
          { id: 'deepseek-reasoner', name: '' },
        ],
      }),
    ) as unknown as typeof fetch

    const result = await listDeepSeekModels({ apiKey: OPERATOR_KEY })

    expect(result).toEqual({
      success: true,
      models: [
        { id: 'deepseek-chat', label: 'deepseek-chat' },
        { id: 'deepseek-reasoner', label: 'deepseek-reasoner' },
      ],
    })
  })

  it('rejects a catalog payload that carries no valid model id', async () => {
    const consoleSpies = spyOnConsole()

    for (const payload of [{ data: 'nope' }, { data: [{ id: 7 }, { id: '' }] }, null]) {
      global.fetch = vi.fn().mockResolvedValue(mockJsonResponse(200, payload)) as unknown as typeof fetch

      const result = await listDeepSeekModels({ apiKey: OPERATOR_KEY })

      expect(result).toEqual({ success: false, error: 'DEEPSEEK_INVALID_RESPONSE' })
      expectNoSecret(result)
    }

    expect(consoleSpies.log).not.toHaveBeenCalled()
    expect(consoleSpies.warn).not.toHaveBeenCalled()
    expect(consoleSpies.error).not.toHaveBeenCalled()
  })

  it('returns a stable HTTP error code without quoting the response body or the key', async () => {
    const consoleSpies = spyOnConsole()

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => `invalid credentials for ${OPERATOR_KEY}`,
      json: async () => ({ error: { message: `invalid credentials for ${OPERATOR_KEY}` } }),
    } as unknown as Response) as unknown as typeof fetch

    const result = await listDeepSeekModels({ apiKey: OPERATOR_KEY })

    expect(result).toEqual({ success: false, error: 'DEEPSEEK_HTTP_ERROR', status: 401 })
    expectNoSecret(result)
    expect(consoleSpies.error).not.toHaveBeenCalled()
    expect(consoleSpies.warn).not.toHaveBeenCalled()
  })

  it('returns a stable request error when the transport quotes the key in its message', async () => {
    const consoleSpies = spyOnConsole()

    global.fetch = vi
      .fn()
      .mockRejectedValue(new Error(`fetch failed for key ${OPERATOR_KEY}`)) as unknown as typeof fetch

    const result = await listDeepSeekModels({ apiKey: OPERATOR_KEY })

    expect(result).toEqual({ success: false, error: 'DEEPSEEK_REQUEST_FAILED' })
    expectNoSecret(result)
    expect(consoleSpies.error).not.toHaveBeenCalled()
    expect(consoleSpies.warn).not.toHaveBeenCalled()
  })

  it('aborts a stalled request and reports a timeout', async () => {
    const consoleSpies = spyOnConsole()
    let capturedSignal: AbortSignal | undefined

    global.fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        capturedSignal = init?.signal ?? undefined
        capturedSignal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
        })
      })
    }) as unknown as typeof fetch

    const result = await listDeepSeekModels({ apiKey: OPERATOR_KEY, timeoutMs: 10 })

    expect(result).toEqual({ success: false, error: 'DEEPSEEK_TIMEOUT' })
    expect(capturedSignal?.aborted).toBe(true)
    expectNoSecret(result)
    expect(consoleSpies.error).not.toHaveBeenCalled()
  })

  it('rejects an absent or placeholder key before any request', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    expect(isUsableDeepSeekApiKey(null)).toBe(false)
    expect(isUsableDeepSeekApiKey('')).toBe(false)
    expect(isUsableDeepSeekApiKey('   ')).toBe(false)
    expect(isUsableDeepSeekApiKey('sk-insert_here')).toBe(false)
    expect(isUsableDeepSeekApiKey('sk-your-api-key')).toBe(false)
    expect(isUsableDeepSeekApiKey(OPERATOR_KEY)).toBe(true)

    for (const apiKey of ['', 'sk-placeholder', 'sk-insert_here', null, undefined]) {
      const result = await listDeepSeekModels({ apiKey })
      expect(result).toEqual({ success: false, error: 'DEEPSEEK_NOT_CONFIGURED' })
    }

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses to run in a browser runtime', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch
    vi.stubGlobal('window', {})

    await expect(listDeepSeekModels({ apiKey: OPERATOR_KEY })).rejects.toThrow('DEEPSEEK_SERVER_ONLY_CLIENT')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
