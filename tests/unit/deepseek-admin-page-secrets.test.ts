// @vitest-environment node

/**
 * Server-to-client boundary for operator configuration.
 *
 * `/atendimento/admin` reads `configuracoes_sistema` on the server and hands a
 * projection to the client `AdminDashboard`. Secret-bearing values (`_KEY`,
 * `_TOKEN`, `_SECRET`) must not cross that boundary, not even as environment
 * fallbacks, while the DeepSeek key state must still reach the dashboard as an
 * explicit configured marker so a write-only input can render it later.
 *
 * Retired providers are a second invariant on the same boundary: a
 * `configuracoes_sistema` row left behind by OpenRouter or OmniRoute must not
 * resurface on the client just because the row is still stored.
 */

import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`)
  }),
  createClient: vi.fn(),
  listarUsuariosAdmin: vi.fn(),
  obterEstatisticasMensagens: vi.fn(),
  adminDashboard: vi.fn(() => null),
}))

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }))

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }))

vi.mock('@/app/actions/admin', () => ({
  listarUsuariosAdmin: mocks.listarUsuariosAdmin,
  obterEstatisticasMensagens: mocks.obterEstatisticasMensagens,
}))

vi.mock('@/components/operator/AdminDashboard', () => ({ default: mocks.adminDashboard }))

vi.mock('@/components/operator/OperatorWorkspaceHeader', () => ({
  OperatorWorkspaceHeader: () => null,
}))

/** Secret-shaped keys persisted in `configuracoes_sistema`. */
const DATABASE_SECRETS: Record<string, string> = {
  DEEPSEEK_API_KEY: 'sk-deepseek-database-secret',
  WHATSAPP_ACCESS_TOKEN: 'whatsapp-database-access-token',
  WHATSAPP_VERIFY_TOKEN: 'whatsapp-database-verify-token',
  MERCADO_PAGO_ACCESS_TOKEN: 'mercadopago-database-access-token',
  MERCADO_PAGO_PUBLIC_KEY: 'mercadopago-database-public-key',
  TELEGRAM_BOT_TOKEN: 'telegram-database-bot-token',
  EVOLUTION_API_KEY: 'evolution-database-api-key',
  WHATSAPP_APP_SECRET: 'whatsapp-database-app-secret',
  MERCADO_PAGO_WEBHOOK_SECRET: 'mercadopago-database-webhook-secret',
}

/** Secret-shaped keys resolved only through the environment fallback. */
const ENVIRONMENT_SECRETS: Record<string, string> = {
  DEEPSEEK_API_KEY: 'sk-deepseek-environment-secret',
  WHATSAPP_ACCESS_TOKEN: 'whatsapp-environment-access-token',
  WHATSAPP_VERIFY_TOKEN: 'whatsapp-environment-verify-token',
  MERCADO_PAGO_ACCESS_TOKEN: 'mercadopago-environment-access-token',
  MERCADO_PAGO_PUBLIC_KEY: 'mercadopago-environment-public-key',
  TELEGRAM_BOT_TOKEN: 'telegram-environment-bot-token',
  EVOLUTION_API_KEY: 'evolution-environment-api-key',
  WHATSAPP_APP_SECRET: 'whatsapp-environment-app-secret',
  MERCADO_PAGO_WEBHOOK_SECRET: 'mercadopago-environment-webhook-secret',
}

const DATABASE_PUBLIC_CONFIGS: Record<string, string> = {
  WHATSAPP_PHONE_NUMBER_ID: '109876543210987',
  WHATSAPP_PROVIDER: 'evolution',
  EVOLUTION_API_URL: 'https://evolution.internal.example',
}

const ENVIRONMENT_PUBLIC_CONFIGS: Record<string, string> = {
  EVOLUTION_INSTANCE_NAME: 'casa-de-asados-environment',
  SOFIA_SYSTEM_PROMPT: 'Sofia environment prompt',
}

const SECRET_KEY_PATTERN = /(_KEY|_TOKEN|_SECRET)/i
const DEEPSEEK_MARKER_KEY = 'DEEPSEEK_CONFIGURED'
const RETIRED_PROVIDER_KEY_PATTERN = /(OPENROUTER|OMNIROUTE)/i

/**
 * Rows naming the retired providers, as a legacy or restored database would
 * still hold them. The retired *model* keys are the ones the secret pattern
 * cannot catch, so they are the values that must be refused by name.
 */
const RETIRED_PROVIDER_DATABASE_CONFIGS: Record<string, string> = {
  OPENROUTER_MODEL: 'deepseek/deepseek-chat',
  OMNIROUTE_BASE_URL: 'https://omniroute.retired.example/v1',
  OPENROUTER_API_KEY: 'sk-openrouter-database-secret',
  OMNIROUTE_API_KEY: 'omniroute-database-api-key',
}

const STORED_DEEPSEEK_CONFIGS: Record<string, string> = {
  DEEPSEEK_API_KEY: DATABASE_SECRETS.DEEPSEEK_API_KEY,
  DEEPSEEK_MODEL: 'deepseek-flash',
}

const originalEnv = process.env

type ConfigRow = { chave: string; valor: string }

function configRows(configs: Record<string, string>): ConfigRow[] {
  return Object.entries(configs).map(([chave, valor]) => ({ chave, valor }))
}

/**
 * Minimal PostgREST-shaped builder: every filter returns the builder and the
 * builder is awaitable, which covers `await query` and `await query.limit(n)`.
 */
function supabaseQuery(data: unknown, error: unknown = null) {
  const result = { data, error }
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    limit: () => builder,
    single: () => Promise.resolve(result),
    then: (onFulfilled: (value: typeof result) => unknown) => Promise.resolve(result).then(onFulfilled),
  }
  return builder
}

function supabaseClient(options: {
  role?: string
  ativo?: boolean
  rows?: ConfigRow[]
}) {
  const { role = 'admin', ativo = true, rows = [] } = options

  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'operator-123' } }, error: null }),
    },
    from: vi.fn((table: string) => {
      if (table === 'perfis') {
        return supabaseQuery({ id: 'operator-123', nome: 'Operadora', funcao: role, ativo })
      }
      if (table === 'configuracoes_sistema') {
        return supabaseQuery(rows)
      }
      return supabaseQuery([])
    }),
  }
}

function findElementByType(
  node: ReactNode,
  type: unknown,
): ReactElement<{ systemConfigs?: Record<string, string> }> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElementByType(child, type)
      if (found) return found
    }
    return null
  }

  if (!isValidElement(node)) return null

  const element = node as ReactElement<{ children?: ReactNode; systemConfigs?: Record<string, string> }>
  if (element.type === type) return element

  return findElementByType(element.props.children, type)
}

/**
 * Renders the async server component and returns the exact `systemConfigs`
 * payload the page hands to the client `AdminDashboard`.
 */
async function projectAdminDashboardProps(): Promise<Record<string, string>> {
  const AdminPage = (await import('@/app/atendimento/admin/page')).default
  const tree = await AdminPage({ searchParams: Promise.resolve({}) })
  const dashboard = findElementByType(tree, mocks.adminDashboard)

  expect(dashboard, 'the page must render the client AdminDashboard').not.toBeNull()

  return dashboard?.props.systemConfigs ?? {}
}

function applyEnvironment(configs: Record<string, string>) {
  const next: NodeJS.ProcessEnv = { ...originalEnv }
  for (const key of Object.keys(ENVIRONMENT_SECRETS)) delete next[key]
  for (const [key, value] of Object.entries(configs)) next[key] = value
  process.env = next
}

describe('admin page server-to-client configuration projection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listarUsuariosAdmin.mockResolvedValue({ success: true, data: [] })
    mocks.obterEstatisticasMensagens.mockResolvedValue({ success: false })
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('omits every database value whose key marks a secret (_KEY, _TOKEN, _SECRET)', async () => {
    applyEnvironment({})
    mocks.createClient.mockResolvedValue(
      supabaseClient({ rows: [...configRows(DATABASE_SECRETS), ...configRows(DATABASE_PUBLIC_CONFIGS)] }),
    )

    const systemConfigs = await projectAdminDashboardProps()

    expect(Object.keys(systemConfigs).filter((key) => SECRET_KEY_PATTERN.test(key))).toEqual([])

    const serialized = JSON.stringify(systemConfigs)
    for (const secret of Object.values(DATABASE_SECRETS)) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('omits every environment fallback value whose key marks a secret (_KEY, _TOKEN, _SECRET)', async () => {
    applyEnvironment(ENVIRONMENT_SECRETS)
    mocks.createClient.mockResolvedValue(supabaseClient({ rows: configRows(DATABASE_PUBLIC_CONFIGS) }))

    const systemConfigs = await projectAdminDashboardProps()

    expect(Object.keys(systemConfigs).filter((key) => SECRET_KEY_PATTERN.test(key))).toEqual([])

    const serialized = JSON.stringify(systemConfigs)
    for (const secret of Object.values(ENVIRONMENT_SECRETS)) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('never lets a `_SECRET` value cross, from the database or from the environment fallback', async () => {
    applyEnvironment({
      WHATSAPP_APP_SECRET: ENVIRONMENT_SECRETS.WHATSAPP_APP_SECRET,
      MERCADO_PAGO_WEBHOOK_SECRET: ENVIRONMENT_SECRETS.MERCADO_PAGO_WEBHOOK_SECRET,
    })
    mocks.createClient.mockResolvedValue(
      supabaseClient({
        rows: configRows({
          WHATSAPP_APP_SECRET: DATABASE_SECRETS.WHATSAPP_APP_SECRET,
          MERCADO_PAGO_WEBHOOK_SECRET: DATABASE_SECRETS.MERCADO_PAGO_WEBHOOK_SECRET,
        }),
      }),
    )

    const systemConfigs = await projectAdminDashboardProps()

    expect(systemConfigs.WHATSAPP_APP_SECRET).toBeUndefined()
    expect(systemConfigs.MERCADO_PAGO_WEBHOOK_SECRET).toBeUndefined()

    const serialized = JSON.stringify(systemConfigs)
    expect(serialized).not.toContain(DATABASE_SECRETS.WHATSAPP_APP_SECRET)
    expect(serialized).not.toContain(DATABASE_SECRETS.MERCADO_PAGO_WEBHOOK_SECRET)
    expect(serialized).not.toContain(ENVIRONMENT_SECRETS.WHATSAPP_APP_SECRET)
    expect(serialized).not.toContain(ENVIRONMENT_SECRETS.MERCADO_PAGO_WEBHOOK_SECRET)
  })

  it('preserves the non-secret configuration values from the database and the environment', async () => {
    applyEnvironment(ENVIRONMENT_PUBLIC_CONFIGS)
    mocks.createClient.mockResolvedValue(supabaseClient({ rows: configRows(DATABASE_PUBLIC_CONFIGS) }))

    const systemConfigs = await projectAdminDashboardProps()

    expect(systemConfigs).toMatchObject({
      ...DATABASE_PUBLIC_CONFIGS,
      ...ENVIRONMENT_PUBLIC_CONFIGS,
    })
  })

  it('passes only the DeepSeek configured marker, never the configured key', async () => {
    applyEnvironment({})
    mocks.createClient.mockResolvedValue(
      supabaseClient({ rows: configRows({ DEEPSEEK_API_KEY: DATABASE_SECRETS.DEEPSEEK_API_KEY }) }),
    )

    const systemConfigs = await projectAdminDashboardProps()

    expect(systemConfigs[DEEPSEEK_MARKER_KEY]).toBe('true')
    expect(systemConfigs.DEEPSEEK_API_KEY).toBeUndefined()
    expect(JSON.stringify(systemConfigs)).not.toContain(DATABASE_SECRETS.DEEPSEEK_API_KEY)
  })

  it('marks DeepSeek as configured when only the environment key exists', async () => {
    applyEnvironment({ DEEPSEEK_API_KEY: ENVIRONMENT_SECRETS.DEEPSEEK_API_KEY })
    mocks.createClient.mockResolvedValue(supabaseClient({ rows: [] }))

    const systemConfigs = await projectAdminDashboardProps()

    expect(systemConfigs[DEEPSEEK_MARKER_KEY]).toBe('true')
    expect(systemConfigs.DEEPSEEK_API_KEY).toBeUndefined()
    expect(JSON.stringify(systemConfigs)).not.toContain(ENVIRONMENT_SECRETS.DEEPSEEK_API_KEY)
  })

  it('projects the environment-only DeepSeek model so the operator sees it', async () => {
    applyEnvironment({ DEEPSEEK_MODEL: 'deepseek-v4-pro' })
    mocks.createClient.mockResolvedValue(supabaseClient({ rows: [] }))

    const systemConfigs = await projectAdminDashboardProps()

    expect(systemConfigs.DEEPSEEK_MODEL).toBe('deepseek-v4-pro')
  })

  it('prefers the stored DeepSeek model over the environment fallback', async () => {
    applyEnvironment({ DEEPSEEK_MODEL: 'deepseek-v4-pro' })
    mocks.createClient.mockResolvedValue(
      supabaseClient({ rows: configRows({ DEEPSEEK_MODEL: 'deepseek-flash' }) }),
    )

    const systemConfigs = await projectAdminDashboardProps()

    expect(systemConfigs.DEEPSEEK_MODEL).toBe('deepseek-flash')
  })

  it('drops the retired provider keys from its defaults and from the environment fallback chain', async () => {
    applyEnvironment({
      OPENROUTER_API_KEY: 'sk-openrouter-retired-environment-secret',
      OPENROUTER_MODEL: 'deepseek/deepseek-chat',
    })
    mocks.createClient.mockResolvedValue(supabaseClient({ rows: [] }))

    const systemConfigs = await projectAdminDashboardProps()

    expect(Object.keys(systemConfigs).filter((key) => /openrouter|omniroute/i.test(key))).toEqual([])
    expect(systemConfigs.OPENROUTER_MODEL).toBeUndefined()
    expect(JSON.stringify(systemConfigs)).not.toContain('sk-openrouter-retired-environment-secret')
  })

  it('refuses stored retired provider rows without disturbing the DeepSeek and non-secret projections', async () => {
    applyEnvironment({})
    mocks.createClient.mockResolvedValue(
      supabaseClient({
        rows: [
          ...configRows(RETIRED_PROVIDER_DATABASE_CONFIGS),
          ...configRows(STORED_DEEPSEEK_CONFIGS),
          ...configRows(DATABASE_PUBLIC_CONFIGS),
        ],
      }),
    )

    const systemConfigs = await projectAdminDashboardProps()

    expect(
      Object.keys(systemConfigs).filter((key) => RETIRED_PROVIDER_KEY_PATTERN.test(key)),
      'no stored key naming a retired provider may reach the client',
    ).toEqual([])

    const serialized = JSON.stringify(systemConfigs)
    for (const value of Object.values(RETIRED_PROVIDER_DATABASE_CONFIGS)) {
      expect(serialized).not.toContain(value)
    }

    // The other projections on this boundary keep working unchanged.
    expect(systemConfigs[DEEPSEEK_MARKER_KEY]).toBe('true')
    expect(systemConfigs.DEEPSEEK_MODEL).toBe(STORED_DEEPSEEK_CONFIGS.DEEPSEEK_MODEL)
    expect(systemConfigs.DEEPSEEK_API_KEY).toBeUndefined()
    expect(serialized).not.toContain(STORED_DEEPSEEK_CONFIGS.DEEPSEEK_API_KEY)
    expect(systemConfigs).toMatchObject(DATABASE_PUBLIC_CONFIGS)
  })

  it('does not mark DeepSeek as configured when the stored key is a placeholder', async () => {
    applyEnvironment({})
    mocks.createClient.mockResolvedValue(
      supabaseClient({ rows: configRows({ DEEPSEEK_API_KEY: 'sk-your-api-key-placeholder' }) }),
    )

    const systemConfigs = await projectAdminDashboardProps()

    expect(systemConfigs[DEEPSEEK_MARKER_KEY]).toBeUndefined()
  })

  it('keeps the supervisor authorization path rendering the dashboard', async () => {
    applyEnvironment({})
    mocks.createClient.mockResolvedValue(supabaseClient({ role: 'supervisor', rows: [] }))

    const systemConfigs = await projectAdminDashboardProps()

    expect(mocks.redirect).not.toHaveBeenCalled()
    expect(systemConfigs).toBeTypeOf('object')
  })

  it('keeps redirecting a non-operator role to login before any projection happens', async () => {
    applyEnvironment({})
    mocks.createClient.mockResolvedValue(supabaseClient({ role: 'cliente', rows: configRows(DATABASE_SECRETS) }))

    await expect(projectAdminDashboardProps()).rejects.toThrow('redirect:/login')
    expect(mocks.redirect).toHaveBeenCalledWith('/login')
  })
})
