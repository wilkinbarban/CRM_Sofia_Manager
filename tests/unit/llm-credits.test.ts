import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getLlmCreditColor,
  getLlmCreditStatus,
  parseDeepSeekRemainingUsd,
  resetLlmCreditStatusCacheForTests,
  type LlmCreditProvider,
} from '@/lib/ai/credits'

const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'

const mocks = vi.hoisted(() => ({
  obterConfiguracaoSistema: vi.fn(),
}))

vi.mock('@/lib/config/sistema', () => ({
  obterConfiguracaoSistema: mocks.obterConfiguracaoSistema,
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

  it('returns neutral stale status without presenting cached balance as current when refresh fails', async () => {
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
      balanceUsd: null,
      state: 'stale',
      color: 'neutral',
      fetchedAt: '2026-07-10T12:00:00.000Z',
    })
  })
})
