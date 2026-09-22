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
const PROVIDER_BODY_MARKER = 'PROVIDER_COMPLETION_BODY_MARKER'
const CALLER_KEY = 'sk-deepseek-secret-caller-key'

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

async function loadModelProbeAction() {
  const actionsModule = await import('@/app/actions/admin')
  return actionsModule.testAuthorizedDeepSeekModel
}

function mockChatProbeResponse() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      id: 'chatcmpl-1',
      model: 'deepseek-reasoner',
      choices: [{ message: { role: 'assistant', content: PROVIDER_BODY_MARKER } }],
    }),
    text: async () => PROVIDER_BODY_MARKER,
  } as unknown as Response)
}

describe('testAuthorizedDeepSeekModel Server Action', () => {
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

  it('rejects a caller without operator permissions before resolving any key', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch
    mocks.createClient.mockResolvedValue(makeOperatorClient('cliente'))

    const testAuthorizedDeepSeekModel = await loadModelProbeAction()
    const result = await testAuthorizedDeepSeekModel('deepseek-chat')

    expect(result).toEqual({ success: false, error: 'ACESSO_NEGADO_PERMISSAO_INSUFICIENTE' })
    expect(mocks.obterConfiguracaoSistema).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requires a non-empty model id and never probes without one', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch
    mocks.createClient.mockResolvedValue(makeOperatorClient('admin'))
    mocks.obterConfiguracaoSistema.mockResolvedValue(CONFIGURED_KEY)

    const testAuthorizedDeepSeekModel = await loadModelProbeAction()

    for (const model of ['', '   ', null, undefined, 7, {}, ['deepseek-chat']]) {
      const result = await testAuthorizedDeepSeekModel(model)
      expect(result).toEqual({ success: false, error: 'DEEPSEEK_MODEL_REQUIRED' })
    }

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ignores a caller-supplied key: the probe only accepts a model id', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch
    mocks.createClient.mockResolvedValue(makeOperatorClient('admin'))
    mocks.obterConfiguracaoSistema.mockResolvedValue(CONFIGURED_KEY)

    const testAuthorizedDeepSeekModel = await loadModelProbeAction()
    const result = await testAuthorizedDeepSeekModel({ model: 'deepseek-chat', apiKey: CALLER_KEY })

    expect(result).toEqual({ success: false, error: 'DEEPSEEK_MODEL_REQUIRED' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain(CALLER_KEY)
  })

  it('returns a stable not-configured error when the stored key is absent or a placeholder', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch
    mocks.createClient.mockResolvedValue(makeOperatorClient('supervisor'))

    const testAuthorizedDeepSeekModel = await loadModelProbeAction()

    for (const stored of [null, '', 'sk-your-api-key-placeholder']) {
      mocks.obterConfiguracaoSistema.mockResolvedValue(stored)
      const result = await testAuthorizedDeepSeekModel('deepseek-chat')
      expect(result).toEqual({ success: false, error: 'DEEPSEEK_NOT_CONFIGURED' })
    }

    expect(mocks.obterConfiguracaoSistema).toHaveBeenCalledWith('DEEPSEEK_API_KEY')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('probes with the environment key when the stored key is an unusable placeholder', async () => {
    process.env.DEEPSEEK_API_KEY = ENV_KEY
    const fetchMock = mockChatProbeResponse()
    global.fetch = fetchMock as unknown as typeof fetch
    mocks.createClient.mockResolvedValue(makeOperatorClient('supervisor'))
    mocks.obterConfiguracaoSistema.mockResolvedValue('sk-your-api-key-placeholder')

    const testAuthorizedDeepSeekModel = await loadModelProbeAction()
    const result = await testAuthorizedDeepSeekModel('deepseek-chat')

    expect(result).toEqual({ success: true, model: 'deepseek-chat' })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${ENV_KEY}` })
    expect(JSON.stringify(result)).not.toContain(ENV_KEY)
  })

  it('probes the selected model with the stored key and returns no secret or provider body', async () => {
    const fetchMock = mockChatProbeResponse()
    global.fetch = fetchMock as unknown as typeof fetch
    mocks.createClient.mockResolvedValue(makeOperatorClient('admin'))
    mocks.obterConfiguracaoSistema.mockResolvedValue(CONFIGURED_KEY)

    const testAuthorizedDeepSeekModel = await loadModelProbeAction()
    const result = await testAuthorizedDeepSeekModel('deepseek-reasoner')

    expect(result).toEqual({ success: true, model: 'deepseek-reasoner' })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(CONFIGURED_KEY)
    expect(serialized).not.toContain('secret-configured')
    expect(serialized).not.toContain(PROVIDER_BODY_MARKER)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${CONFIGURED_KEY}` })
    expect(JSON.parse(String(init.body)).model).toBe('deepseek-reasoner')
  })

  it('falls back to the environment key when the database has no stored value', async () => {
    process.env.DEEPSEEK_API_KEY = ENV_KEY
    const fetchMock = mockChatProbeResponse()
    global.fetch = fetchMock as unknown as typeof fetch
    mocks.createClient.mockResolvedValue(makeOperatorClient('supervisor'))
    mocks.obterConfiguracaoSistema.mockResolvedValue(null)

    const testAuthorizedDeepSeekModel = await loadModelProbeAction()
    const result = await testAuthorizedDeepSeekModel('deepseek-chat')

    expect(result).toEqual({ success: true, model: 'deepseek-chat' })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${ENV_KEY}` })
  })

  it('surfaces only the stable provider failure code when the provider rejects the probe', async () => {
    const text = vi.fn(async () => `invalid credentials for ${CONFIGURED_KEY}: ${PROVIDER_BODY_MARKER}`)
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      statusText: 'Payment Required',
      text,
      json: async () => ({ error: { message: `invalid credentials for ${CONFIGURED_KEY}` } }),
    } as unknown as Response) as unknown as typeof fetch
    mocks.createClient.mockResolvedValue(makeOperatorClient('admin'))
    mocks.obterConfiguracaoSistema.mockResolvedValue(CONFIGURED_KEY)

    const testAuthorizedDeepSeekModel = await loadModelProbeAction()
    const result = await testAuthorizedDeepSeekModel('deepseek-chat')

    expect(result).toEqual({ success: false, error: 'DEEPSEEK_HTTP_ERROR' })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(CONFIGURED_KEY)
    expect(serialized).not.toContain(PROVIDER_BODY_MARKER)
    expect(serialized).not.toContain('invalid credentials')
    expect(text).not.toHaveBeenCalled()
  })
})

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

  it('lists with the environment key when the stored key is an unusable placeholder', async () => {
    process.env.DEEPSEEK_API_KEY = ENV_KEY
    const fetchMock = mockModelsResponse()
    global.fetch = fetchMock as unknown as typeof fetch
    mocks.createClient.mockResolvedValue(makeOperatorClient('admin'))
    mocks.obterConfiguracaoSistema.mockResolvedValue('sk-your-api-key-placeholder')

    const listAuthorizedDeepSeekModels = await loadAction()
    const result = await listAuthorizedDeepSeekModels()

    expect(result.success).toBe(true)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${ENV_KEY}` })
    expect(JSON.stringify(result)).not.toContain(ENV_KEY)
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
