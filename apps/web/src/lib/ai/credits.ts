import { createHash } from 'node:crypto'
import { resolverChaveDeepSeek } from '@/lib/ai/deepseek'

/** Sofia's only configured LLM provider: the retired second adapter is gone. */
export type LlmCreditProvider = 'deepseek'
export type LlmCreditColor = 'green' | 'yellow' | 'red' | 'neutral'
export type LlmCreditState = 'fresh' | 'stale' | 'unknown'

export type LlmCreditStatus = {
  provider: LlmCreditProvider
  balanceUsd: number | null
  state: LlmCreditState
  fetchedAt: string | null
  expiresAt: string | null
  freshnessMs: number
  color: LlmCreditColor
  error?: string
}

type JsonRecord = Record<string, unknown>

type CachedCreditEntry = {
  status: LlmCreditStatus
  credentialHash: string
}

const THIRTY_MINUTES_MS = 30 * 60 * 1000
const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'

let cachedEntry: CachedCreditEntry | null = null
let cacheGeneration = 0

function hashCredential(credential: string): string {
  return createHash('sha256').update(credential).digest('hex')
}

export function getLlmCreditColor(balanceUsd: number | null): LlmCreditColor {
  if (balanceUsd == null || !Number.isFinite(balanceUsd)) return 'neutral'
  if (balanceUsd > 2) return 'green'
  if (balanceUsd > 1) return 'yellow'
  return 'red'
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
}

function readNumber(source: JsonRecord | null, keys: string[]): number | null {
  if (!source) return null

  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }

  return null
}

export function parseDeepSeekRemainingUsd(balancePayload: unknown): number | null {
  const root = asRecord(balancePayload)
  const balanceInfos = Array.isArray(root?.balance_infos) ? root.balance_infos : []

  for (const item of balanceInfos) {
    const balance = asRecord(item)
    if (typeof balance?.currency !== 'string') continue
    if (balance.currency.toUpperCase() !== 'USD') continue
    return readNumber(balance, ['total_balance'])
  }

  return null
}

function cloneStatus(status: LlmCreditStatus): LlmCreditStatus {
  return { ...status }
}

function freshStatus(balanceUsd: number | null, now: Date): LlmCreditStatus {
  const fetchedAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + THIRTY_MINUTES_MS).toISOString()

  return {
    provider: 'deepseek',
    balanceUsd,
    state: balanceUsd == null ? 'unknown' : 'fresh',
    fetchedAt,
    expiresAt,
    freshnessMs: THIRTY_MINUTES_MS,
    color: getLlmCreditColor(balanceUsd),
  }
}

function unknownStatus(error: string): LlmCreditStatus {
  return {
    provider: 'deepseek',
    balanceUsd: null,
    state: 'unknown',
    fetchedAt: null,
    expiresAt: null,
    freshnessMs: THIRTY_MINUTES_MS,
    color: 'neutral',
    error,
  }
}

function staleStatus(cached: CachedCreditEntry, error: string): LlmCreditStatus {
  return {
    provider: 'deepseek',
    balanceUsd: cached.status.balanceUsd,
    state: 'stale',
    fetchedAt: cached.status.fetchedAt,
    expiresAt: cached.status.expiresAt,
    freshnessMs: THIRTY_MINUTES_MS,
    color: getLlmCreditColor(cached.status.balanceUsd),
    error,
  }
}

class DeepSeekCreditsHttpError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`deepseek credits request failed with HTTP ${status}`)
    this.name = 'DeepSeekCreditsHttpError'
    this.status = status
  }
}

async function fetchDeepSeekBalance(apiKey: string): Promise<unknown> {
  const response = await fetch(DEEPSEEK_BALANCE_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  })

  if (!response.ok) {
    throw new DeepSeekCreditsHttpError(response.status)
  }

  return response.json()
}

/**
 * Invalidates the cached LLM credits status across server actions and background tasks.
 */
export function invalidateLlmCreditStatusCache(): void {
  cachedEntry = null
  cacheGeneration++
}

export function resetLlmCreditStatusCacheForTests(): void {
  invalidateLlmCreditStatusCache()
}

export async function getLlmCreditStatus(options: { forceRefresh?: boolean; now?: Date } = {}): Promise<LlmCreditStatus> {
  const now = options.now ?? new Date()
  const startGeneration = cacheGeneration

  // Single credential path, shared with generation and the operator panel:
  // `configuracoes_sistema` first, then `process.env`, and an unusable stored
  // value gives way to a usable environment one.
  const apiKey = await resolverChaveDeepSeek()

  // A missing, empty, or placeholder credential invalidates any previously cached
  // balance and returns neutral unknown.
  if (!apiKey) {
    invalidateLlmCreditStatusCache()
    return unknownStatus('DEEPSEEK_API_KEY is not configured')
  }

  const credentialHash = hashCredential(apiKey)
  const currentCached = cachedEntry
  const isMatchingCredential = currentCached !== null && currentCached.credentialHash === credentialHash
  const isFresh =
    isMatchingCredential &&
    currentCached.status.state === 'fresh' &&
    currentCached.status.expiresAt != null &&
    new Date(currentCached.status.expiresAt).getTime() > now.getTime()

  if (!options.forceRefresh && isFresh && currentCached !== null) {
    return cloneStatus(currentCached.status)
  }

  try {
    const payload = await fetchDeepSeekBalance(apiKey)
    const status = freshStatus(parseDeepSeekRemainingUsd(payload), now)
    if (cacheGeneration === startGeneration) {
      cachedEntry = { status: cloneStatus(status), credentialHash }
      cacheGeneration++
    }
    return cloneStatus(status)
  } catch (error) {
    const isAuthRevoked =
      (error instanceof DeepSeekCreditsHttpError && (error.status === 401 || error.status === 403)) ||
      (error instanceof Error && /HTTP\s+(401|403)\b/.test(error.message))

    if (isAuthRevoked) {
      if (
        cacheGeneration === startGeneration &&
        cachedEntry !== null &&
        cachedEntry.credentialHash === credentialHash
      ) {
        invalidateLlmCreditStatusCache()
      }
      return unknownStatus(
        error instanceof Error ? error.message : 'DeepSeek credit authorization failed',
      )
    }

    const errorMessage = error instanceof Error ? error.message : 'Unknown DeepSeek credit provider error'

    if (
      cacheGeneration === startGeneration &&
      isMatchingCredential &&
      cachedEntry !== null &&
      cachedEntry.credentialHash === credentialHash &&
      cachedEntry.status.balanceUsd != null
    ) {
      const stale = staleStatus(cachedEntry, errorMessage)
      cachedEntry = { status: cloneStatus(stale), credentialHash }
      cacheGeneration++
      return cloneStatus(stale)
    }

    return unknownStatus(errorMessage)
  }
}
