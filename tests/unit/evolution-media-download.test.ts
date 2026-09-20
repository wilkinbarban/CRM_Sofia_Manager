import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadEvolutionPdf, MAX_EVOLUTION_PDF_BYTES } from '@/lib/whatsapp/evolution-media-download'

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])
const BASE64 = Buffer.from(PDF).toString('base64')
const input = { apiUrl: 'https://evolution.test/', apiKey: 'secret', instanceName: 'main instance', message: { key: { id: 'opaque' } }, timeoutMs: 1000 }

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('Evolution media download boundary', () => {
  it.each([
    [PDF.length],
    [String(PDF.length)],
    [{ low: PDF.length, high: 0, unsigned: true }],
  ])('posts the confirmed v2.3.7 contract and accepts nested size.fileLength %j', async (fileLength) => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ mimetype: 'application/pdf', base64: BASE64, size: { fileLength } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(downloadEvolutionPdf(input)).resolves.toEqual({ ok: true, bytes: PDF, mimeType: 'application/pdf' })
    expect(fetchMock).toHaveBeenCalledWith('https://evolution.test/chat/getBase64FromMediaMessage/main%20instance', expect.objectContaining({
      method: 'POST', redirect: 'error', headers: { apikey: 'secret', 'Content-Type': 'application/json', Origin: 'https://crmsofiamanager.duckdns.org' },
      body: JSON.stringify({ message: input.message, convertToMp4: false }),
    }))
  })

  it('uses the configured public app origin for Evolution CORS compatibility', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://configured-origin.test')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ mimetype: 'application/pdf', base64: BASE64, size: { fileLength: PDF.length } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(downloadEvolutionPdf(input)).resolves.toMatchObject({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ Origin: 'https://configured-origin.test' }),
    }))
  })

  it.each([
    [{ mimetype: 'image/png', base64: BASE64, size: { fileLength: PDF.length } }, 'EVOLUTION_MEDIA_MIME_INVALID'],
    [{ mimetype: 'application/pdf', base64: BASE64 }, 'EVOLUTION_MEDIA_SIZE_INVALID'],
    [{ mimetype: 'application/pdf', base64: BASE64, size: {} }, 'EVOLUTION_MEDIA_SIZE_INVALID'],
    [{ mimetype: 'application/pdf', base64: BASE64, size: { fileLength: { low: PDF.length, high: 0, unsigned: true, extra: 'rejected' } } }, 'EVOLUTION_MEDIA_SIZE_INVALID'],
    [{ mimetype: 'application/pdf', base64: BASE64, size: { fileLength: MAX_EVOLUTION_PDF_BYTES + 1 } }, 'EVOLUTION_MEDIA_TOO_LARGE'],
    [{ mimetype: 'application/pdf', base64: '%%%=', size: { fileLength: 3 } }, 'EVOLUTION_MEDIA_BASE64_INVALID'],
    [{ mimetype: 'application/pdf', base64: BASE64, size: { fileLength: PDF.length + 1 } }, 'EVOLUTION_MEDIA_SIZE_MISMATCH'],
    [{ mimetype: 'application/pdf', base64: BASE64, size: PDF.length }, 'EVOLUTION_MEDIA_SIZE_INVALID'],
  ])('rejects unsafe responses', async (payload, error) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })))
    await expect(downloadEvolutionPdf(input)).resolves.toEqual({ ok: false, error, retryable: false })
  })

  it.each([
    new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x20, 0x31]),
  ])('rejects truncated or wrong-signature bytes', async (bytes) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      mimetype: 'application/pdf', base64: Buffer.from(bytes).toString('base64'), size: { fileLength: bytes.length },
    }), { status: 200 })))

    await expect(downloadEvolutionPdf(input)).resolves.toEqual({ ok: false, error: 'EVOLUTION_MEDIA_PDF_SIGNATURE_INVALID', retryable: false })
  })

  it('times out and cancels a response stream stalled after headers', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => undefined) },
      cancel() { cancelled = true },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })))

    await expect(downloadEvolutionPdf({ ...input, timeoutMs: 10 })).resolves.toEqual({ ok: false, error: 'EVOLUTION_MEDIA_DOWNLOAD_TIMEOUT', retryable: true })
    expect(cancelled).toBe(true)
  })

  it('rejects an oversized chunked response during streaming and cancels the reader', async () => {
    let cancelled = false
    const chunk = new Uint8Array(1024 * 1024)
    let emitted = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        emitted += 1
        controller.enqueue(chunk)
      },
      cancel() {
        cancelled = true
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })))

    await expect(downloadEvolutionPdf(input)).resolves.toEqual({ ok: false, error: 'EVOLUTION_MEDIA_TOO_LARGE', retryable: false })
    expect(emitted).toBeLessThan(9)
    expect(cancelled).toBe(true)
  })

  it('rejects declared document metadata before making a request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(downloadEvolutionPdf({ ...input, declaredMimeType: 'image/png', declaredSize: 12 })).resolves.toEqual({ ok: false, error: 'EVOLUTION_MEDIA_MIME_INVALID', retryable: false })
    await expect(downloadEvolutionPdf({ ...input, declaredMimeType: 'application/pdf', declaredSize: MAX_EVOLUTION_PDF_BYTES + 1 })).resolves.toEqual({ ok: false, error: 'EVOLUTION_MEDIA_TOO_LARGE', retryable: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    [401, 'EVOLUTION_MEDIA_HTTP_AUTH', false],
    [403, 'EVOLUTION_MEDIA_HTTP_AUTH', false],
    [400, 'EVOLUTION_MEDIA_HTTP_CONTRACT', false],
    [404, 'EVOLUTION_MEDIA_HTTP_CONTRACT', false],
    [422, 'EVOLUTION_MEDIA_HTTP_CONTRACT', false],
    [408, 'EVOLUTION_MEDIA_HTTP_UPSTREAM', true],
    [429, 'EVOLUTION_MEDIA_HTTP_UPSTREAM', true],
    [500, 'EVOLUTION_MEDIA_HTTP_UPSTREAM', true],
    [503, 'EVOLUTION_MEDIA_HTTP_UPSTREAM', true],
    [302, 'EVOLUTION_MEDIA_HTTP_UNEXPECTED', false],
    [409, 'EVOLUTION_MEDIA_HTTP_UNEXPECTED', false],
  ])('classifies HTTP %i without consuming its response body', async (status, error, retryable) => {
    const read = vi.fn(() => { throw new Error('response body must not be consumed') })
    const response = {
      ok: false,
      status,
      body: { getReader: vi.fn(() => ({ read })) },
    } as unknown as Response
    vi.stubGlobal('fetch', vi.fn(async () => response))

    await expect(downloadEvolutionPdf(input)).resolves.toEqual({ ok: false, error, retryable })
    expect(response.body?.getReader).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })

  it('distinguishes network failures and timeouts without logging', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warnLog = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('private network detail') }))
    await expect(downloadEvolutionPdf(input)).resolves.toEqual({ ok: false, error: 'EVOLUTION_MEDIA_NETWORK', retryable: true })

    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))))
    await expect(downloadEvolutionPdf({ ...input, timeoutMs: 1 })).resolves.toEqual({ ok: false, error: 'EVOLUTION_MEDIA_DOWNLOAD_TIMEOUT', retryable: true })
    expect(errorLog).not.toHaveBeenCalled()
    expect(warnLog).not.toHaveBeenCalled()
    errorLog.mockRestore()
    warnLog.mockRestore()
  })
})
