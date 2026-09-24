/**
 * `obterStatusSofiaAtendimento`: the status payload the Sofia status bar
 * renders.
 *
 * Split out of `sofia-global-status-bar.test.tsx`, which mocked the whole
 * configuration module at file level. Those mocks would have masked a
 * `@/lib/config/sistema` regression in any test added to that render suite
 * later, so each suite now owns the mocks it actually needs: this one the
 * server action graph, the render one nothing at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { obterStatusSofiaAtendimento } from '@/app/actions/atendimento'

const mocks = vi.hoisted(() => ({
  obterConfiguracaoSistema: vi.fn(),
  obterSofiaGlobalStatusConfig: vi.fn(),
  getLlmCreditStatus: vi.fn(),
  verificarHorarioAtendimento: vi.fn(),
  verificarOperadorAutorizado: vi.fn(),
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

vi.mock('@/lib/config/sistema', () => ({
  obterConfiguracaoSistema: mocks.obterConfiguracaoSistema,
  obterSofiaGlobalStatusConfig: mocks.obterSofiaGlobalStatusConfig,
  salvarSofiaGlobalChannelConfig: vi.fn(),
  deriveSofiaChannelAvailability: () => 'operational',
}))

vi.mock('@/lib/ai/credits', () => ({
  getLlmCreditStatus: mocks.getLlmCreditStatus,
}))

vi.mock('@/lib/horarios/verificar', () => ({
  verificarHorarioAtendimento: mocks.verificarHorarioAtendimento,
}))

vi.mock('@/lib/auth/operador', () => ({
  verificarOperadorAutorizado: mocks.verificarOperadorAutorizado,
}))

// The status payload imports the delivery modules even though this suite never
// delivers: mock every heavy dependency of the action so the unit stays isolated.
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/whatsapp/send', () => ({ enviarMensagemWhatsapp: vi.fn() }))
vi.mock('@/lib/telegram/send', () => ({ enviarMensagemTelegram: vi.fn() }))
vi.mock('@/lib/whatsapp/sofia-control', () => ({
  getWhatsAppSofiaState: vi.fn(),
  setWhatsAppSofiaSleep: vi.fn(),
}))

const originalEnv = process.env

describe('Sofia status payload runtime model', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env = { ...originalEnv, DEEPSEEK_API_KEY: 'sk-deepseek-status-key' }
    delete process.env.DEEPSEEK_MODEL
    mocks.verificarOperadorAutorizado.mockResolvedValue({
      authorized: true,
      supabase: {},
      user: { id: 'user-123' },
      perfil: { funcao: 'admin', ativo: true },
    })
    mocks.obterSofiaGlobalStatusConfig.mockResolvedValue({
      whatsapp: { enabled: true, key: 'SOFIA_GLOBAL_WHATSAPP_ENABLED' },
      telegram: { enabled: false, key: 'SOFIA_GLOBAL_TELEGRAM_ENABLED' },
    })
    mocks.getLlmCreditStatus.mockResolvedValue({
      provider: 'deepseek',
      balanceUsd: null,
      state: 'unknown',
      fetchedAt: null,
      expiresAt: null,
      freshnessMs: 1_800_000,
      color: 'neutral',
    })
    mocks.verificarHorarioAtendimento.mockResolvedValue({ dentro: true })
    mocks.obterConfiguracaoSistema.mockResolvedValue(null)
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('reports the DeepSeek model generation actually uses, not a retired provider model', async () => {
    mocks.obterConfiguracaoSistema.mockImplementation(async (key: string) => (
      key === 'DEEPSEEK_MODEL' ? 'deepseek-v4-pro' : null
    ))

    const result = await obterStatusSofiaAtendimento()

    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({
        runtime: { provider: 'deepseek', model: 'deepseek-v4-pro' },
      }),
    })
    expect(mocks.obterConfiguracaoSistema.mock.calls.map((args) => args[0])).toEqual(['DEEPSEEK_MODEL'])
  })

  it('projects stale credit status with preserved balance when provider is temporarily unavailable', async () => {
    mocks.getLlmCreditStatus.mockResolvedValue({
      provider: 'deepseek',
      balanceUsd: 4.5,
      state: 'stale',
      fetchedAt: '2026-07-10T12:00:00.000Z',
      expiresAt: '2026-07-10T12:30:00.000Z',
      freshnessMs: 1_800_000,
      color: 'green',
      error: 'deepseek credits request failed with HTTP 503',
    })

    const result = await obterStatusSofiaAtendimento()

    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({
        credits: {
          provider: 'deepseek',
          balanceUsd: 4.5,
          state: 'stale',
          fetchedAt: '2026-07-10T12:00:00.000Z',
          expiresAt: '2026-07-10T12:30:00.000Z',
          freshnessMs: 1_800_000,
          color: 'green',
          error: 'deepseek credits request failed with HTTP 503',
        },
      }),
    })
  })

  it('projects neutral unknown credit status when credential is missing or revoked', async () => {
    mocks.getLlmCreditStatus.mockResolvedValue({
      provider: 'deepseek',
      balanceUsd: null,
      state: 'unknown',
      fetchedAt: null,
      expiresAt: null,
      freshnessMs: 1_800_000,
      color: 'neutral',
      error: 'deepseek credits request failed with HTTP 401',
    })

    const result = await obterStatusSofiaAtendimento()

    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({
        credits: {
          provider: 'deepseek',
          balanceUsd: null,
          state: 'unknown',
          fetchedAt: null,
          expiresAt: null,
          freshnessMs: 1_800_000,
          color: 'neutral',
          error: 'deepseek credits request failed with HTTP 401',
        },
      }),
    })
  })
})
