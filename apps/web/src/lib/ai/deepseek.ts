/**
 * DeepSeek model catalog client — server-only.
 *
 * Reads the authenticated `GET https://api.deepseek.com/models` catalog and
 * projects it onto a safe `{ id, label }` shape for operator UIs. This module
 * must only be imported from server code (`'use server'` actions and React
 * Server Components): it refuses to run when a browser runtime is detected, it
 * keeps the API key inside the Authorization header, and it never returns or
 * logs the key, the response body, or the transport error message.
 */

export const DEEPSEEK_MODELS_URL = 'https://api.deepseek.com/models'
export const DEEPSEEK_MODELS_TIMEOUT_MS = 5_000

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
