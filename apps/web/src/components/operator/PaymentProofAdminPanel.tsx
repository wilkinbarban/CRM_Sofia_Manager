'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import {
  CheckCircle2,
  Eye,
  FileText,
  RotateCcw,
  ShieldX,
  X,
  ExternalLink,
  Lock,
  Unlock,
  AlertCircle,
  Clock,
  Sparkles,
  Smartphone,
  Send,
  Globe,
} from 'lucide-react'
import { ConfirmActionDialog } from './ui/ConfirmActionDialog'
import { createClient } from '@/lib/supabase/client'
import { useModalFocus } from '@/hooks/use-modal-focus'
import {
  getPaymentProofOperationalGatesDiagnostics,
  getPaymentProofUnresolvedDiagnostics,
  listEligiblePaymentProofOrders,
  listPaymentProofsForAdmin,
  mutatePaymentProofAdmin,
  replayPaymentProofDeadLetter,
} from '@/app/actions/payment-proof-admin'

type Proof = {
  id: string
  customer_id: string | null
  customer_name: string | null
  customer_phone?: string | null
  channel: string
  status: string
  preview_url: string | null
  original_url: string
  suggested_cents: number | null
  confirmed_cents: number | null
  extraction_confidence: number | null
  is_reconciled?: boolean
  purge_after: string | null
  created_at: string
}

type Order = {
  id: string
  customer_id: string
  total_pedido_centavos: number
  status: string
  status_pagamento: string
}

type Operation = 'acquire' | 'release' | 'confirm_amount' | 'reject' | 'restore' | 'reconcile'
type Mutation = { operation: Operation; proofId: string; value?: string | number; orderIds?: string[]; leaseToken?: string }
type Result = { success: boolean; error?: string; proof?: Pick<Proof, 'status' | 'purge_after'>; lease?: { token: string; expiresAt: string } }
type Diagnostics = {
  processing_queue_dead_letter: number
  outbox_dead_letter: number
  unresolved_dead_letter: number
  oldest_unresolved_dead_letter_at: string | null
  oldest_unresolved_dead_letter_age_seconds: number | null
}
type ReplayInput = { source: 'processing_queue' | 'outbox'; targetId: string; idempotencyKey: string }
type ReplayResult = { success: boolean; error?: string; outcome?: 'replayed' | 'ineligible' | 'idempotency_conflict' | 'invalid_request' }
type GateDiagnostics = {
  [key in 'canonicalIngest' | 'whatsappIngest' | 'telegramIngest' | 'processing' | 'sellerReconciliation' | 'privilegedReplay' | 'cleanup' | 'restore']: {
    effective: boolean
    reason: string
  }
}

const gateLabels: Record<keyof GateDiagnostics, string> = {
  canonicalIngest: 'Entrada canônica',
  whatsappIngest: 'Entrada WhatsApp',
  telegramIngest: 'Entrada Telegram',
  processing: 'Processamento',
  sellerReconciliation: 'Conciliação operacional',
  privilegedReplay: 'Reprocessamento privilegiado',
  cleanup: 'Limpeza',
  restore: 'Restauração',
}

const queues = [
  ['identity_pending', 'Identificação pendente'],
  ['review', 'Revisão manual'],
  ['received', 'Recebidos'],
  ['admitted', 'Admitidos'],
  ['quarantined', 'Quarentena'],
] as const

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const proofsPerPage = 10

export function quarantineCountdown(deadline: string | null, now = new Date()) {
  if (!deadline) return '—'
  const ms = Math.max(0, new Date(deadline).getTime() - now.getTime())
  return `${Math.floor(ms / 86400000)}d ${Math.floor((ms % 86400000) / 3600000)}h`
}

