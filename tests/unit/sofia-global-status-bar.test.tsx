/**
 * `SofiaGlobalStatusBar` render suite.
 *
 * The component only reaches this file through type-only imports of
 * `@/app/actions/atendimento` and `@/lib/config/sistema`, so no module mock is
 * needed here: mocking those modules at file level would hide a regression in
 * the configuration module from any test added to this suite. The server action
 * payload (`obterStatusSofiaAtendimento`) is covered separately in
 * `sofia-status-payload.test.ts`.
 */
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SofiaGlobalStatusBar from '@/components/operator/SofiaGlobalStatusBar'
import type { SofiaAtendimentoStatus } from '@/app/actions/atendimento'

afterEach(() => {
  cleanup()
})

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
