/**
 * DeepSeek model catalog and chat probe client — server-only.
 *
 * Reads the authenticated `GET https://api.deepseek.com/models` catalog and
 * projects it onto a safe `{ id, label }` shape for operator UIs, and probes the
 * fixed `POST https://api.deepseek.com/chat/completions` endpoint with an
 * operator-selected model. This module must only be imported from server code
 * (`'use server'` actions and React Server Components): it refuses to run when a
 * browser runtime is detected, it keeps the API key inside the Authorization
 * header, and it never returns or logs the key, the response body, or the
 * transport error message.
 */

export const DEEPSEEK_MODELS_URL = 'https://api.deepseek.com/models'
export const DEEPSEEK_MODELS_TIMEOUT_MS = 5_000
export const DEEPSEEK_CHAT_COMPLETIONS_URL = 'https://api.deepseek.com/chat/completions'
export const DEEPSEEK_CHAT_TIMEOUT_MS = 15_000

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

const PLACEHOLDER_FRAGMENTS = [
  'placeholder',
  'insert_here',
  'your_key',
  'your-api-key',
  'your_openrouter_api_key',
]

/**
 * A key is usable only when it is present and is not one of the placeholder
 * values that the operator dashboard is known to persist.
 */
export function isUsableDeepSeekApiKey(value: string | null | undefined): boolean {
  const apiKey = value?.trim()
  if (!apiKey) return false

  const normalized = apiKey.toLowerCase()
  return !PLACEHOLDER_FRAGMENTS.some((fragment) => normalized.includes(fragment))
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
