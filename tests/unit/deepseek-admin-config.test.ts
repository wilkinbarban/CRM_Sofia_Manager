// @vitest-environment node

/**
 * Gated operator action that lists the authorized DeepSeek models.
 *
 * The action takes no API key argument: it resolves `DEEPSEEK_API_KEY` from the
 * existing server configuration precedence (database first, environment
 * fallback) and returns a stable not-configured error otherwise.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  revalidatePath: vi.fn(),
  obterConfiguracaoSistema: vi.fn(),
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

vi.mock('googleapis', () => ({
  google: {
    auth: { JWT: vi.fn().mockImplementation(() => ({ authorize: vi.fn() })) },
    calendar: vi.fn().mockReturnValue({ events: { insert: vi.fn() } }),
  },
}))

vi.mock('@/lib/config/sistema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/config/sistema')>()
  return { ...actual, obterConfiguracaoSistema: mocks.obterConfiguracaoSistema }
})

const CONFIGURED_KEY = 'sk-deepseek-secret-configured-key'
const ENV_KEY = 'sk-deepseek-secret-env-key'

const originalFetch = global.fetch
const originalEnv = process.env

function makeOperatorClient(role = 'admin') {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: 'operator-123' } },
        error: null,
      }),
    },
    from: vi.fn((table: string) => {
      if (table === 'perfis') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: { funcao: role, ativo: true },
            error: null,
          }),
        }
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: null, error: null }),
      }
    }),
  }
}

function mockModelsResponse() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      object: 'list',
      data: [
        { id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' },
        { id: 'deepseek-reasoner', object: 'model', owned_by: 'deepseek' },
      ],
    }),
  } as unknown as Response)
}

async function loadAction() {
  const actionsModule = await import('@/app/actions/admin')
  return actionsModule.listAuthorizedDeepSeekModels
}

describe('listAuthorizedDeepSeekModels Server Action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
    process.env = { ...originalEnv }
    delete process.env.DEEPSEEK_API_KEY
  })

  afterEach(() => {
    global.fetch = originalFetch
    process.env = originalEnv
  })

  it('rejects a caller without operator permissions', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch
    mocks.createClient.mockResolvedValue(makeOperatorClient('cliente'))

    const listAuthorizedDeepSeekModels = await loadAction()
    const result = await listAuthorizedDeepSeekModels()

    expect(result).toEqual({ success: false, error: 'ACESSO_NEGADO_PERMISSAO_INSUFICIENTE' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns a stable not-configured error when the key is absent', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch
    mocks.createClient.mockResolvedValue(makeOperatorClient('admin'))
    mocks.obterConfiguracaoSistema.mockResolvedValue(null)

    const listAuthorizedDeepSeekModels = await loadAction()
    const result = await listAuthorizedDeepSeekModels()

    expect(result).toEqual({ success: false, error: 'DEEPSEEK_NOT_CONFIGURED' })
    expect(mocks.obterConfiguracaoSistema).toHaveBeenCalledWith('DEEPSEEK_API_KEY')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns the same not-configured error for a placeholder key', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch
    mocks.createClient.mockResolvedValue(makeOperatorClient('supervisor'))
    mocks.obterConfiguracaoSistema.mockResolvedValue('sk-your-api-key-placeholder')

    const listAuthorizedDeepSeekModels = await loadAction()
    const result = await listAuthorizedDeepSeekModels()

    expect(result).toEqual({ success: false, error: 'DEEPSEEK_NOT_CONFIGURED' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns the authorized models without ever exposing the key', async () => {
    const fetchMock = mockModelsResponse()
    global.fetch = fetchMock as unknown as typeof fetch
    mocks.createClient.mockResolvedValue(makeOperatorClient('admin'))
    mocks.obterConfiguracaoSistema.mockResolvedValue(CONFIGURED_KEY)

    const listAuthorizedDeepSeekModels = await loadAction()
    const result = await listAuthorizedDeepSeekModels()

    expect(result).toEqual({
      success: true,
      models: [
        { id: 'deepseek-chat', label: 'deepseek-chat' },
        { id: 'deepseek-reasoner', label: 'deepseek-reasoner' },
      ],
    })
    expect(JSON.stringify(result)).not.toContain(CONFIGURED_KEY)
    expect(JSON.stringify(result)).not.toContain('secret-configured')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.deepseek.com/models')
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${CONFIGURED_KEY}` })
  })

  it('prefers the database configuration over the environment variable', async () => {
    process.env.DEEPSEEK_API_KEY = ENV_KEY
    const fetchMock = mockModelsResponse()
    global.fetch = fetchMock as unknown as typeof fetch
    mocks.createClient.mockResolvedValue(makeOperatorClient('admin'))
    mocks.obterConfiguracaoSistema.mockResolvedValue(CONFIGURED_KEY)

    const listAuthorizedDeepSeekModels = await loadAction()
    const result = await listAuthorizedDeepSeekModels()

    expect(result.success).toBe(true)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${CONFIGURED_KEY}` })
    expect(JSON.stringify(init.headers)).not.toContain(ENV_KEY)
  })

  it('falls back to the environment key when the database has no value', async () => {
    process.env.DEEPSEEK_API_KEY = ENV_KEY
    const fetchMock = mockModelsResponse()
    global.fetch = fetchMock as unknown as typeof fetch
    mocks.createClient.mockResolvedValue(makeOperatorClient('supervisor'))
    mocks.obterConfiguracaoSistema.mockResolvedValue(null)

    const listAuthorizedDeepSeekModels = await loadAction()
    const result = await listAuthorizedDeepSeekModels()

    expect(result.success).toBe(true)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${ENV_KEY}` })
  })

  it('surfaces the stable client error and keeps the key out of the result when the provider fails', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => `upstream failure for ${CONFIGURED_KEY}`,
      json: async () => ({ error: { message: `upstream failure for ${CONFIGURED_KEY}` } }),
    } as unknown as Response) as unknown as typeof fetch
    mocks.createClient.mockResolvedValue(makeOperatorClient('admin'))
    mocks.obterConfiguracaoSistema.mockResolvedValue(CONFIGURED_KEY)

    const listAuthorizedDeepSeekModels = await loadAction()
    const result = await listAuthorizedDeepSeekModels()

    expect(result).toEqual({ success: false, error: 'DEEPSEEK_HTTP_ERROR' })
    expect(JSON.stringify(result)).not.toContain(CONFIGURED_KEY)
  })
})
