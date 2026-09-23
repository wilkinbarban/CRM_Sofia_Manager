/**
 * DeepSeek model catalog, chat probe and general chat client — server-only.
 *
 * Reads the authenticated `GET https://api.deepseek.com/models` catalog and
 * projects it onto a safe `{ id, label }` shape for operator UIs, probes the
 * fixed `POST https://api.deepseek.com/chat/completions` endpoint with an
 * operator-selected model, and sends real conversations through
 * `chamarDeepSeekChat` for Sofia's generation and JSON extraction. This module
 * must only be imported from server code (`'use server'` actions and React
 * Server Components): it refuses to run when a browser runtime is detected, it
 * keeps the API key inside the Authorization header, and it never returns or
 * logs the key, the response body, or the transport error message.
 */

import { obterConfiguracaoSistema } from '@/lib/config/sistema'

export const DEEPSEEK_MODELS_URL = 'https://api.deepseek.com/models'
export const DEEPSEEK_MODELS_TIMEOUT_MS = 5_000
export const DEEPSEEK_CHAT_COMPLETIONS_URL = 'https://api.deepseek.com/chat/completions'
export const DEEPSEEK_CHAT_TIMEOUT_MS = 15_000

/** Fallback when neither the database nor the environment selects a usable
 * value (https://api-docs.deepseek.com/api/create-chat-completion). */
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-flash'

/** Retry policy of `chamarDeepSeekChat`, exported so tests can pin it. */
export const DEEPSEEK_CHAT_MAX_ATTEMPTS = 2
export const DEEPSEEK_CHAT_RETRY_BASE_DELAY_MS = 250

/** Hard ceiling on the provider response body: it bounds the streamed read. */
export const DEEPSEEK_MAX_RESPONSE_BYTES = 1024 * 1024

/** Hard ceiling on the accepted assistant content, applied before trimming. */
export const DEEPSEEK_MAX_CONTENT_CHARS = 16_000

export type DeepSeekModelOption = {
  id: string
  label: string
}

export type DeepSeekModelsError =
  | 'DEEPSEEK_SERVER_ONLY'
  | 'DEEPSEEK_NOT_CONFIGURED'
  | 'DEEPSEEK_TIMEOUT'
  | 'DEEPSEEK_HTTP_ERROR'
  | 'DEEPSEEK_INVALID_RESPONSE'
  | 'DEEPSEEK_REQUEST_FAILED'

export type DeepSeekModelsResult =
  | { success: true; models: DeepSeekModelOption[] }
  | { success: false; error: DeepSeekModelsError; status?: number }

export type DeepSeekModelsInput = {
  apiKey: string | null | undefined
  timeoutMs?: number
}

export type DeepSeekChatProbeError =
  | 'DEEPSEEK_SERVER_ONLY'
  | 'DEEPSEEK_MODEL_REQUIRED'
  | 'DEEPSEEK_NOT_CONFIGURED'
  | 'DEEPSEEK_TIMEOUT'
  | 'DEEPSEEK_HTTP_ERROR'
  | 'DEEPSEEK_REQUEST_FAILED'

/** The probe reports reachability only: never the provider body or the reply. */
export type DeepSeekChatProbeResult =
  | { success: true; model: string }
  | { success: false; error: DeepSeekChatProbeError; status?: number }

export type DeepSeekChatProbeInput = {
  apiKey: string | null | undefined
  model: unknown
  timeoutMs?: number
}

/** The two content blocks the chat-completions endpoint accepts alongside text. */
export type DeepSeekChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export type DeepSeekChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string | DeepSeekChatContentPart[]
}

/**
 * Chat-completions ids that accept image content parts, per the official vision
 * guide (https://api-docs.deepseek.com/guides/vision/) and the pricing page
 * (https://api-docs.deepseek.com/quick_start/pricing): `deepseek-flash` is the
 * current chat-completions model and the vision-capable one, while
 * `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are accepted legacy
 * names that are retired and served by the latest Flash model. Every other id —
 * `deepseek-v4-pro` included — is text-only.
 */
export const DEEPSEEK_VISION_MODELS: readonly string[] = [
  'deepseek-flash',
  'deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp',
]