function message(error: string) {
  return (
    ({
      PAYMENT_PROOF_LEASE_CONFLICT: 'Este comprovante está em análise por outro operador.',
      PAYMENT_PROOF_LEASE_EXPIRED: 'A reserva expirou. Reserve o comprovante novamente.',
      PAYMENT_PROOF_AMOUNT_CONFLICT: 'O valor confirmado conflita com a confirmação existente.',
      PAYMENT_PROOF_AMOUNT_MISMATCH: 'Os pedidos selecionados não totalizam o comprovante.',
      PAYMENT_PROOF_ORDER_CUSTOMER_MISMATCH: 'Os pedidos devem ser do cliente do comprovante.',
      PAYMENT_PROOF_ORDER_INELIGIBLE: 'Um pedido selecionado não está elegível.',
      PAYMENT_PROOF_REQUESTED_ORDER_REQUIRED: 'Inclua os pedidos solicitados para este comprovante.',
      FORBIDDEN: 'Você não tem permissão para esta operação.',
    } as Record<string, string>)[error] || 'Não foi possível concluir a operação.'
  )
}

function channelBadge(channel: string) {
  const norm = channel.toLowerCase()
  if (norm === 'whatsapp') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-400 border border-emerald-500/20">
        <Smartphone className="h-3 w-3" />
        WhatsApp
      </span>
    )
  }
  if (norm === 'telegram') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-sky-400 border border-sky-500/20">
        <Send className="h-3 w-3" />
        Telegram
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-amber-400 border border-amber-500/20">
      <Globe className="h-3 w-3" />
      Web Chat
    </span>
  )
}

