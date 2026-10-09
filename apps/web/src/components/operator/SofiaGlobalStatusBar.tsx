'use client'

import React from 'react'
import { AlertTriangle, Bot, CheckCircle2, Loader2, MessageCircle, PauseCircle, Power, RefreshCw, WalletCards } from 'lucide-react'
import type { SofiaAtendimentoStatus, SofiaChannelAvailability } from '@/app/actions/atendimento'
import type { SofiaGlobalChannel } from '@/lib/config/sistema'

type ChannelStatus = SofiaAtendimentoStatus['channels'][SofiaGlobalChannel]
type CreditStatus = SofiaAtendimentoStatus['credits']

interface SofiaGlobalStatusBarProps {
  status: SofiaAtendimentoStatus
  refreshing?: boolean
  togglingChannel?: SofiaGlobalChannel | null
  error?: string | null
  onToggleChannel: (channel: SofiaGlobalChannel, enabled: boolean) => void | Promise<void>
  onRefresh?: () => void | Promise<void>
}

const CHANNEL_LABELS: Record<SofiaGlobalChannel, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
}

const AVAILABILITY_COPY: Record<SofiaChannelAvailability, { label: string; description: string; className: string; dotClassName: string }> = {
  operational: {
    label: 'Operational',
    description: 'Sofia is enabled and inside business hours.',
    className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    dotClassName: 'bg-emerald-400',
  },
  scheduled_pause: {
    label: 'Scheduled pause',
    description: 'Only the programmed out-of-hours message is allowed.',
    className: 'border-yellow-500/30 bg-yellow-500/10 text-yellow-300',
    dotClassName: 'bg-yellow-400',
  },
  global_off: {
    label: 'Globally off',
    description: 'Sofia is blocked for this channel.',
    className: 'border-red-500/30 bg-red-500/10 text-red-300',
    dotClassName: 'bg-red-400',
  },
}

const CREDIT_CLASS: Record<CreditStatus['color'], string> = {
  green: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  yellow: 'border-yellow-500/30 bg-yellow-500/10 text-yellow-300',
  red: 'border-red-500/30 bg-red-500/10 text-red-300',
  neutral: 'border-zinc-700 bg-zinc-900/50 text-zinc-300',
}

function formatUsd(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'Unknown'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value)
}

