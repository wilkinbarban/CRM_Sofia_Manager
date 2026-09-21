import { obterConfiguracaoSistema } from '@/lib/config/sistema'

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

const THIRTY_MINUTES_MS = 30 * 60 * 1000
const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'

/**
 * Placeholder values the operator dashboard is known to persist. These are the
 * provider-neutral fragments that replaced the retired provider-specific literal,
 * and detection stays deliberately broad: any known fragment, anywhere in the
 * value, makes the credential unusable.
 */
const PLACEHOLDER_FRAGMENTS = [
  'placeholder',
  'your_deepseek_api_key',
  'your_api_key',
  'insert_here',
  'your_key',
  'your-api-key',
]

let cachedStatus: LlmCreditStatus | null = null

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

function isPlaceholder(value: string | null | undefined): boolean {
  if (!value) return true

  const lowerValue = value.toLowerCase()
  return PLACEHOLDER_FRAGMENTS.some((placeholder) => lowerValue.includes(placeholder))
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

function staleStatus(now: Date, error: string): LlmCreditStatus {
  return {
    provider: 'deepseek',
    balanceUsd: null,
    state: cachedStatus ? 'stale' : 'unknown',
    fetchedAt: cachedStatus?.fetchedAt ?? null,
    expiresAt: cachedStatus?.expiresAt ?? null,
    freshnessMs: THIRTY_MINUTES_MS,
    color: 'neutral',
    error,
  }
}

function isCacheFresh(now: Date): boolean {
  if (!cachedStatus || cachedStatus.state !== 'fresh' || !cachedStatus.expiresAt) return false
  return new Date(cachedStatus.expiresAt).getTime() > now.getTime()
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
    throw new Error(`deepseek credits request failed with HTTP ${response.status}`)
  }

  return response.json()
}

export async function getLlmCreditStatus(options: { forceRefresh?: boolean; now?: Date } = {}): Promise<LlmCreditStatus> {
  const now = options.now ?? new Date()

  if (!options.forceRefresh && isCacheFresh(now)) {
    return cachedStatus as LlmCreditStatus
  }

  // Single credential path, exactly like the rest of the server:
  // `configuracoes_sistema` first, then `process.env`.
  const configurada = await obterConfiguracaoSistema('DEEPSEEK_API_KEY')
  const apiKey = configurada?.trim() || process.env.DEEPSEEK_API_KEY?.trim() || null

  if (isPlaceholder(apiKey)) {
    return staleStatus(now, 'DEEPSEEK_API_KEY is not configured')
  }

  try {
    const payload = await fetchDeepSeekBalance(apiKey as string)
    const status = freshStatus(parseDeepSeekRemainingUsd(payload), now)
    cachedStatus = status
    return status
  } catch (error) {
    return staleStatus(now, error instanceof Error ? error.message : 'Unknown DeepSeek credit provider error')
  }
}

export function resetLlmCreditStatusCacheForTests() {
  cachedStatus = null
}
