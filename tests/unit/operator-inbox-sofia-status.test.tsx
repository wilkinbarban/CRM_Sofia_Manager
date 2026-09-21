import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import OperatorInboxContainer from '@/components/operator/OperatorInboxContainer'
import type { SofiaAtendimentoStatus } from '@/app/actions/atendimento'

const mocks = vi.hoisted(() => ({
  alternarSofiaGlobal: vi.fn(),
  obterStatusSofiaAtendimento: vi.fn(),
}))

vi.mock('@/app/actions/atendimento', () => ({
  alternarSofiaGlobal: mocks.alternarSofiaGlobal,
  alternarSofiaWhatsApp: vi.fn(),
  obterStatusSofiaAtendimento: mocks.obterStatusSofiaAtendimento,
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    channel: () => {
      const ch: any = {
        on: () => ch,
        subscribe: () => ch,
      }
      return ch
    },
    removeChannel: vi.fn(),
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
          single: async () => ({ data: null, error: null }),
        }),
      }),
    }),
  }),
}))

vi.mock('@/components/operator/ConversationsQueue', () => ({
  default: () => <div data-testid="queue" />,
}))

vi.mock('@/components/operator/OperatorChatConsole', () => ({
  default: () => <div data-testid="chat" />,
}))

vi.mock('@/components/operator/ClientCrmPanel', () => ({
  default: () => <div data-testid="crm" />,
}))

vi.mock('@/components/operator/SofiaGlobalStatusBar', () => ({
  default: ({ status, onToggleChannel }: {
    status: SofiaAtendimentoStatus
    onToggleChannel: (channel: 'whatsapp' | 'telegram', enabled: boolean) => void
  }) => (
    <section>
      <p>WhatsApp: {status.channels.whatsapp.availability}</p>
      <p>Telegram: {status.channels.telegram.availability}</p>
      <button type="button" onClick={() => onToggleChannel('whatsapp', false)}>
        Disable WhatsApp
      </button>
    </section>
  ),
}))

function makeStatus(overrides: Partial<SofiaAtendimentoStatus> = {}): SofiaAtendimentoStatus {
  return {
    channels: {
      whatsapp: {
        enabled: true,
        key: 'SOFIA_GLOBAL_WHATSAPP_ENABLED',
        availability: 'operational',
      },
      telegram: {
        enabled: true,
        key: 'SOFIA_GLOBAL_TELEGRAM_ENABLED',
        availability: 'operational',
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
  vi.clearAllMocks()
})

describe('OperatorInboxContainer Sofia status refresh flow', () => {
  it('refreshes and applies global Sofia status after a successful toggle action', async () => {
    const refreshedStatus = makeStatus({
      channels: {
        whatsapp: {
          enabled: false,
          key: 'SOFIA_GLOBAL_WHATSAPP_ENABLED',
          availability: 'global_off',
        },
        telegram: {
          enabled: true,
          key: 'SOFIA_GLOBAL_TELEGRAM_ENABLED',
          availability: 'operational',
        },
      },
    })

    mocks.alternarSofiaGlobal.mockResolvedValue({ success: true, data: refreshedStatus.channels.whatsapp })
    mocks.obterStatusSofiaAtendimento.mockResolvedValue({ success: true, data: refreshedStatus })

    render(
      <OperatorInboxContainer
        conversasIniciais={[]}
        initialSofiaStatus={makeStatus()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Disable WhatsApp' }))

    await waitFor(() => {
      expect(mocks.alternarSofiaGlobal).toHaveBeenCalledWith('whatsapp', false)
      expect(mocks.obterStatusSofiaAtendimento).toHaveBeenCalledTimes(1)
      expect(screen.getByText('WhatsApp: global_off')).toBeInTheDocument()
      expect(screen.getByText('Telegram: operational')).toBeInTheDocument()
    })
  })
})