/** True only for an exact allowlisted vision id; every other value is text-only. */
export function isDeepSeekVisionModel(model: unknown): boolean {
  const id = typeof model === 'string' ? model.trim().toLowerCase() : ''
  return id.length > 0 && DEEPSEEK_VISION_MODELS.includes(id)
}

export type DeepSeekChatError =
  | 'DEEPSEEK_SERVER_ONLY'
  | 'DEEPSEEK_MODEL_REQUIRED'
  | 'DEEPSEEK_VISION_UNSUPPORTED'
  | 'DEEPSEEK_NOT_CONFIGURED'
  | 'DEEPSEEK_TIMEOUT'
  | 'DEEPSEEK_HTTP_ERROR'
  | 'DEEPSEEK_REQUEST_FAILED'
  | 'DEEPSEEK_INVALID_RESPONSE'
  | 'DEEPSEEK_EMPTY_RESPONSE'
  | 'DEEPSEEK_RESPONSE_TOO_LARGE'

export type DeepSeekChatResult =
  | { success: true; content: string }
  // Every runtime failure return sets `attempts` and `retried`; they are optional
  // here only so pre-existing callers and test doubles stay assignable.
  | { success: false; error: DeepSeekChatError; status?: number; attempts?: number; retried?: boolean }

export type DeepSeekChatInput = {
  apiKey: string | null | undefined
  model: string
  messages: DeepSeekChatMessage[]
  temperature: number
  maxTokens: number
  timeoutMs?: number
  /** Adds `response_format: { type: 'json_object' }`; the prompt must instruct JSON. */
  jsonResponse?: boolean
  maxResponseBytes?: number
  maxContentChars?: number
}

/**
 * Placeholder values the operator dashboard is known to persist: the union of
 * the fragments this boundary and the credits panel used to carry separately,
 * now with a single home. Detection stays deliberately broad: any known
 * fragment, anywhere in the value (case-insensitive), makes it unusable.
 */
const PLACEHOLDER_FRAGMENTS = [
  'placeholder',
  'your_deepseek_api_key',
  'your_api_key',
  'insert_here',
  'your_key',
  'your-api-key',
]

/** True when the value carries a placeholder fragment the dashboard is known to
 * persist. Deliberately broad: any known fragment, anywhere in the value. */
function temFragmentoPlaceholder(value: string): boolean {
  const normalizado = value.toLowerCase()
  return PLACEHOLDER_FRAGMENTS.some((fragment) => normalizado.includes(fragment))
}

/**
 * A key is usable only when it is present and is not one of the placeholder
 * values that the operator dashboard is known to persist.
 */
export function isUsableDeepSeekApiKey(value: string | null | undefined): boolean {
  const apiKey = value?.trim()
  if (!apiKey) return false

  return !temFragmentoPlaceholder(apiKey)
}

/** The credential value already trimmed, or null when it cannot be a key. */
function chaveUtilizavel(value: string | null | undefined): string | null {
  const chave = typeof value === 'string' ? value.trim() : ''
  return isUsableDeepSeekApiKey(chave) ? chave : null
}

/**
 * The single credential rule: a usable stored value wins, an unusable stored
 * value is treated as absent and hands over to a usable environment value, and
 * the empty string is the last resort. Usability is `isUsableDeepSeekApiKey`
 * and the returned value is trimmed. Synchronous on purpose, so the server
 * component that already holds both values can apply the same rule without a
 * second configuration read.
 */
export function escolherChaveDeepSeek(
  armazenada: string | null | undefined,
  doAmbiente: string | null | undefined,
): string {
  return chaveUtilizavel(armazenada) ?? chaveUtilizavel(doAmbiente) ?? ''
}

/**
 * Server-only resolution of the DeepSeek credential: `configuracoes_sistema`
 * first, `process.env` second, the empty string last. It delegates the
 * precedence to `escolherChaveDeepSeek`, so every server path that resolves
 * this credential — generation, JSON extraction, the operator actions, the
 * credits panel and the admin projection — agrees with the others instead of
 * keeping its own copy.
 */
export async function resolverChaveDeepSeek(): Promise<string> {
  return escolherChaveDeepSeek(
    await obterConfiguracaoSistema('DEEPSEEK_API_KEY'),
    process.env.DEEPSEEK_API_KEY,
  )
}

