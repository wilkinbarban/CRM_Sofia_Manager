import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getLlmCreditColor,
  getLlmCreditStatus,
  invalidateLlmCreditStatusCache,
  parseDeepSeekRemainingUsd,
  resetLlmCreditStatusCacheForTests,
  type LlmCreditProvider,
} from '@/lib/ai/credits'
import { removerConfiguracaoAdmin, salvarConfiguracaoAdmin } from '@/app/actions/admin'

const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'

const mocks = vi.hoisted(() => ({
  obterConfiguracaoSistema: vi.fn(),
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  revalidatePath: vi.fn(),
}))

vi.mock('@/lib/config/sistema', () => ({
  obterConfiguracaoSistema: mocks.obterConfiguracaoSistema,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: mocks.createClient,
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: mocks.createAdminClient,
}))

vi.mock('next/cache', () => ({
  revalidatePath: mocks.revalidatePath,
}))

const originalEnv = process.env

function balanceResponse(totalBalance = '2.5'): Response {
  return new Response(JSON.stringify({
    balance_infos: [{ currency: 'USD', total_balance: totalBalance }],
  }), { status: 200 })
}

function mockDeepSeekKey(stored: string | null) {
  mocks.obterConfiguracaoSistema.mockImplementation(async (key: string) => (
    key === 'DEEPSEEK_API_KEY' ? stored : null
  ))
}

function mockOperatorAdmin() {
  const upsert = vi.fn().mockResolvedValue({ error: null })
  const deleteFn = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) })
  const insert = vi.fn().mockResolvedValue({ error: null })

  mocks.createClient.mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: 'admin-123' } },
        error: null,
      }),
    },
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { funcao: 'admin', ativo: true },
        error: null,
      }),
    })),
  })

  mocks.createAdminClient.mockReturnValue({
    from: vi.fn((table: string) => {
      if (table === 'configuracoes_sistema') {
        return { upsert, delete: deleteFn }
      }
      return { insert }
    }),
  })

  return { upsert, deleteFn, insert }
}

afterEach(() => {
  resetLlmCreditStatusCacheForTests()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  process.env = originalEnv
})

