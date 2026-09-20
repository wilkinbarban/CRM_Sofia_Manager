import { decodeEvolutionDocumentSize } from './evolution-document-size'

export const MAX_EVOLUTION_PDF_BYTES = 5 * 1024 * 1024
export const MAX_EVOLUTION_MEDIA_JSON_BYTES = Math.ceil(MAX_EVOLUTION_PDF_BYTES / 3) * 4 + 1024

type SupportedEvolutionMediaMime = 'application/pdf' | 'image/jpeg' | 'image/png'

type DownloadInput = {
  apiUrl: string
  apiKey: string
  instanceName: string
  message: unknown
  declaredMimeType?: unknown
  declaredSize?: unknown
  timeoutMs: number
}

type DownloadError =
  | 'EVOLUTION_MEDIA_MIME_INVALID'
  | 'EVOLUTION_MEDIA_TOO_LARGE'
  | 'EVOLUTION_MEDIA_SIZE_INVALID'
  | 'EVOLUTION_MEDIA_SIZE_MISMATCH'
  | 'EVOLUTION_MEDIA_BASE64_INVALID'
  | 'EVOLUTION_MEDIA_PDF_SIGNATURE_INVALID'
  | 'EVOLUTION_MEDIA_DOWNLOAD_FAILED'
  | 'EVOLUTION_MEDIA_HTTP_AUTH'
  | 'EVOLUTION_MEDIA_HTTP_CONTRACT'
  | 'EVOLUTION_MEDIA_HTTP_UPSTREAM'
  | 'EVOLUTION_MEDIA_HTTP_UNEXPECTED'
  | 'EVOLUTION_MEDIA_NETWORK'
  | 'EVOLUTION_MEDIA_DOWNLOAD_TIMEOUT'

function failure(error: DownloadError, retryable: boolean) {
  return { ok: false as const, error, retryable }
}

function classifyHttpFailure(status: number) {
  if (status === 401 || status === 403) return failure('EVOLUTION_MEDIA_HTTP_AUTH', false)
  if (status === 400 || status === 404 || status === 422) return failure('EVOLUTION_MEDIA_HTTP_CONTRACT', false)
  if (status === 408 || status === 429 || status >= 500) return failure('EVOLUTION_MEDIA_HTTP_UPSTREAM', true)
  return failure('EVOLUTION_MEDIA_HTTP_UNEXPECTED', false)
}

function normalizedMime(value: unknown): SupportedEvolutionMediaMime | null {
  if (typeof value !== 'string') return null
  const mime = value.trim().toLowerCase()
  return mime === 'application/pdf' || mime === 'image/jpeg' || mime === 'image/png' ? mime : null
}

function exactPdfMime(value: unknown): boolean {
  return normalizedMime(value) === 'application/pdf'
}

function validSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

async function readBoundedJsonBody(response: Response, signal: AbortSignal): Promise<Uint8Array | null> {
  if (!response.body) return null
  const reader = response.body.getReader()
  const aborted = new Promise<never>((_resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted])
      if (done) break
      total += value.byteLength
      if (total > MAX_EVOLUTION_MEDIA_JSON_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } catch (error) {
    if (signal.aborted) void reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function decodeStrictBase64(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return null
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) return null
  return new Uint8Array(bytes)
}

export async function downloadEvolutionMedia(input: DownloadInput) {
  const declaredMimeType = input.declaredMimeType === undefined ? null : normalizedMime(input.declaredMimeType)
  if (input.declaredMimeType !== undefined && !declaredMimeType) {
    return failure('EVOLUTION_MEDIA_MIME_INVALID', false)
  }
  if (input.declaredSize !== undefined) {
    if (!validSize(input.declaredSize)) return failure('EVOLUTION_MEDIA_SIZE_INVALID', false)
    if (input.declaredSize > MAX_EVOLUTION_PDF_BYTES) return failure('EVOLUTION_MEDIA_TOO_LARGE', false)
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs)
  try {
    const endpoint = `${input.apiUrl.replace(/\/+$/, '')}/chat/getBase64FromMediaMessage/${encodeURIComponent(input.instanceName)}`
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        apikey: input.apiKey,
        'Content-Type': 'application/json',
        Origin: process.env.NEXT_PUBLIC_APP_URL || 'https://crmsofiamanager.duckdns.org',
      },
      body: JSON.stringify({ message: input.message, convertToMp4: false }),
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) return classifyHttpFailure(response.status)

    const contentLength = response.headers.get('content-length')
    if (contentLength !== null) {
      const declaredResponseLength = Number(contentLength)
      if (!Number.isSafeInteger(declaredResponseLength) || declaredResponseLength < 0) {
        return failure('EVOLUTION_MEDIA_DOWNLOAD_FAILED', true)
      }
      if (declaredResponseLength > MAX_EVOLUTION_MEDIA_JSON_BYTES) {
        await response.body?.cancel()
        return failure('EVOLUTION_MEDIA_TOO_LARGE', false)
      }
    }
    const encodedPayload = await readBoundedJsonBody(response, controller.signal)
    if (!encodedPayload) return failure('EVOLUTION_MEDIA_TOO_LARGE', false)
    let payload: any = null
    try {
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(encodedPayload))
    } catch {
      return failure('EVOLUTION_MEDIA_DOWNLOAD_FAILED', true)
    }
    const responseMimeType = normalizedMime(payload?.mimetype)
    if (!responseMimeType || (declaredMimeType && responseMimeType !== declaredMimeType)) return failure('EVOLUTION_MEDIA_MIME_INVALID', false)
    const responseSize = decodeEvolutionDocumentSize(payload?.size?.fileLength)
    if (responseSize === null) return failure('EVOLUTION_MEDIA_SIZE_INVALID', false)
    if (responseSize > MAX_EVOLUTION_PDF_BYTES) return failure('EVOLUTION_MEDIA_TOO_LARGE', false)

    const bytes = decodeStrictBase64(payload.base64)
    if (!bytes) return failure('EVOLUTION_MEDIA_BASE64_INVALID', false)
    if (responseMimeType === 'application/pdf' && (bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46 || bytes[4] !== 0x2d)) {
      return failure('EVOLUTION_MEDIA_PDF_SIGNATURE_INVALID', false)
    }
    if (bytes.byteLength > MAX_EVOLUTION_PDF_BYTES) return failure('EVOLUTION_MEDIA_TOO_LARGE', false)
    if (bytes.byteLength !== responseSize || (input.declaredSize !== undefined && bytes.byteLength !== input.declaredSize)) {
      return failure('EVOLUTION_MEDIA_SIZE_MISMATCH', false)
    }
    return { ok: true as const, bytes, mimeType: responseMimeType }
  } catch (error) {
    if (controller.signal.aborted || (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError')) {
      return failure('EVOLUTION_MEDIA_DOWNLOAD_TIMEOUT', true)
    }
    return failure('EVOLUTION_MEDIA_NETWORK', true)
  } finally {
    clearTimeout(timeout)
  }
}

/** @deprecated Use downloadEvolutionMedia for PDF, JPEG, and PNG inbound media. */
export async function downloadEvolutionPdf(input: DownloadInput) {
  if (input.declaredMimeType !== undefined && !exactPdfMime(input.declaredMimeType)) {
    return failure('EVOLUTION_MEDIA_MIME_INVALID', false)
  }
  const downloaded = await downloadEvolutionMedia(input)
  if (downloaded.ok && downloaded.mimeType !== 'application/pdf') return failure('EVOLUTION_MEDIA_MIME_INVALID', false)
  return downloaded
}