/** The trimmed model id, or null when the value cannot be one: empty, blank, a
 * control character, or a known placeholder fragment persisted by the
 * dashboard — the same list the credential predicate uses. */
function modeloValido(value: unknown): string | null {
  const modelo = typeof value === 'string' ? value.trim() : ''
  if (!modelo || /[\s\u0000-\u001f\u007f]/.test(modelo)) return null
  if (temFragmentoPlaceholder(modelo)) return null
  return modelo
}

/** Effective model id: an unusable value falls back to `DEEPSEEK_DEFAULT_MODEL`. */
export function normalizarModeloDeepSeek(value: unknown): string {
  return modeloValido(value) ?? DEEPSEEK_DEFAULT_MODEL
}

/**
 * The single model rule: a usable stored value wins, an unusable stored
 * value is treated as absent and hands over to a usable environment value, and
 * `DEEPSEEK_DEFAULT_MODEL` is the last resort. Usability is `modeloValido`
 * (not empty, not blank, no whitespace/control characters, not a known
 * placeholder). Synchronous on purpose, so the server component that already
 * holds both values can apply the same rule without a second configuration
 * read.
 */
export function escolherModeloDeepSeek(
  armazenado: unknown,
  doAmbiente: unknown = process.env.DEEPSEEK_MODEL,
): string {
  return modeloValido(armazenado) ?? modeloValido(doAmbiente) ?? DEEPSEEK_DEFAULT_MODEL
}

/** Single resolution path: `configuracoes_sistema`, then `process.env`, then the default.
 * An unusable stored value falls through to the environment by design — a usable deployment value beats an unusable operator entry — instead of going straight to the default. Only a usable value (not empty, not blank, not a known placeholder) is accepted. */
export async function resolverModeloDeepSeek(): Promise<string> {
  const configurado = await obterConfiguracaoSistema('DEEPSEEK_MODEL')
  return escolherModeloDeepSeek(configurado, process.env.DEEPSEEK_MODEL)
}

function assertServerRuntime(): void {
  if (typeof globalThis.window !== 'undefined') {
    throw new Error('DEEPSEEK_SERVER_ONLY_CLIENT')
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function normalizeModelEntries(payload: unknown): DeepSeekModelOption[] {
  const entries = asRecord(payload)?.data
  if (!Array.isArray(entries)) return []

  const models: DeepSeekModelOption[] = []

  for (const entry of entries) {
    const record = asRecord(entry)
    const id = typeof record?.id === 'string' ? record.id.trim() : ''
    if (!id) continue

    const name = typeof record?.name === 'string' ? record.name.trim() : ''
    models.push({ id, label: name || id })
  }

  return models
}

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false

  const name = (error as { name?: unknown }).name
  return name === 'TimeoutError' || name === 'AbortError'
}

/**
 * Fetches the authorized DeepSeek models. Never throws for request, transport,
 * timeout or payload failures: every failure is reported as a stable error code.
 */
export async function listDeepSeekModels(input: DeepSeekModelsInput): Promise<DeepSeekModelsResult> {
  assertServerRuntime()

  const apiKey = input.apiKey?.trim() ?? ''
  if (!isUsableDeepSeekApiKey(apiKey)) {
    return { success: false, error: 'DEEPSEEK_NOT_CONFIGURED' }
  }

  const timeoutMs = input.timeoutMs ?? DEEPSEEK_MODELS_TIMEOUT_MS

  let response: Response
  try {
    response = await fetch(DEEPSEEK_MODELS_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return {
      success: false,
      error: isTimeoutError(error) ? 'DEEPSEEK_TIMEOUT' : 'DEEPSEEK_REQUEST_FAILED',
    }
  }

  if (!response.ok) {
    return { success: false, error: 'DEEPSEEK_HTTP_ERROR', status: response.status }
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { success: false, error: 'DEEPSEEK_INVALID_RESPONSE' }
  }

  const models = normalizeModelEntries(payload)
  if (models.length === 0) {
    return { success: false, error: 'DEEPSEEK_INVALID_RESPONSE' }
  }

  return { success: true, models }
}

/**
 * Reads a JSON body under a hard byte ceiling, mirroring the bounded guard the
 * legacy generation path used before this boundary existed. The declared
 * `content-length` is rejected up front and the streamed read is cancelled as
 * soon as the running total overflows, so an oversized provider body can never
 * be buffered whole.
 */
async function readBoundedDeepSeekJson(response: Response, maxResponseBytes: number): Promise<unknown> {
  const declared = response.headers.get('content-length')
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxResponseBytes)) {
    throw new Error('DEEPSEEK_RESPONSE_TOO_LARGE')
  }
  if (!response.body) throw new Error('DEEPSEEK_EMPTY_BODY')

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxResponseBytes) {
      await reader.cancel()
      throw new Error('DEEPSEEK_RESPONSE_TOO_LARGE')
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}