describe('LLM credit helpers', () => {
  it('maps USD balance to status colors', () => {
    expect(getLlmCreditColor(2.01)).toBe('green')
    expect(getLlmCreditColor(1.5)).toBe('yellow')
    expect(getLlmCreditColor(1)).toBe('red')
    expect(getLlmCreditColor(0.75)).toBe('red')
    expect(getLlmCreditColor(null)).toBe('neutral')
  })

  it('exposes DeepSeek as the only credit provider', () => {
    const provider: LlmCreditProvider = 'deepseek'

    expect(provider).toBe('deepseek')
  })

  it('parses DeepSeek USD balances when present', () => {
    expect(parseDeepSeekRemainingUsd({
      balance_infos: [
        { currency: 'CNY', total_balance: '18.50' },
        { currency: 'USD', total_balance: '2.75' },
      ],
    })).toBe(2.75)
  })

  it('does not convert DeepSeek CNY-only balances into fake USD', () => {
    expect(parseDeepSeekRemainingUsd({
      balance_infos: [
        { currency: 'CNY', total_balance: '18.50' },
      ],
    })).toBeNull()
  })

  it('resolves the balance from the DeepSeek credential stored in configuracoes_sistema', async () => {
    mockDeepSeekKey('sk-deepseek-database-key')
    process.env = { ...originalEnv, DEEPSEEK_API_KEY: 'sk-deepseek-environment-key' }
    const fetchMock = vi.fn(async () => balanceResponse('2.5'))
    vi.stubGlobal('fetch', fetchMock)

    const status = await getLlmCreditStatus({ now: new Date('2026-07-10T12:00:00.000Z') })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(DEEPSEEK_BALANCE_URL)
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-deepseek-database-key' })
    expect(status).toMatchObject({
      provider: 'deepseek',
      balanceUsd: 2.5,
      state: 'fresh',
      color: 'green',
      fetchedAt: '2026-07-10T12:00:00.000Z',
    })
  })

  it('falls back to the environment credential and consults only the DeepSeek key', async () => {
    mockDeepSeekKey(null)
    process.env = { ...originalEnv, DEEPSEEK_API_KEY: 'sk-deepseek-environment-key' }
    const fetchMock = vi.fn(async () => balanceResponse('4'))
    vi.stubGlobal('fetch', fetchMock)

    const status = await getLlmCreditStatus({ now: new Date('2026-07-10T12:00:00.000Z') })

    expect(status).toMatchObject({ provider: 'deepseek', balanceUsd: 4, state: 'fresh' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-deepseek-environment-key' })
    expect(mocks.obterConfiguracaoSistema.mock.calls.map((args) => args[0])).toEqual(['DEEPSEEK_API_KEY'])
  })

  it('rejects a stored placeholder credential without any provider request', async () => {
    process.env = { ...originalEnv }
    delete process.env.DEEPSEEK_API_KEY
    mockDeepSeekKey('your_deepseek_api_key')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const status = await getLlmCreditStatus({ now: new Date('2026-07-10T12:00:00.000Z') })

    expect(status).toMatchObject({
      provider: 'deepseek',
      balanceUsd: null,
      state: 'unknown',
      color: 'neutral',
      fetchedAt: null,
    })
    expect(status.error).toContain('DEEPSEEK_API_KEY')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads the balance with the environment credential when the stored value is an unusable placeholder', async () => {
    mockDeepSeekKey('sk-your-api-key-placeholder')
    process.env = { ...originalEnv, DEEPSEEK_API_KEY: 'sk-deepseek-environment-key' }
    const fetchMock = vi.fn(async () => balanceResponse('3'))
    vi.stubGlobal('fetch', fetchMock)

    const status = await getLlmCreditStatus({ now: new Date('2026-07-10T12:00:00.000Z') })

    expect(status).toMatchObject({ provider: 'deepseek', balanceUsd: 3, state: 'fresh', color: 'green' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(DEEPSEEK_BALANCE_URL)
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-deepseek-environment-key' })
  })

  it('treats a whitespace-only stored credential as unusable and uses the environment one', async () => {
    mockDeepSeekKey('   ')
    process.env = { ...originalEnv, DEEPSEEK_API_KEY: '  sk-deepseek-padded-environment-key  ' }
    const fetchMock = vi.fn(async () => balanceResponse('1.5'))
    vi.stubGlobal('fetch', fetchMock)

    const status = await getLlmCreditStatus({ now: new Date('2026-07-10T12:00:00.000Z') })

    expect(status).toMatchObject({ provider: 'deepseek', balanceUsd: 1.5, state: 'fresh', color: 'yellow' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-deepseek-padded-environment-key' })
  })

  it('preserves cached balance as explicitly stale when refresh fails with transient error', async () => {
    mockDeepSeekKey('sk-deepseek-database-key')
    vi.stubGlobal('fetch', vi.fn(async () => balanceResponse('2.5')))

    const fresh = await getLlmCreditStatus({ now: new Date('2026-07-10T12:00:00.000Z') })
    expect(fresh).toMatchObject({
      provider: 'deepseek',
      balanceUsd: 2.5,
      state: 'fresh',
      color: 'green',
      fetchedAt: '2026-07-10T12:00:00.000Z',
    })

    vi.stubGlobal('fetch', vi.fn(async () => new Response('provider down', { status: 503 })))

    const stale = await getLlmCreditStatus({
      forceRefresh: true,
      now: new Date('2026-07-10T12:31:00.000Z'),
    })

    expect(stale).toMatchObject({
      provider: 'deepseek',
      balanceUsd: 2.5,
      state: 'stale',
      color: 'green',
      fetchedAt: '2026-07-10T12:00:00.000Z',
    })
    expect(stale.state).toBe('stale')
    expect(stale.error).toContain('503')
  })

  it('resolves the credential before accepting a cached fresh result and rejects cache from a previous credential', async () => {
    mockDeepSeekKey('sk-deepseek-first-key')
    const fetchMock = vi.fn(async () => balanceResponse('2.5'))
    vi.stubGlobal('fetch', fetchMock)

    const initial = await getLlmCreditStatus({ now: new Date('2026-07-10T12:00:00.000Z') })
    expect(initial.balanceUsd).toBe(2.5)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Key changes in database before cache expiration
    mockDeepSeekKey('sk-deepseek-second-key')
    fetchMock.mockImplementation(async () => balanceResponse('7.0'))

    const updated = await getLlmCreditStatus({ now: new Date('2026-07-10T12:05:00.000Z') })
    expect(updated).toMatchObject({
      provider: 'deepseek',
      balanceUsd: 7.0,
      state: 'fresh',
      color: 'green',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-deepseek-second-key' })
  })

  it('does not leak or log credential material in the status payload or console', async () => {
    const secretKey = 'sk-deepseek-secret-never-persisted'
    mockDeepSeekKey(secretKey)
    vi.stubGlobal('fetch', vi.fn(async () => balanceResponse('2.5')))

    const status = await getLlmCreditStatus({ now: new Date('2026-07-10T12:00:00.000Z') })
    const serialized = JSON.stringify(status)

    expect(serialized).not.toContain(secretKey)
    expect(Object.keys(status)).not.toContain('apiKey')
    expect(Object.keys(status)).not.toContain('credential')
  })

  it('purges cache and returns neutral unknown on HTTP 401 unauthorized', async () => {
    mockDeepSeekKey('sk-deepseek-database-key')
    vi.stubGlobal('fetch', vi.fn(async () => balanceResponse('2.5')))

    const fresh = await getLlmCreditStatus({ now: new Date('2026-07-10T12:00:00.000Z') })
    expect(fresh.balanceUsd).toBe(2.5)

    // Revocation via 401
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Unauthorized', { status: 401 })))

    const revoked = await getLlmCreditStatus({
      forceRefresh: true,
      now: new Date('2026-07-10T12:05:00.000Z'),
    })

    expect(revoked).toMatchObject({
      provider: 'deepseek',
      balanceUsd: null,
      state: 'unknown',
      color: 'neutral',
      fetchedAt: null,
      expiresAt: null,
    })
    expect(revoked.error).toContain('401')

    // Subsequent transient error after 401 must not resurrect previous balance
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Gateway timeout', { status: 504 })))

    const subsequent = await getLlmCreditStatus({
      forceRefresh: true,
      now: new Date('2026-07-10T12:10:00.000Z'),
    })

    expect(subsequent).toMatchObject({
      provider: 'deepseek',
      balanceUsd: null,
      state: 'unknown',
      color: 'neutral',
    })
  })

  it('purges cache and returns neutral unknown on HTTP 403 forbidden', async () => {
    mockDeepSeekKey('sk-deepseek-database-key')
    vi.stubGlobal('fetch', vi.fn(async () => balanceResponse('2.5')))

    await getLlmCreditStatus({ now: new Date('2026-07-10T12:00:00.000Z') })

    vi.stubGlobal('fetch', vi.fn(async () => new Response('Forbidden', { status: 403 })))

    const forbidden = await getLlmCreditStatus({
      forceRefresh: true,
      now: new Date('2026-07-10T12:05:00.000Z'),
    })

    expect(forbidden).toMatchObject({
      provider: 'deepseek',
      balanceUsd: null,
      state: 'unknown',
      color: 'neutral',
      fetchedAt: null,
      expiresAt: null,
    })
    expect(forbidden.error).toContain('403')
  })

  it('purges cache and returns neutral unknown when credential is removed/missing', async () => {
    mockDeepSeekKey('sk-deepseek-database-key')
    vi.stubGlobal('fetch', vi.fn(async () => balanceResponse('2.5')))

    const fresh = await getLlmCreditStatus({ now: new Date('2026-07-10T12:00:00.000Z') })
    expect(fresh.balanceUsd).toBe(2.5)

    // Key cleared
    mockDeepSeekKey(null)
    delete process.env.DEEPSEEK_API_KEY
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const cleared = await getLlmCreditStatus({ now: new Date('2026-07-10T12:05:00.000Z') })

    expect(cleared).toMatchObject({
      provider: 'deepseek',
      balanceUsd: null,
      state: 'unknown',
      color: 'neutral',
      fetchedAt: null,
      expiresAt: null,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns neutral unknown on transient error if there is no previous balance for active credential', async () => {
    mockDeepSeekKey('sk-deepseek-first-key')
    vi.stubGlobal('fetch', vi.fn(async () => balanceResponse('2.5')))

    await getLlmCreditStatus({ now: new Date('2026-07-10T12:00:00.000Z') })

    // Switch to new key that immediately suffers a transient 503
    mockDeepSeekKey('sk-deepseek-second-key')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Service Unavailable', { status: 503 })))

    const status = await getLlmCreditStatus({ now: new Date('2026-07-10T12:05:00.000Z') })

    // Must NOT inherit first key's balance
    expect(status).toMatchObject({
      provider: 'deepseek',
      balanceUsd: null,
      state: 'unknown',
      color: 'neutral',
    })
  })

  it('exports invalidateLlmCreditStatusCache and purges cached status', async () => {
    mockDeepSeekKey('sk-deepseek-key')
    const fetchMock = vi.fn(async () => balanceResponse('2.5'))
    vi.stubGlobal('fetch', fetchMock)

    await getLlmCreditStatus({ now: new Date('2026-07-10T12:00:00.000Z') })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Normal non-forced call uses cache
    await getLlmCreditStatus({ now: new Date('2026-07-10T12:05:00.000Z') })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Invalidation forces re-fetch on next non-forced call
    invalidateLlmCreditStatusCache()
    await getLlmCreditStatus({ now: new Date('2026-07-10T12:06:00.000Z') })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('invalidates credit cache when salvarConfiguracaoAdmin updates DEEPSEEK_API_KEY', async () => {
    mockOperatorAdmin()
    mockDeepSeekKey('sk-deepseek-old-key')
    const fetchMock = vi.fn(async () => balanceResponse('1.5'))
    vi.stubGlobal('fetch', fetchMock)

    const initial = await getLlmCreditStatus({ now: new Date('2026-07-10T12:00:00.000Z') })
    expect(initial.balanceUsd).toBe(1.5)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Admin updates DEEPSEEK_API_KEY
    mockDeepSeekKey('sk-deepseek-new-key')
    fetchMock.mockImplementation(async () => balanceResponse('8.0'))

    const writeResult = await salvarConfiguracaoAdmin('DEEPSEEK_API_KEY', 'sk-deepseek-new-key')
    expect(writeResult).toEqual({ success: true })

    // Next getLlmCreditStatus call must fetch fresh balance because cache was invalidated
    const updated = await getLlmCreditStatus({ now: new Date('2026-07-10T12:01:00.000Z') })
    expect(updated.balanceUsd).toBe(8.0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('invalidates credit cache when admin write path clears DEEPSEEK_API_KEY', async () => {
    mockOperatorAdmin()
    mockDeepSeekKey('sk-deepseek-key')
    const fetchMock = vi.fn(async () => balanceResponse('2.5'))
    vi.stubGlobal('fetch', fetchMock)

    await getLlmCreditStatus({ now: new Date('2026-07-10T12:00:00.000Z') })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    mockDeepSeekKey(null)
    delete process.env.DEEPSEEK_API_KEY

    const clearResult = await removerConfiguracaoAdmin('DEEPSEEK_API_KEY')
    expect(clearResult).toEqual({ success: true })

    const clearedStatus = await getLlmCreditStatus({ now: new Date('2026-07-10T12:01:00.000Z') })
    expect(clearedStatus).toMatchObject({
      balanceUsd: null,
      state: 'unknown',
      color: 'neutral',
    })
  })

  it('does not invalidate credit cache when salvarConfiguracaoAdmin updates an unrelated key', async () => {
    mockOperatorAdmin()
    mockDeepSeekKey('sk-deepseek-key')
    const fetchMock = vi.fn(async () => balanceResponse('2.5'))
    vi.stubGlobal('fetch', fetchMock)

    await getLlmCreditStatus({ now: new Date('2026-07-10T12:00:00.000Z') })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const writeResult = await salvarConfiguracaoAdmin('WHATSAPP_PHONE_NUMBER_ID', '123456789')
    expect(writeResult).toEqual({ success: true })

    // Cache remains warm
    await getLlmCreditStatus({ now: new Date('2026-07-10T12:01:00.000Z') })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('prevents callers from mutating cached credit status via the initially returned fresh object or subsequent cache reads', async () => {
    mockDeepSeekKey('sk-deepseek-database-key')
    const fetchMock = vi.fn(async () => balanceResponse('2.5'))
    vi.stubGlobal('fetch', fetchMock)

    // Initial fresh fetch
    const initial = await getLlmCreditStatus({ now: new Date('2026-07-10T12:00:00.000Z') })
    expect(initial.balanceUsd).toBe(2.5)
    expect(initial.state).toBe('fresh')
    expect(initial.color).toBe('green')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Caller mutates the initial fresh object
    initial.balanceUsd = 999
    initial.state = 'unknown'
    initial.color = 'neutral'
    initial.error = 'external corruption'

    // Cached fresh read must not reflect caller mutation
    const cached = await getLlmCreditStatus({ now: new Date('2026-07-10T12:05:00.000Z') })
    expect(cached).not.toBe(initial)
    expect(cached.balanceUsd).toBe(2.5)
    expect(cached.state).toBe('fresh')
    expect(cached.color).toBe('green')
    expect(cached.error).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Caller mutates the cached read object
    cached.balanceUsd = 888
    cached.state = 'stale'

    // Subsequent cached read must still remain uncorrupted
    const subsequent = await getLlmCreditStatus({ now: new Date('2026-07-10T12:10:00.000Z') })
    expect(subsequent).not.toBe(cached)
    expect(subsequent.balanceUsd).toBe(2.5)
    expect(subsequent.state).toBe('fresh')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('prevents callers from mutating cached credit status via returned stale fallback objects', async () => {
    mockDeepSeekKey('sk-deepseek-database-key')
    vi.stubGlobal('fetch', vi.fn(async () => balanceResponse('2.5')))

    const fresh = await getLlmCreditStatus({ now: new Date('2026-07-10T12:00:00.000Z') })
    expect(fresh.balanceUsd).toBe(2.5)

    // Transient failure forces stale fallback
    vi.stubGlobal('fetch', vi.fn(async () => new Response('provider down', { status: 503 })))

    const stale = await getLlmCreditStatus({
      forceRefresh: true,
      now: new Date('2026-07-10T12:31:00.000Z'),
    })
    expect(stale).toMatchObject({
      balanceUsd: 2.5,
      state: 'stale',
      color: 'green',
    })

    // Caller mutates the returned stale fallback object
    stale.balanceUsd = 777
    stale.state = 'unknown'
    stale.color = 'neutral'

    // Another transient failure should still fall back to the original cached balance
    const staleSecond = await getLlmCreditStatus({
      forceRefresh: true,
      now: new Date('2026-07-10T12:32:00.000Z'),
    })
    expect(staleSecond).not.toBe(stale)
    expect(staleSecond.balanceUsd).toBe(2.5)
    expect(staleSecond.state).toBe('stale')
    expect(staleSecond.color).toBe('green')

    // When provider recovers, next attempt fetches and returns new fresh balance
    vi.stubGlobal('fetch', vi.fn(async () => balanceResponse('5.0')))
    const recovered = await getLlmCreditStatus({
      now: new Date('2026-07-10T12:33:00.000Z'),
    })
    expect(recovered).toMatchObject({
      balanceUsd: 5.0,
      state: 'fresh',
      color: 'green',
    })
  })
})