export default function PaymentProofAdminPanel({
  initialProofs,
  initialOrders,
  role = 'admin',
  mutate = mutatePaymentProofAdmin,
  diagnostics = getPaymentProofUnresolvedDiagnostics,
  gateDiagnostics = getPaymentProofOperationalGatesDiagnostics,
  replay = replayPaymentProofDeadLetter,
  now,
}: {
  initialProofs?: Proof[]
  initialOrders?: Order[]
  role?: string
  mutate?: (m: Mutation) => Promise<Result>
  diagnostics?: () => Promise<{ success: boolean; data?: Diagnostics; error?: string }>
  gateDiagnostics?: () => Promise<{ success: boolean; data?: GateDiagnostics; error?: string }>
  replay?: (input: ReplayInput) => Promise<ReplayResult>
  now?: string
}) {
  const privileged = role === 'admin' || role === 'supervisor'
  const [proofs, setProofs] = useState(initialProofs ?? [])
  const [queue, setQueue] = useState(initialProofs?.[0]?.status ?? 'identity_pending')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(initialProofs === undefined)
  const [orders, setOrders] = useState(initialOrders ?? [])
  const [selected, setSelected] = useState<string[]>([])
  const [pending, setPending] = useState<Mutation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<Proof | null>(null)
  const [lease, setLease] = useState<{ proofId: string; token: string } | null>(null)
  const [amount, setAmount] = useState('')
  const [metrics, setMetrics] = useState<Diagnostics | null>(null)
  const [gates, setGates] = useState<GateDiagnostics | null>(null)
  const [replayRequest, setReplayRequest] = useState<ReplayInput | null>(null)
  const [replayOutcome, setReplayOutcome] = useState<string | null>(null)
  const [replaySource, setReplaySource] = useState<ReplayInput['source']>('processing_queue')
  const [replayTarget, setReplayTarget] = useState('')
  const [replayConfirmed, setReplayConfirmed] = useState(false)
  const leaseRef = useRef(lease)
  const replayKey = useRef<string | null>(null)
  const [busy, startTransition] = useTransition()
  const previewDialogRef = useModalFocus(Boolean(preview?.preview_url), () => setPreview(null))
  const visible = proofs.filter((p) => p.status === queue)
  const pageCount = Math.max(1, Math.ceil(visible.length / proofsPerPage))
  const currentPage = Math.min(page, pageCount)
  const pageStart = (currentPage - 1) * proofsPerPage
  const paginatedProofs = visible.slice(pageStart, pageStart + proofsPerPage)
  const replayTargetValid = replaySource === 'processing_queue' ? uuid.test(replayTarget) : /^[1-9]\d*$/.test(replayTarget)

  const refreshProofs = useCallback(async () => {
    if (!privileged) return
    const result = await listPaymentProofsForAdmin()
    if (result.success) setProofs(result.data as Proof[])
    else setError(message(result.error))
    setLoading(false)
  }, [privileged])

  useEffect(() => {
    if (initialProofs !== undefined) return
    void refreshProofs()
  }, [initialProofs, refreshProofs])

  useEffect(() => {
    if (!privileged) return
    const supabase = createClient()
    const refresh = () => void refreshProofs()
    const refreshFromWindow = (event: Event) => {
      if (event instanceof CustomEvent && event.detail?.source === 'payment-proof-admin') return
      refresh()
    }
    window.addEventListener('crm:order-updated', refreshFromWindow)
    const channel = supabase
      .channel('operator-payment-proofs-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'payment_proofs' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pedidos' }, refresh)
      .subscribe()
    return () => {
      window.removeEventListener('crm:order-updated', refreshFromWindow)
      void supabase.removeChannel(channel)
    }
  }, [privileged, refreshProofs])

  useEffect(() => {
    const customer = proofs.find((p) => p.status === 'admitted' && p.customer_id)?.customer_id
    if (!privileged || initialOrders !== undefined || !customer) return
    listEligiblePaymentProofOrders(customer).then((r) => {
      if (r.success) setOrders(r.data as Order[])
      else setError(message(r.error))
    })
  }, [initialOrders, privileged, proofs])

  useEffect(() => {
    if (!privileged) return
    diagnostics().then((r) => {
      if (r.success && r.data) setMetrics(r.data)
      else setError(message(r.error || ''))
    })
  }, [diagnostics, privileged])

  useEffect(() => {
    if (!privileged) return
    gateDiagnostics().then((r) => {
      if (r.success && r.data) setGates(r.data)
      else setError(message(r.error || ''))
    })
  }, [gateDiagnostics, privileged])

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount))
  }, [pageCount])

  const release = useCallback(
    (current: { proofId: string; token: string }) =>
      void mutate({ operation: 'release', proofId: current.proofId, leaseToken: current.token }),
    [mutate]
  )

  useEffect(() => {
    leaseRef.current = lease
  }, [lease])

  useEffect(() => () => {
    if (leaseRef.current) release(leaseRef.current)
  }, [release])

  const reserve = (proofId: string) =>
    startTransition(async () => {
      if (lease?.proofId !== proofId && lease) release(lease)
      const targetProof = proofs.find((p) => p.id === proofId)
      if (targetProof?.suggested_cents) {
        setAmount(String(targetProof.suggested_cents))
      } else {
        setAmount('')
      }
      const r = await mutate({ operation: 'acquire', proofId })
      if (r.success && r.lease) setLease({ proofId, token: r.lease.token })
      else setError(message(r.error || ''))
    })

  const execute = () =>
    pending &&
    startTransition(async () => {
      let current = lease?.proofId === pending.proofId ? lease : null
      if (!current && pending.operation === 'reject') {
        const acq = await mutate({ operation: 'acquire', proofId: pending.proofId })
        if (acq.success && acq.lease) {
          current = { proofId: pending.proofId, token: acq.lease.token }
        }
      }
      const r = await mutate({ ...pending, leaseToken: current?.token })
      if (!r.success) setError(message(r.error || ''))
      else {
        setProofs((ps) =>
          ps.map((p) => (p.id === pending.proofId ? {
            ...p,
            ...r.proof,
            status: r.proof?.status ?? p.status,
            ...(pending.operation === 'confirm_amount' ? { confirmed_cents: Number(pending.value) } : {}),
          } : p))
        )
        window.dispatchEvent(new CustomEvent('crm:order-updated', {
          detail: { proofId: pending.proofId, source: 'payment-proof-admin' },
        }))
        if (['reject', 'reconcile'].includes(pending.operation) && current) {
          release(current)
          setLease(null)
        }
        if (pending.operation === 'reject') setQueue('quarantined')
      }
      setPending(null)
    })

  const beginReplay = () => {
    if (!replayTargetValid || !replayConfirmed) return
    const idempotencyKey = replayKey.current ?? crypto.randomUUID()
    replayKey.current = idempotencyKey
    setReplayRequest({ source: replaySource, targetId: replayTarget, idempotencyKey })
  }

  const executeReplay = () =>
    replayRequest &&
    startTransition(async () => {
      const r = await replay(replayRequest)
      if (r.success) {
        setReplayOutcome(
          ({
            replayed: 'Reprocessado.',
            ineligible: 'Não elegível para reprocessamento.',
            idempotency_conflict: 'Conflito de idempotência.',
            invalid_request: 'Solicitação inválida.',
          } as Record<string, string>)[r.outcome || ''] || 'Solicitação inválida.'
        )
        if (r.outcome === 'replayed') replayKey.current = null
      } else setError(message(r.error || ''))
      setReplayRequest(null)
    })

  const exact = (p: Proof) =>
    orders
      .filter((o) => selected.includes(o.id))
      .reduce((sum, o) => sum + o.total_pedido_centavos, 0) === (p.confirmed_cents ?? 0)

  if (!privileged) return null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 text-zinc-100 animate-in fade-in duration-200">
      {/* Header do Painel */}
      <header className="rounded-3xl border border-zinc-800/80 bg-zinc-900/90 p-6 shadow-xl shadow-black/40 backdrop-blur-sm">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-800/80 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-black uppercase tracking-[.25em] text-amber-400">
                Gestão Financeira & Omnichannel
              </span>
            </div>
            <h2 className="mt-1 text-2xl font-black tracking-tight text-zinc-100 sm:text-3xl">
              Comprovantes PIX
            </h2>
            <p className="mt-1 text-xs text-zinc-400">
              Triagem em tempo real, auditoria documental e conciliação comprovante–pedido supervisionada.
            </p>
          </div>

          {privileged && metrics && (
            <div className="flex items-center gap-3">
              <section
                aria-label="Diagnóstico de cartas mortas"
                className="flex items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-2 text-xs shadow-inner"
              >
                <div className="flex flex-col">
                  <span className="text-[10px] font-semibold text-zinc-500">Cartas Mortas</span>
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-zinc-200">
                      Não resolvidos: {metrics.unresolved_dead_letter}
                    </span>
                    <span className="text-zinc-600">·</span>
                    <span className="font-mono text-zinc-400">Fila: {metrics.processing_queue_dead_letter}</span>
                    <span className="text-zinc-600">·</span>
                    <span className="font-mono text-zinc-400">Saída: {metrics.outbox_dead_letter}</span>
                  </div>
                </div>
              </section>
            </div>
          )}
        </div>

        {/* Portões Operacionais */}
        {privileged && gates && (
          <section
            aria-label="Portões operacionais"
            className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-zinc-300"
          >
            {(Object.keys(gateLabels) as (keyof GateDiagnostics)[]).map((key) => {
              const active = gates[key].effective
              return (
                <span
                  key={key}
                  className={`inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1 font-medium border ${
                    active
                      ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20'
                      : 'bg-zinc-800/40 text-zinc-400 border-zinc-800'
                  }`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
                  {gateLabels[key]}: {active ? 'aberta' : 'fechada'} · {gates[key].reason}
                </span>
              )
            })}
          </section>
        )}

        {/* Reprocessar Carta Morta */}
        {privileged && (
          <section
            aria-label="Reprocessar carta morta"
            className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl bg-zinc-950/40 border border-zinc-800/60 p-3 text-xs"
          >
            <span className="font-semibold text-zinc-300">Reprocessar:</span>
            <select
              aria-label="Fonte da carta morta"
              value={replaySource}
              onChange={(e) => {
                setReplaySource(e.target.value as ReplayInput['source'])
                replayKey.current = null
                setReplayConfirmed(false)
              }}
              className="rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 focus:border-amber-500 focus:outline-none"
            >
              <option value="processing_queue">Fila de processamento</option>
              <option value="outbox">Caixa de saída</option>
            </select>
            <input
              aria-label="ID alvo da carta morta"
              value={replayTarget}
              onChange={(e) => {
                setReplayTarget(e.target.value)
                replayKey.current = null
                setReplayConfirmed(false)
              }}
              placeholder={replaySource === 'processing_queue' ? 'UUID do trabalho' : 'ID da saída'}
              className="rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:border-amber-500 focus:outline-none w-48 font-mono"
            />
            <label className="flex items-center gap-1.5 cursor-pointer text-zinc-300 select-none">
              <input
                type="checkbox"
                checked={replayConfirmed}
                onChange={(e) => setReplayConfirmed(e.target.checked)}
                className="rounded border-zinc-700 bg-zinc-900 text-amber-500 focus:ring-0"
              />
              Confirmo o reprocessamento
            </label>
            <button
              type="button"
              disabled={!replayTargetValid || !replayConfirmed || busy}
              onClick={beginReplay}
              className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500 px-3.5 py-1.5 text-xs font-bold text-zinc-950 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer shadow-md"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reprocessar carta morta
            </button>
            {replayOutcome && <p role="status" className="text-xs font-bold text-emerald-400 ml-2">{replayOutcome}</p>}
          </section>
        )}
      </header>

      {/* Abas de Filtros de Filas */}
      <div aria-label="Filtros de comprovantes" className="flex flex-wrap gap-2">
        {queues.map(([id, label]) => {
          const count = proofs.filter((p) => p.status === id).length
          const isCurrent = queue === id
          return (
            <button
              key={id}
              type="button"
              aria-pressed={isCurrent}
              onClick={() => {
                setQueue(id)
                setPage(1)
              }}
              className={`inline-flex items-center gap-2 rounded-2xl px-4 py-2.5 text-xs font-bold transition-all cursor-pointer select-none border ${
                isCurrent
                  ? 'bg-amber-500 text-zinc-950 border-amber-500 shadow-md shadow-amber-500/20'
                  : 'bg-zinc-900/80 text-zinc-300 border-zinc-800 hover:bg-zinc-800 hover:border-zinc-700'
              }`}
            >
              <span>{label}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-black ${
                  isCurrent ? 'bg-zinc-950 text-amber-400' : 'bg-zinc-800 text-zinc-400'
                }`}
              >
                {count}
              </span>
            </button>
          )
        })}
      </div>

      {error && (
        <div role="alert" className="flex items-center gap-2 rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4 text-xs font-medium text-rose-300 shadow-lg">
          <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
          <span>{error}</span>
        </div>
      )}

      {/* Proof workspace */}
      {!loading && visible.length > 0 && (
        <nav aria-label="Paginação de comprovantes" className="flex items-center justify-between gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/70 px-4 py-2 text-xs">
          <span aria-live="polite" className="font-medium text-zinc-400">
            Mostrando {pageStart + 1}–{Math.min(pageStart + proofsPerPage, visible.length)} de {visible.length} comprovantes
          </span>
          {pageCount > 1 && (
            <div className="flex items-center gap-2">
              <button type="button" aria-label="Página anterior" disabled={currentPage === 1} onClick={() => setPage((current) => Math.max(1, current - 1))} className="rounded-xl border border-zinc-700 px-3 py-1.5 font-semibold text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40">
                Anterior
              </button>
              <span className="font-mono text-zinc-500">{currentPage}/{pageCount}</span>
              <button type="button" aria-label="Próxima página" disabled={currentPage === pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))} className="rounded-xl border border-zinc-700 px-3 py-1.5 font-semibold text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40">
                Próxima
              </button>
            </div>
          )}
        </nav>
      )}

      <div aria-label="Resultados de comprovantes" className="grid min-h-0 flex-1 gap-4 overflow-y-auto pr-1 xl:grid-cols-2">
        {loading ? (
          <div role="status" className="col-span-2 p-12 text-center text-sm font-medium text-zinc-500">
            Carregando comprovantes…
          </div>
        ) : visible.length === 0 ? (
          <div role="status" className="col-span-2 rounded-3xl border border-zinc-800 bg-zinc-900/30 p-12 text-center text-sm text-zinc-500">
            Nenhum comprovante nesta fila.
          </div>
        ) : (
          paginatedProofs.map((p) => {
            const isReserved = lease?.proofId === p.id
            const confidencePercent = p.extraction_confidence != null ? Math.round(p.extraction_confidence * 100) : null
            const formattedSuggested = p.suggested_cents != null ? `R$ ${(p.suggested_cents / 100).toFixed(2).replace('.', ',')}` : '—'

            return (
              <article
                key={p.id}
                className={`rounded-3xl border p-5 shadow-lg transition-all ${
                  isReserved
                    ? 'border-amber-500/50 bg-gradient-to-b from-amber-500/5 to-zinc-900 shadow-amber-500/10'
                    : 'border-zinc-800/80 bg-zinc-900/70 hover:border-zinc-700'
                }`}
              >
                {/* Header do Card */}
                <div className="flex items-start justify-between border-b border-zinc-800/80 pb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-bold text-zinc-100 text-sm">{p.customer_name || 'Cliente não identificado'}</p>
                      {isReserved && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-black uppercase text-amber-300 border border-amber-500/40">
                          <Lock className="h-2.5 w-2.5" />
                          Reservado nesta tela
                        </span>
                      )}
                      {p.is_reconciled && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-black uppercase text-emerald-300 border border-emerald-500/40">
                          <CheckCircle2 className="h-2.5 w-2.5" />
                          Conciliado
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-[11px]">
                      <span className="font-mono text-zinc-500">ID …{p.id.slice(-8)}</span>
                      {p.customer_phone && (
                        <>
                          <span className="text-zinc-600">·</span>
                          <span className="font-mono text-amber-400 font-semibold">{p.customer_phone}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div>{channelBadge(p.channel)}</div>
                </div>

                {/* Métricas Extraídas */}
                <dl className="grid grid-cols-2 gap-4 py-4 text-xs">
                  <div className="rounded-2xl bg-zinc-950/40 border border-zinc-800/60 p-3">
                    <dt className="text-[11px] font-semibold text-zinc-400 flex items-center gap-1">
                      <Sparkles className="h-3 w-3 text-amber-400" />
                      Valor sugerido
                    </dt>
                    <dd className="mt-1 text-base font-mono font-black text-amber-400">{formattedSuggested}</dd>
                  </div>

                  <div className="rounded-2xl bg-zinc-950/40 border border-zinc-800/60 p-3">
                    <dt className="text-[11px] font-semibold text-zinc-400 flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                      Confiança da análise
                    </dt>
                    <dd className="mt-1 flex items-baseline gap-2">
                      <span className="text-base font-mono font-black text-emerald-400">
                        {confidencePercent != null ? `${confidencePercent}%` : '—'}
                      </span>
                      {confidencePercent != null && (
                        <span className="text-[10px] text-zinc-500">
                          {confidencePercent >= 80 ? 'Alta precisão' : 'Revisão recomendada'}
                        </span>
                      )}
                    </dd>
                  </div>

                  {p.status === 'quarantined' && (
                    <div className="col-span-2 rounded-2xl bg-rose-500/10 border border-rose-500/20 p-3 text-rose-300 text-xs flex items-center gap-2">
                      <Clock className="h-4 w-4 shrink-0 text-rose-400" />
                      <span>
                        Eliminação automática em: {quarantineCountdown(p.purge_after, now ? new Date(now) : new Date())}
                      </span>
                    </div>
                  )}
                </dl>

                {/* Barra de Ações do Card */}
                <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800/80 pt-4">
                  {/* Visualização */}
                  <button
                    type="button"
                    disabled={!p.preview_url}
                    onClick={() => setPreview(p)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700/80 transition-all cursor-pointer shadow-sm hover:border-zinc-600 active:scale-95 disabled:opacity-40"
                  >
                    <Eye className="h-3.5 w-3.5 text-amber-400" />
                    <span>Vista Previa</span>
                  </button>

                  <a
                    href={p.original_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700/80 transition-all cursor-pointer shadow-sm hover:border-zinc-600 active:scale-95"
                  >
                    <FileText className="h-3.5 w-3.5 text-zinc-400" />
                    <span>PDF original</span>
                  </a>

                  {/* Reserva / Ações do Operador */}
                  {!isReserved && p.status !== 'quarantined' && (
                    <div className="flex items-center gap-2 ml-auto">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setPending({ operation: 'reject', proofId: p.id })}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 transition-all cursor-pointer active:scale-95 shadow-sm"
                        title="Rejeitar comprovante e enviar para quarentena"
                      >
                        <ShieldX className="h-3.5 w-3.5 text-rose-400" />
                        <span>Rejeitar</span>
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => reserve(p.id)}
                        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-bold bg-amber-500 hover:bg-amber-400 text-zinc-950 shadow-md shadow-amber-500/10 transition-all cursor-pointer active:scale-95"
                      >
                        <Lock className="h-3.5 w-3.5" />
                        <span>Reservar análise</span>
                      </button>
                    </div>
                  )}

                  {isReserved && (
                    <div className="flex flex-wrap items-center gap-2 w-full mt-2 pt-2 border-t border-amber-500/20">
                      {p.status === 'review' && (
                        <div className="flex items-center gap-2 w-full sm:w-auto">
                          <input
                            aria-label="Valor confirmado em centavos"
                            inputMode="numeric"
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                            placeholder="Valor em centavos"
                            className="rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs font-mono font-bold text-amber-400 placeholder-zinc-600 focus:border-amber-500 focus:outline-none w-36 shadow-inner"
                          />
                          <button
                            type="button"
                            disabled={!/^\d+$/.test(amount) || Number(amount) <= 0}
                            onClick={() => setPending({ operation: 'confirm_amount', proofId: p.id, value: amount })}
                            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-bold bg-emerald-500 hover:bg-emerald-400 text-zinc-950 shadow-md shadow-emerald-500/20 transition-all cursor-pointer active:scale-95 disabled:opacity-40"
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            <span>Confirmar valor</span>
                          </button>
                        </div>
                      )}

                      {p.status === 'admitted' && (
                        <div className="w-full space-y-3 rounded-2xl bg-zinc-950/60 border border-zinc-800 p-4">
                          <p className="text-xs font-bold text-zinc-300">Pedidos pendentes do cliente</p>
                          <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                            {orders
                              .filter((o) => o.customer_id === p.customer_id)
                              .map((o) => (
                                <label
                                  key={o.id}
                                  className="flex items-center gap-2 rounded-xl bg-zinc-900 border border-zinc-800/80 p-2 text-xs text-zinc-200 cursor-pointer hover:bg-zinc-800/60 transition-colors"
                                >
                                  <input
                                    type="checkbox"
                                    aria-label={`Pedido ${o.id.slice(-4)}`}
                                    checked={selected.includes(o.id)}
                                    onChange={() =>
                                      setSelected((s) =>
                                        s.includes(o.id) ? s.filter((id) => id !== o.id) : [...s, o.id]
                                      )
                                    }
                                    className="rounded border-zinc-700 bg-zinc-950 text-emerald-500 focus:ring-0"
                                  />
                                  <span>Pedido …{o.id.slice(-4)}</span>
                                  <span className="font-mono font-bold text-amber-400 ml-auto">
                                    R$ {(o.total_pedido_centavos / 100).toFixed(2).replace('.', ',')}
                                  </span>
                                </label>
                              ))}
                          </div>

                          <div className="flex items-center justify-between border-t border-zinc-800 pt-2 text-xs">
                            <span className="text-zinc-400">
                              Selecionado: R${' '}
                              {(
                                orders
                                  .filter((o) => selected.includes(o.id))
                                  .reduce((sum, o) => sum + o.total_pedido_centavos, 0) / 100
                              )
                                .toFixed(2)
                                .replace('.', ',')}{' '}
                              · Comprovante: R$ {(((p.confirmed_cents ?? 0) / 100).toFixed(2)).replace('.', ',')}
                            </span>
                            <button
                              type="button"
                              disabled={!selected.length || !exact(p)}
                              onClick={() => setPending({ operation: 'reconcile', proofId: p.id, orderIds: selected })}
                              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider bg-emerald-500 hover:bg-emerald-400 text-zinc-950 shadow-lg shadow-emerald-500/20 transition-all cursor-pointer active:scale-95 disabled:opacity-40"
                            >
                              Conciliar pedidos
                            </button>
                          </div>
                        </div>
                      )}

                      <button
                        type="button"
                        onClick={() => setPending({ operation: 'reject', proofId: p.id })}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 transition-all cursor-pointer active:scale-95 ml-auto shadow-sm"
                        title="Rejeitar e passar comprovante para quarentena"
                      >
                        <ShieldX className="h-3.5 w-3.5" />
                        <span>Rejeitar</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          release(lease)
                          setLease(null)
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-800 rounded-xl hover:bg-zinc-800/60 transition-all cursor-pointer"
                      >
                        <Unlock className="h-3 w-3" />
                        <span>Liberar reserva</span>
                      </button>
                    </div>
                  )}

                  {p.status === 'quarantined' && role === 'admin' && (
                    <button
                      type="button"
                      onClick={() => setPending({ operation: 'restore', proofId: p.id })}
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-bold bg-blue-500 hover:bg-blue-400 text-zinc-950 shadow-md transition-all cursor-pointer active:scale-95 ml-auto"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      <span>Restaurar</span>
                    </button>
                  )}
                </div>
              </article>
            )
          })
        )}
      </div>

      {/* Modal de Prévia Elegante e Independente */}
      {preview?.preview_url && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="payment-proof-preview-title"
          ref={previewDialogRef}
          tabIndex={-1}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-4 animate-in fade-in focus:outline-none"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPreview(null)
          }}
        >
          <div className="relative w-full max-w-md rounded-3xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl shadow-black/90 space-y-4 text-zinc-100 flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div className="flex items-center gap-2 text-amber-400">
                <Eye className="h-4 w-4" />
                <h3 id="payment-proof-preview-title" className="text-sm font-bold text-zinc-100">Prévia do comprovante</h3>
              </div>
              <button
                type="button"
                onClick={() => setPreview(null)}
                className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
                aria-label="Fechar prévia"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-auto flex items-center justify-center p-2 rounded-2xl bg-zinc-950 border border-zinc-800">
              {/* eslint-disable-next-line @next/next/no-img-element -- Authenticated preview served by private API route */}
              <img
                src={preview.preview_url}
                alt="Comprovante PIX ampliado"
                className="max-h-[60vh] w-auto max-w-full object-contain rounded-xl shadow-md"
              />
            </div>

            <div className="flex items-center justify-between border-t border-zinc-800 pt-3 text-xs text-zinc-400">
              <span className="font-mono text-[11px]">ID …{preview.id.slice(-8)}</span>
              <div className="flex items-center gap-2">
                <a
                  href={preview.preview_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-medium transition-colors"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  <span>Nova aba</span>
                </a>
                <a
                  href={preview.original_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 font-bold transition-colors shadow-sm"
                >
                  <FileText className="h-3.5 w-3.5" />
                  <span>Baixar PDF</span>
                </a>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Dialogs de Confirmação */}
      {replayRequest && (
        <ConfirmActionDialog
          title="Confirmar reprocessamento"
          description="O reprocessamento será solicitado explicitamente à autoridade do servidor."
          confirmLabel="Confirmar reprocessamento"
          onConfirm={executeReplay}
          onClose={() => setReplayRequest(null)}
          busy={busy}
        />
      )}

      {pending && (
        <ConfirmActionDialog
          title="Confirmar ação"
          description="Esta ação será aplicada pela autoridade do servidor."
          confirmLabel={
            pending.operation === 'reconcile'
              ? 'Confirmar conciliação'
              : pending.operation === 'confirm_amount'
              ? 'Confirmar valor'
              : pending.operation === 'restore'
              ? 'Confirmar restauração'
              : 'Confirmar ação'
          }
          onConfirm={execute}
          onClose={() => setPending(null)}
          busy={busy}
        />
      )}
    </div>
  )
}