/** True when any message carries an image content part. */
function carregaImagem(messages: DeepSeekChatMessage[]): boolean {
  return messages.some((message) => Array.isArray(message.content)
    && message.content.some((part) => asRecord(part)?.type === 'image_url'))
}

/**
 * Sends a real conversation and returns the assistant text — the single provider
 * call behind Sofia's generation, the customer-memory JSON extraction and the
 * payment-proof advisory.
 *
 * Server-only like the rest of this module, it never echoes the API key and
 * never returns a raw provider body: HTTP, transport, timeout, malformed,
 * empty and oversized responses all collapse onto stable codes. The request body
 * always disables thinking (so `temperature` keeps its documented effect), keeps
 * `stream: false`, and asks for `json_object` only when the caller does.
 * Content may be a plain string or the `text`/`image_url` blocks, and an image is
 * refused before any request when the model is not on `DEEPSEEK_VISION_MODELS`.
 * A transient failure (per-attempt timeout, HTTP 429, HTTP 5xx) is retried at
 * most once behind a bounded backoff, never outliving the caller `timeoutMs`.
 * Every failure — the pre-request refusals included — reports the honest
 * `attempts` count and whether the call was actually retried.
 */
export async function chamarDeepSeekChat(input: DeepSeekChatInput): Promise<DeepSeekChatResult> {
  assertServerRuntime()

  const apiKey = input.apiKey?.trim() ?? ''
  if (!isUsableDeepSeekApiKey(apiKey)) {
    return { success: false, error: 'DEEPSEEK_NOT_CONFIGURED', attempts: 0, retried: false }
  }

  const model = typeof input.model === 'string' ? input.model.trim() : ''
  if (!model) {
    return { success: false, error: 'DEEPSEEK_MODEL_REQUIRED', attempts: 0, retried: false }
  }

  if (carregaImagem(input.messages) && !isDeepSeekVisionModel(model)) {
    return { success: false, error: 'DEEPSEEK_VISION_UNSUPPORTED', attempts: 0, retried: false }
  }

  const timeoutMs = input.timeoutMs ?? DEEPSEEK_CHAT_TIMEOUT_MS
  const maxResponseBytes = input.maxResponseBytes ?? DEEPSEEK_MAX_RESPONSE_BYTES
  const maxContentChars = input.maxContentChars ?? DEEPSEEK_MAX_CONTENT_CHARS

  const body: Record<string, unknown> = {
    model,
    messages: input.messages,
    temperature: input.temperature,
    max_tokens: input.maxTokens,
    thinking: { type: 'disabled' },
    stream: false,
  }
  if (input.jsonResponse) {
    body.response_format = { type: 'json_object' }
  }

  const deadline = Date.now() + timeoutMs
  let attempts = 0
  let response: Response | null = null
  // Last retryable failure of the loop, reported as-is when no retry is left.
  let falha: { error: DeepSeekChatError; status?: number } | null = null

  const tentar = () =>
    fetch(DEEPSEEK_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, deadline - Date.now()))),
    })

  while (!response && attempts < DEEPSEEK_CHAT_MAX_ATTEMPTS) {
    if (attempts > 0) {
      const espera = DEEPSEEK_CHAT_RETRY_BASE_DELAY_MS + Math.floor(Math.random() * 150)
      // Base backoff, jitter and one 1s attempt must still fit the caller deadline.
      if (deadline - Date.now() < espera + 1_000) break
      await new Promise((resolve) => setTimeout(resolve, espera))
    }

    attempts += 1
    falha = null
    try {
      const tentativa = await tentar()
      if (tentativa.ok) response = tentativa
      else if (tentativa.status === 429 || tentativa.status >= 500) {
        falha = { error: 'DEEPSEEK_HTTP_ERROR', status: tentativa.status }
      } else {
        // A permanent 4xx (bad key, unknown model or bad body) is never retried.
        return { success: false, error: 'DEEPSEEK_HTTP_ERROR', status: tentativa.status, attempts, retried: attempts > 1 }
      }
    } catch (error) {
      if (!isTimeoutError(error)) {
        return { success: false, error: 'DEEPSEEK_REQUEST_FAILED', attempts, retried: attempts > 1 }
      }
      falha = { error: 'DEEPSEEK_TIMEOUT' }
    }
  }

  if (!response) {
    return { success: false, error: falha?.error ?? 'DEEPSEEK_TIMEOUT', status: falha?.status, attempts, retried: attempts > 1 }
  }

  // The retry loop is over: every failure below reports its real attempt count.
  const retried = attempts > 1

  let payload: unknown
  try {
    payload = await readBoundedDeepSeekJson(response, maxResponseBytes)
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message === 'DEEPSEEK_RESPONSE_TOO_LARGE') {
      return { success: false, error: 'DEEPSEEK_RESPONSE_TOO_LARGE', attempts, retried }
    }
    if (message === 'DEEPSEEK_EMPTY_BODY') {
      return { success: false, error: 'DEEPSEEK_EMPTY_RESPONSE', attempts, retried }
    }
    return { success: false, error: 'DEEPSEEK_INVALID_RESPONSE', attempts, retried }
  }

  const choices = asRecord(payload)?.choices
  const firstChoice = Array.isArray(choices) ? asRecord(choices[0]) : null
  const content = asRecord(firstChoice?.message)?.content

  if (typeof content !== 'string') {
    return { success: false, error: 'DEEPSEEK_INVALID_RESPONSE', attempts, retried }
  }
  if (content.length > maxContentChars) {
    return { success: false, error: 'DEEPSEEK_RESPONSE_TOO_LARGE', attempts, retried }
  }

  const trimmed = content.trim()
  if (!trimmed) {
    return { success: false, error: 'DEEPSEEK_EMPTY_RESPONSE', attempts, retried }
  }

  return { success: true, content: trimmed }
}