function formatFetchedAt(value: string | null): string {
  if (!value) return 'No successful refresh yet'
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function ChannelCard({
  channel,
  status,
  canToggle,
  disabled,
  onToggleChannel,
}: {
  channel: SofiaGlobalChannel
  status: ChannelStatus
  canToggle: boolean
  disabled: boolean
  onToggleChannel: SofiaGlobalStatusBarProps['onToggleChannel']
}) {
  const copy = AVAILABILITY_COPY[status.availability]
  const Icon = channel === 'whatsapp' ? MessageCircle : Bot
  const unconfigured = status.configured === false
  const channelLabel = CHANNEL_LABELS[channel]

  return (
    <div className={`rounded-xl border p-3 ${copy.className}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 shrink-0" />
            <span className="text-sm font-bold text-zinc-100">{CHANNEL_LABELS[channel]}</span>
            <span className={`h-2 w-2 rounded-full ${copy.dotClassName}`} aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide">{copy.label}</p>
            <p className="mt-0.5 text-[11px] leading-snug text-zinc-400">{copy.description}</p>
            {unconfigured && (
              <p className="mt-1 text-[11px] font-semibold leading-snug text-amber-300">
                Falta configurar o {channelLabel}: cadastre as credenciais em Administração → Integrações.
              </p>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={() => onToggleChannel(channel, !status.enabled)}
          disabled={!canToggle || disabled || unconfigured}
          aria-label={
            unconfigured
              ? `Configure ${channelLabel} credentials to control Sofia`
              : `${status.enabled ? 'Disable' : 'Enable'} Sofia for ${channelLabel}`
          }
          className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 min-h-11 sm:min-h-9 text-[11px] font-bold transition-all focus-visible:ring-2 focus-visible:ring-amber-500/40 focus-visible:outline-hidden ${
            status.enabled
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
              : 'border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20'
          } disabled:cursor-not-allowed disabled:opacity-50`}
        >
          {disabled ? <Loader2 className="h-3 w-3 animate-spin" /> : <Power className="h-3 w-3" />}
          {unconfigured ? 'Falta configurar' : status.enabled ? 'Enabled' : 'Off'}
        </button>
      </div>
    </div>
  )
}

export default function SofiaGlobalStatusBar({
  status,
  refreshing = false,
  togglingChannel = null,
  error = null,
  onToggleChannel,
  onRefresh,
}: SofiaGlobalStatusBarProps) {
  if (!status) {
    return (
      <section className="border-b border-zinc-800 bg-zinc-950/95 px-4 py-3 shadow-sm shadow-black/20">
        <div className="flex items-center gap-2 text-zinc-400">
          <Loader2 className="h-4.5 w-4.5 animate-spin text-amber-500" />
          <span className="text-xs font-semibold">Carregando status de atendimento da Sofia...</span>
        </div>
      </section>
    )
  }

  const canToggle = status.permissions.canToggleGlobalSofia
  const credits = status.credits
  const creditIsCurrent = credits.state === 'fresh' && credits.balanceUsd != null

  return (
    <section className="border-b border-zinc-800 bg-zinc-950/95 px-4 py-3 shadow-sm shadow-black/20">
      <div className="grid gap-3 xl:grid-cols-[1fr_auto] xl:items-stretch">
        <div className="grid gap-3 md:grid-cols-2">
          {(['whatsapp', 'telegram'] as const).map((channel) => (
            <ChannelCard
              key={channel}
              channel={channel}
              status={status.channels[channel]}
              canToggle={canToggle}
              disabled={togglingChannel === channel}
              onToggleChannel={onToggleChannel}
            />
          ))}
        </div>

        <div className={`rounded-xl border p-3 xl:w-80 ${CREDIT_CLASS[credits.color]}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <WalletCards className="h-4 w-4" />
                <span className="text-sm font-bold text-zinc-100">LLM credits</span>
                {credits.state === 'fresh' ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                ) : credits.state === 'stale' ? (
                  <PauseCircle className="h-3.5 w-3.5 text-zinc-400" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5 text-zinc-400" />
                )}
              </div>
              <p className="mt-2 text-lg font-black tracking-tight text-zinc-50">
                {creditIsCurrent ? formatUsd(credits.balanceUsd) : 'Unknown balance'}
              </p>
              <p className="text-[11px] text-zinc-400">
                {status.runtime.provider}
                {status.runtime.model ? ` · ${status.runtime.model}` : ''}
              </p>
              <p className="mt-1 text-[11px] text-zinc-500">Last refresh: {formatFetchedAt(credits.fetchedAt)}</p>
            </div>

            {onRefresh && (
              <button
                type="button"
                onClick={onRefresh}
                disabled={refreshing}
                aria-label="Refresh Sofia global status"
                className="rounded-lg border border-zinc-700 bg-zinc-900/60 p-2 min-h-11 min-w-11 focus-visible:ring-2 focus-visible:ring-amber-500/40 focus-visible:outline-hidden transition-colors hover:border-amber-500/50 hover:text-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              </button>
            )}
          </div>
        </div>
      </div>

      {!canToggle && (
        <p className="mt-2 text-[11px] text-zinc-500">You can view global Sofia status, but only admins and supervisors can change it.</p>
      )}
      {status.schedule.withinBusinessHours === false && (
        <p className="mt-2 text-[11px] text-yellow-300">Business-hours pause is active: Sofia will only send the configured schedule message while channels are enabled.</p>
      )}
      {error && <p className="mt-2 text-[11px] text-red-300">{error}</p>}
    </section>
  )
}
