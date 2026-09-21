import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SofiaGlobalStatusBar from '@/components/operator/SofiaGlobalStatusBar'
import { obterStatusSofiaAtendimento, type SofiaAtendimentoStatus } from '@/app/actions/atendimento'

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

function makeStatus(overrides: Partial<SofiaAtendimentoStatus> = {}): SofiaAtendimentoStatus {
  return {
    channels: {
      whatsapp: {
        enabled: true,
        key: 'SOFIA_GLOBAL_WHATSAPP_ENABLED',
        availability: 'operational',
      },
      telegram: {
        enabled: false,
        key: 'SOFIA_GLOBAL_TELEGRAM_ENABLED',
        availability: 'global_off',
      },
    },
    credits: {
      provider: 'deepseek',
      balanceUsd: 2.5,
      state: 'fresh',
      fetchedAt: '2026-07-10T12:00:00.000Z',
      expiresAt: '2026-07-10T12:30:00.000Z',
      freshnessMs: 1_800_000,
      color: 'green',
    },
    runtime: {
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    },
    permissions: {
      canToggleGlobalSofia: true,
    },
    schedule: {
      withinBusinessHours: true,
      message: null,
    },
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  process.env = originalEnv
})

describe('SofiaGlobalStatusBar', () => {
  it('renders independent WhatsApp and Telegram channel status plus USD credits', () => {
    render(
      <SofiaGlobalStatusBar
        status={makeStatus()}
        onToggleChannel={vi.fn()}
      />,
    )

    expect(screen.getByText('WhatsApp')).toBeInTheDocument()
    expect(screen.getByText('Telegram')).toBeInTheDocument()
    expect(screen.getByText('Operational')).toBeInTheDocument()
    expect(screen.getByText('Globally off')).toBeInTheDocument()
    expect(screen.getByText('$2.50')).toBeInTheDocument()
    expect(screen.getByText('deepseek · deepseek-v4-pro')).toBeInTheDocument()
  })

  it('shows scheduled pause as derived yellow state without changing the binary toggle label', () => {
    render(
      <SofiaGlobalStatusBar
        status={makeStatus({
          channels: {
            whatsapp: {
              enabled: true,
              key: 'SOFIA_GLOBAL_WHATSAPP_ENABLED',
              availability: 'scheduled_pause',
            },
            telegram: {
              enabled: true,
              key: 'SOFIA_GLOBAL_TELEGRAM_ENABLED',
              availability: 'scheduled_pause',
            },
          },
          schedule: {
            withinBusinessHours: false,
            message: 'Closed',
          },
        })}
        onToggleChannel={vi.fn()}
      />,
    )

    expect(screen.getAllByText('Scheduled pause')).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /Disable Sofia for/i })).toHaveLength(2)
    expect(screen.getByText(/Business-hours pause is active/i)).toBeInTheDocument()
  })

  it('blocks vendedor toggles in the UI', () => {
    const onToggle = vi.fn()

    render(
      <SofiaGlobalStatusBar
        status={makeStatus({
          permissions: { canToggleGlobalSofia: false },
        })}
        onToggleChannel={onToggle}
      />,
    )

    const whatsappToggle = screen.getByRole('button', { name: 'Disable Sofia for WhatsApp' })
    expect(whatsappToggle).toBeDisabled()
    fireEvent.click(whatsappToggle)
    expect(onToggle).not.toHaveBeenCalled()
    expect(screen.getByText(/only admins and supervisors/i)).toBeInTheDocument()
  })

  it('uses neutral unknown credit state without presenting stale numeric balance as current', () => {
    render(
      <SofiaGlobalStatusBar
        status={makeStatus({
          credits: {
            provider: 'deepseek',
            balanceUsd: null,
            state: 'unknown',
            fetchedAt: null,
            expiresAt: null,
            freshnessMs: 1_800_000,
            color: 'neutral',
          },
          runtime: {
            provider: 'deepseek',
            model: null,
          },
        })}
        onToggleChannel={vi.fn()}
      />,
    )

    expect(screen.getByText('Unknown balance')).toBeInTheDocument()
    expect(screen.getByText('deepseek')).toBeInTheDocument()
    expect(screen.queryByText('$2.50')).not.toBeInTheDocument()
  })

  it('uses neutral stale credit state without presenting the last balance as current', () => {
    render(
      <SofiaGlobalStatusBar
        status={makeStatus({
          credits: {
            provider: 'deepseek',
            balanceUsd: null,
            state: 'stale',
            fetchedAt: '2026-07-10T12:00:00.000Z',
            expiresAt: '2026-07-10T12:30:00.000Z',
            freshnessMs: 1_800_000,
            color: 'neutral',
            error: 'provider unavailable',
          },
        })}
        onToggleChannel={vi.fn()}
      />,
    )

    expect(screen.getByText('Unknown balance')).toBeInTheDocument()
    expect(screen.queryByText('$2.50')).not.toBeInTheDocument()
  })
})

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
})