/**
 * Probes the fixed DeepSeek chat-completions endpoint with an explicit,
 * operator-selected model.
 *
 * The probe answers one question — does the configured server-side key reach
 * the endpoint for this model — so it never projects the completion payload,
 * the provider status text, or the transport error message. A non-empty string
 * model is required: an absent, blank or non-string value short-circuits to
 * `DEEPSEEK_MODEL_REQUIRED` before any network call, which also means a caller
 * cannot smuggle a key through the model slot.
 *
 * Never throws for request, transport or timeout failures: every failure is
 * reported as a stable error code.
 */
export async function probeDeepSeekChat(input: DeepSeekChatProbeInput): Promise<DeepSeekChatProbeResult> {
  assertServerRuntime()

  const apiKey = input.apiKey?.trim() ?? ''
  if (!isUsableDeepSeekApiKey(apiKey)) {
    return { success: false, error: 'DEEPSEEK_NOT_CONFIGURED' }
  }

  const model = typeof input.model === 'string' ? input.model.trim() : ''
  if (!model) {
    return { success: false, error: 'DEEPSEEK_MODEL_REQUIRED' }
  }

  const timeoutMs = input.timeoutMs ?? DEEPSEEK_CHAT_TIMEOUT_MS

  let response: Response
  try {
    response = await fetch(DEEPSEEK_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'responda apenas com a palavra OK' }],
        max_tokens: 16,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return {
      success: false,
      error: isTimeoutError(error) ? 'DEEPSEEK_TIMEOUT' : 'DEEPSEEK_REQUEST_FAILED',
    }
  }

  if (!response.ok) {
    return { success: false, error: 'DEEPSEEK_HTTP_ERROR', status: response.status }
  }

  // The provider body is deliberately left unread: a 2xx already proves the key
  // and the selected model, and no provider text can reach the caller.
  return { success: true, model }
}
