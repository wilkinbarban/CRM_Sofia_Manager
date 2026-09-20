'use client'

import React, { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import {
  Package,
  ReceiptText,
  Lock,
  MessageSquare,
  Sparkles,
  ShoppingBag,
  Loader2,
  RefreshCw,
  QrCode,
  FileCheck,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { actionListarMeusPedidosCliente } from '@/app/actions/pedidos'
import ModalPagamentoCliente from '@/components/cliente/ModalPagamentoCliente'
import ModalVisualizadorComprovante from '@/components/comprovantes/ModalVisualizadorComprovante'

export interface PedidoItemCliente {
  id: string
  produto_id: string
  quantidade: number
  preco_unitario_centavos: number
  produtos?: {
    id: string
    nome: string
    preco_centavos: number
    url_imagem?: string | null
    url_imagem_thumb?: string | null
  } | null
}

export interface PedidoClienteRecord {
  id: string
  cliente_id: string
  conversa_id?: string | null
  status: 'novo' | 'confirmado' | 'entregue' | 'cancelado'
  tipo_entrega: 'entrega' | 'retirada'
  endereco_entrega?: string | null
  taxa_entrega_centavos: number
  total_produtos_centavos: number
  total_pedido_centavos: number
  status_pagamento: 'pendente' | 'aprovado' | 'rejeitado' | 'reembolsado'
  meio_pagamento: 'pix' | 'cartao_credito' | 'cartao_debito' | 'dinheiro'
  horario_retirada?: string | null
  observacoes?: string | null
  criado_em: string
  data_criacao: string
  data_atualizacao: string
  itens_pedido?: PedidoItemCliente[]
  payment_review?: {
    locked: boolean
    status: string | null
    proofId: string | null
    lockedAt: string | null
    paymentReviewUnavailable?: boolean
  }
}

export interface ClienteOrdersDashboardProps {
  pedidosIniciais: PedidoClienteRecord[]
  clienteId?: string
}

export default function ClienteOrdersDashboard({
  pedidosIniciais,
  clienteId,
}: ClienteOrdersDashboardProps) {
  const [pedidos, setPedidos] = useState<PedidoClienteRecord[]>(pedidosIniciais)
  const [loading, setLoading] = useState(false)
  const [modalPagamento, setModalPagamento] = useState<{
    pedidoId: string
    valorCentavos: number
    statusPagamento: 'pendente' | 'aprovado' | 'rejeitado' | 'reembolsado'
    abaInicial?: 'pix' | 'cartao' | 'comprovante'
  } | null>(null)
  const [modalVisualizador, setModalVisualizador] = useState<{
    isOpen: boolean
    urlArquivo: string | null
    nomeArquivo?: string
    clienteNome?: string
    dataCriacao?: string
  }>({ isOpen: false, urlArquivo: null })
  const supabase = createClient()

  const carregarPedidos = useCallback(async () => {
    setLoading(true)
    try {
      const res = await actionListarMeusPedidosCliente()
      if (res.success && res.data) {
        setPedidos(res.data as any)
      }
    } catch (err) {
      console.error('Erro ao atualizar pedidos do cliente:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  const hasPaymentReviewLock = pedidos.some(
    (pedido) => pedido.payment_review?.locked && !pedido.payment_review?.paymentReviewUnavailable,
  )

  useEffect(() => {
    if (!hasPaymentReviewLock) return

    const interval = window.setInterval(carregarPedidos, 7500)
    return () => window.clearInterval(interval)
  }, [hasPaymentReviewLock, carregarPedidos])

  // Sincronização em tempo real via canal Supabase
  useEffect(() => {
    if (!clienteId) return

    const channel = supabase
      .channel(`cliente-pedidos-dashboard-${clienteId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'pedidos',
          filter: `cliente_id=eq.${clienteId}`,
        },
        () => {
          carregarPedidos()
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'payment_proofs',
          filter: `customer_id=eq.${clienteId}`,
        },
        () => {
          carregarPedidos()
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'itens_pedido',
        },
        () => {
          carregarPedidos()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [clienteId, supabase, carregarPedidos])

  const formatarMoeda = (centavos: number) =>
    (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

  const pedidosAtivos = pedidos.filter((p) => p.status === 'novo' || p.status === 'confirmado')
  const totalGasto = pedidos
    .filter((p) => p.status_pagamento === 'aprovado')
    .reduce((acc, p) => acc + (p.total_pedido_centavos || 0), 0)

  return (
    <div className="flex-1 overflow-y-auto bg-zinc-950 p-4 sm:p-6 lg:p-8 space-y-6">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header Hero Banner */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 sm:p-6 rounded-3xl border border-amber-500/20 bg-gradient-to-br from-amber-500/10 via-zinc-900/60 to-zinc-950 shadow-xl shadow-black/40">
          <div>
            <span className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-400">
              Painel do Cliente • Balcão de Retirada
            </span>
            <h1 className="mt-1 text-2xl font-black text-zinc-50 flex items-center gap-2.5">
              <Package className="h-6 w-6 text-amber-500" />
              <span>Meus Pedidos</span>
            </h1>
            <p className="mt-1 text-xs text-zinc-400 leading-relaxed max-w-xl">
              Acompanhe a preparação na cozinha em tempo real, o status de pagamento e acesse as 2ª vias digitais dos seus comprovantes.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={carregarPedidos}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 rounded-xl text-xs font-semibold border border-zinc-800 transition-all cursor-pointer select-none active:scale-95 disabled:opacity-50"
              title="Atualizar lista de pedidos"
            >
              <RefreshCw className={`h-3.5 w-3.5 text-amber-400 ${loading ? 'animate-spin' : ''}`} />
              <span>Atualizar</span>
            </button>

            <Link
              href="/cliente/chat"
              className="flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-zinc-950 rounded-xl text-xs font-black shadow-md shadow-amber-500/10 transition-all active:scale-95 select-none"
            >
              <ShoppingBag className="h-3.5 w-3.5" />
              <span>Novo Pedido</span>
            </Link>
          </div>
        </div>

        {/* Métricas Rápidas */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
          <div className="p-4 rounded-2xl border border-zinc-800/80 bg-zinc-900/40 space-y-1">
            <span className="text-[11px] font-medium text-zinc-400">Total de Pedidos</span>
            <div className="text-xl font-black text-zinc-100">{pedidos.length}</div>
          </div>
          <div className="p-4 rounded-2xl border border-amber-500/20 bg-amber-500/5 space-y-1">
            <span className="text-[11px] font-medium text-amber-400">Em Atendimento / Preparo</span>
            <div className="text-xl font-black text-amber-300">{pedidosAtivos.length}</div>
          </div>
          <div className="p-4 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 space-y-1">
            <span className="text-[11px] font-medium text-emerald-400">Total Pago</span>
            <div className="text-xl font-black text-emerald-300 font-mono">{formatarMoeda(totalGasto)}</div>
          </div>
        </div>

        {/* Lista de Pedidos */}
        <div className="space-y-4">
          <h2 className="text-sm font-bold text-zinc-200 tracking-wide uppercase">
            Histórico Completo
          </h2>

          {loading && pedidos.length === 0 ? (
            <div className="py-16 flex flex-col items-center justify-center text-zinc-500 gap-2">
              <Loader2 className="h-7 w-7 animate-spin text-amber-500" />
              <span className="text-xs">Carregando seus pedidos...</span>
            </div>
          ) : pedidos.length === 0 ? (
            <div className="py-16 text-center text-zinc-500 bg-zinc-900/20 rounded-3xl border border-zinc-800/80 p-8 space-y-3">
              <Package className="h-12 w-12 mx-auto text-zinc-700 mb-1" />
              <h3 className="text-sm font-bold text-zinc-300">Nenhum pedido registrado ainda</h3>
              <p className="text-xs text-zinc-500 max-w-md mx-auto">
                Monte seu pedido na aba Cardápio ou converse com a Sofía no chat para fazer sua reserva de assados de domingo!
              </p>
              <Link
                href="/cliente/chat"
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-amber-500 hover:bg-amber-400 text-zinc-950 rounded-xl text-xs font-black transition-all shadow-md shadow-amber-500/10 mt-2 cursor-pointer"
              >
                <Sparkles className="h-4 w-4" />
                <span>Abrir Cardápio no Chat</span>
              </Link>
            </div>
          ) : (
            <div className="space-y-4">
              {pedidos.map((pedido) => {
                const isLocked = pedido.status === 'novo' || pedido.status === 'confirmado'
                const paymentReviewLocked = pedido.payment_review?.locked === true

                const statusBadgeConfig = {
                  novo: { label: 'Em Atendimento', bg: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
                  confirmado: { label: 'Em Preparo', bg: 'bg-blue-500/15 text-blue-300 border-blue-500/30' },
                  entregue: { label: 'Concluído', bg: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
                  cancelado: { label: 'Cancelado', bg: 'bg-red-500/15 text-red-300 border-red-500/30' },
                }[pedido.status] || { label: pedido.status, bg: 'bg-zinc-800 text-zinc-300 border-zinc-700' }

                const paymentBadgeConfig = {
                  aprovado: { label: '💳 Pago (Aprovado)', bg: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
                  pendente: {
                    label: paymentReviewLocked ? '⏳ Em Análise / Conferência' : '⏳ Pagamento Pendente',
                    bg: paymentReviewLocked ? 'bg-sky-500/15 text-sky-300 border-sky-500/30' : 'bg-zinc-800 text-zinc-400 border-zinc-700',
                  },
                  rejeitado: { label: '❌ Pagamento Recusado', bg: 'bg-red-500/15 text-red-300 border-red-500/30' },
                  reembolsado: { label: '🔄 Reembolsado', bg: 'bg-purple-500/15 text-purple-300 border-purple-500/30' },
                }[pedido.status_pagamento] || { label: pedido.status_pagamento, bg: 'bg-zinc-800 text-zinc-400 border-zinc-700' }

                return (
                  <div
                    key={pedido.id}
                    className="p-5 rounded-3xl border border-zinc-800 bg-zinc-900/40 hover:bg-zinc-900/60 transition-all space-y-4 shadow-sm"
                  >
                    {/* Header do Card */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-3 border-b border-zinc-800/80">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono font-bold text-zinc-200">
                            #{pedido.id.substring(0, 8).toUpperCase()}
                          </span>
                          <span className="text-[11px] text-zinc-500">
                            • {new Date(pedido.data_criacao).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })} às {new Date(pedido.data_criacao).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>

                        <div className="flex items-center gap-2 mt-1.5">
                          <span className={`inline-block px-2.5 py-0.5 rounded-full text-[10px] font-bold border ${statusBadgeConfig.bg}`}>
                            {statusBadgeConfig.label}
                          </span>
                          <span className={`inline-block px-2.5 py-0.5 rounded-full text-[10px] font-bold border ${paymentBadgeConfig.bg}`}>
                            {paymentBadgeConfig.label}
                          </span>
                        </div>
                      </div>

                      <div className="text-left sm:text-right">
                        <span className="text-[11px] text-zinc-500 block">Total do Pedido</span>
                        <span className="text-lg font-black text-amber-400 font-mono">
                          {formatarMoeda(pedido.total_pedido_centavos || pedido.total_produtos_centavos)}
                        </span>
                      </div>
                    </div>

                    {/* Lista de Itens do Pedido */}
                    {pedido.itens_pedido && pedido.itens_pedido.length > 0 && (
                      <div className="space-y-2">
                        <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider block">
                          Itens Selecionados ({pedido.itens_pedido.reduce((acc, it) => acc + it.quantidade, 0)})
                        </span>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {pedido.itens_pedido.map((it) => (
                            <div
                              key={it.id}
                              className="flex items-center justify-between p-2.5 rounded-xl border border-zinc-800/80 bg-zinc-950/40 text-xs"
                            >
                              <span className="font-semibold text-zinc-200 truncate pr-2">
                                {it.quantidade}x {it.produtos?.nome || 'Item'}
                              </span>
                              <span className="font-mono text-amber-400/90 shrink-0 font-medium">
                                {formatarMoeda(it.preco_unitario_centavos * it.quantidade)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Aviso de Bloqueio em Atendimento */}
                    {isLocked && (
                      <div className="flex items-start gap-2.5 p-3 rounded-2xl bg-amber-500/5 border border-amber-500/20 text-xs text-amber-300/90 leading-relaxed">
                        <Lock className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                        <div>
                          <strong>Pedido em atendimento na cozinha:</strong> Bloqueado para edições diretas na aplicação. Caso deseje solicitar cancelamento ou alteração de itens/horário, converse diretamente com a Sofia no chat.
                        </div>
                      </div>
                    )}

                    {paymentReviewLocked && (
                      <div
                        role="status"
                        className="flex items-start gap-2.5 rounded-2xl border border-sky-500/25 bg-sky-500/10 p-3 text-xs leading-relaxed text-sky-200"
                      >
                        <FileCheck className="mt-0.5 h-4 w-4 shrink-0 text-sky-300" />
                        <div>
                          <strong>{pedido.payment_review?.paymentReviewUnavailable
                            ? 'Revisão de pagamento indisponível — aguardando atualização.'
                            : 'Comprovante recebido — aguardando verificação.'}</strong>{' '}
                          {pedido.payment_review?.paymentReviewUnavailable
                            ? 'Por segurança, as opções de pagamento e comprovante estão temporariamente bloqueadas. Tente atualizar em instantes.'
                            : 'O pagamento deste pedido está protegido enquanto o atendente confere o documento. Se ele for rejeitado, você poderá enviar outro PDF.'}
                        </div>
                      </div>
                    )}

                    {/* Ações do Pedido */}
                    <div className="pt-3 border-t border-zinc-800/80 flex flex-wrap items-center justify-between gap-3">
                      <Link
                        href="/cliente/chat"
                        className="inline-flex items-center gap-1.5 text-xs text-zinc-400 hover:text-amber-300 font-semibold transition-colors"
                      >
                        <MessageSquare className="h-3.5 w-3.5" />
                        <span>Falar com Sofía sobre esse pedido</span>
                      </Link>

                      <div className="flex flex-wrap items-center gap-2">
                        {(pedido.status_pagamento === 'pendente' || pedido.status_pagamento === 'rejeitado') &&
                          pedido.status !== 'cancelado' &&
                          !paymentReviewLocked && (
                          <>
                            <button
                              type="button"
                              onClick={() =>
                                setModalPagamento({
                                  pedidoId: pedido.id,
                                  valorCentavos: pedido.total_pedido_centavos || pedido.total_produtos_centavos,
                                  statusPagamento: pedido.status_pagamento,
                                })
                              }
                              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-zinc-950 rounded-xl text-xs font-black shadow-md shadow-amber-500/10 transition-all cursor-pointer select-none active:scale-95"
                            >
                              <QrCode className="h-3.5 w-3.5" />
                              <span>⚡ Pagar Pedido (PIX / Cartão)</span>
                            </button>

                            {pedido.status_pagamento === 'pendente' && <button
                              type="button"
                              onClick={() =>
                                setModalPagamento({
                                  pedidoId: pedido.id,
                                  valorCentavos: pedido.total_pedido_centavos || pedido.total_produtos_centavos,
                                  statusPagamento: pedido.status_pagamento,
                                  abaInicial: 'comprovante',
                                })
                              }
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 rounded-xl text-xs font-semibold border border-zinc-800 transition-all cursor-pointer select-none"
                            >
                              <FileCheck className="h-3.5 w-3.5 text-amber-400" />
                              <span>Comprovante</span>
                            </button>}
                          </>
                        )}

                        {pedido.status_pagamento === 'aprovado' && (
                          <button
                            type="button"
                            onClick={() =>
                              setModalVisualizador({
                                isOpen: true,
                                urlArquivo: `/api/receipts/${pedido.id}/pdf?via=cliente`,
                                nomeArquivo: `comprovante-pedido-${pedido.id.substring(0, 8)}.pdf`,
                                clienteNome: 'Você',
                                dataCriacao: pedido.data_criacao,
                              })
                            }
                            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-amber-300 rounded-xl text-xs font-bold transition-all border border-amber-500/30 cursor-pointer"
                          >
                            <ReceiptText className="h-3.5 w-3.5" />
                            <span>Visualizar Comprovante (PDF)</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {modalPagamento && (
        <ModalPagamentoCliente
          isOpen={!!modalPagamento}
          onClose={() => setModalPagamento(null)}
          pedidoId={modalPagamento.pedidoId}
          valorCentavos={modalPagamento.valorCentavos}
          statusPagamento={modalPagamento.statusPagamento}
          abaInicial={modalPagamento.abaInicial}
          onPagamentoConfirmado={() => {
            carregarPedidos()
          }}
          onComprovanteEnviado={() => {
            const pid = modalPagamento?.pedidoId
            setModalPagamento(null)
            if (pid) {
              setPedidos((prev) =>
                prev.map((p) =>
                  p.id === pid
                    ? {
                        ...p,
                        payment_review: {
                          locked: true,
                          status: 'review',
                          proofId: 'pending',
                          lockedAt: new Date().toISOString(),
                          paymentReviewUnavailable: false,
                        },
                      }
                    : p
                )
              )
            }
            carregarPedidos()
          }}
        />
      )}

      {modalVisualizador.isOpen && (
        <ModalVisualizadorComprovante
          isOpen={modalVisualizador.isOpen}
          onClose={() => setModalVisualizador({ isOpen: false, urlArquivo: null })}
          urlArquivo={modalVisualizador.urlArquivo}
          nomeArquivo={modalVisualizador.nomeArquivo}
          clienteNome={modalVisualizador.clienteNome}
          dataCriacao={modalVisualizador.dataCriacao}
        />
      )}
    </div>
  )
}
