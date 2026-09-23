'use client'

import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  Package,
  Clock,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Loader2,
  ChevronDown,
  ChevronUp,
  Edit3,
  Plus,
  Minus,
  Trash2,
  Check,
  Sparkles,
} from 'lucide-react'
import { getOrderContinuation, type OrderAction } from '@/components/operator/orderContinuation'
import {
  actionListarPedidos,
  actionAtualizarStatusPedido,
  actionAtualizarStatusPagamento,
  actionEditarItensPedidoOperador,
  gerarCobrancaPixPedido,
} from '@/app/actions/pedidos'
import ModalCobrancaPix, { DadosPixModal } from '@/components/operator/ModalCobrancaPix'
import { actionListarCatalogoProdutos } from '@/app/actions/produtos'
import { createClient } from '@/lib/supabase/client'

interface PedidoItem {
  id: string
  quantidade: number
  preco_unitario_centavos: number
  preco_total_centavos: number
  produtos?: {
    id: string
    nome: string
    preco_centavos: number
  } | null
}

interface Pedido {
  id: string
  status: 'novo' | 'confirmado' | 'entregue' | 'cancelado'
  tipo_entrega: 'entrega' | 'retirada'
  endereco_entrega?: string | null
  taxa_entrega_centavos: number
  total_produtos_centavos: number
  total_pedido_centavos: number
  status_pagamento: 'pendente' | 'aprovado' | 'rejeitado' | 'reembolsado'
  meio_pagamento: 'pix' | 'cartao_credito' | 'cartao_debito' | 'dinheiro'
  mercado_pago_preferencia_id?: string | null
  data_criacao: string
  data_atualizacao: string
  itens?: PedidoItem[]
}

interface ItemEdicao {
  produto_id: string
  nome: string
  quantidade: number
  preco_unitario_centavos: number
}

interface OperatorClientOrdersListProps {
  clienteId: string
  clienteNome: string
}

function formatarMoeda(centavos: number): string {
  return (centavos / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })
}

function formatarData(dataIso: string): string {
  try {
    const d = new Date(dataIso)
    return d.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return dataIso
  }
}

export default function OperatorClientOrdersList({
  clienteId,
  clienteNome,
}: OperatorClientOrdersListProps) {
  const [pedidos, setPedidos] = useState<Pedido[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null)
  const [modalPixPedido, setModalPixPedido] = useState<{
    id: string
    clienteNome: string
    dadosPix: DadosPixModal
    statusPagamento: string
  } | null>(null)
  const [expandedPedidoId, setExpandedPedidoId] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const paymentAttemptKeys = useRef(new Map<string, string>())

  // Estado para Edição de Pedido em Atendimento
  const [editingPedidoId, setEditingPedidoId] = useState<string | null>(null)
  const [editedItens, setEditedItens] = useState<ItemEdicao[]>([])
  const [catalogoProdutos, setCatalogoProdutos] = useState<Array<{ id: string; nome: string; preco_centavos: number }>>([])
  const [produtoSelecionadoParaAdicionar, setProdutoSelecionadoParaAdicionar] = useState<string>('')
  const [salvandoEdicao, setSalvandoEdicao] = useState(false)
  const supabase = createClient()

  const carregarPedidos = useCallback(async (isSilent = false) => {
    if (!isSilent) setLoading(true)
    else setRefreshing(true)
    setErrorMsg(null)

    try {
      const res = await actionListarPedidos({ clienteId, limite: 20 })
      if (res.success && res.data) {
        setPedidos(res.data as unknown as Pedido[])
      } else {
        setErrorMsg((res as any).error || 'Erro ao carregar histórico de pedidos.')
      }
    } catch (err: any) {
      console.error('Erro ao listar pedidos do cliente:', err)
      setErrorMsg('Erro inesperado ao consultar pedidos.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [clienteId])

  useEffect(() => {
    carregarPedidos()

    const handleOrderUpdated = () => {
      carregarPedidos(true)
    }
    window.addEventListener('crm:order-updated', handleOrderUpdated)
    window.addEventListener('asados:order-updated', handleOrderUpdated)

    const channel = supabase
      .channel(`operator-client-orders-${clienteId || 'all'}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'pedidos',
          filter: clienteId ? `cliente_id=eq.${clienteId}` : undefined,
        },
        () => {
          carregarPedidos(true)
        }
      )
      .subscribe()

    return () => {
      window.removeEventListener('crm:order-updated', handleOrderUpdated)
      window.removeEventListener('asados:order-updated', handleOrderUpdated)
      supabase.removeChannel(channel)
    }
  }, [carregarPedidos, clienteId, supabase])

  // Iniciar modo de edição de componentes do pedido
  const handleIniciarEdicao = async (pedido: Pedido) => {
    setEditingPedidoId(pedido.id)
    setExpandedPedidoId(pedido.id)
    setErrorMsg(null)

    const itensFormatados: ItemEdicao[] = (pedido.itens || []).map((it) => ({
      produto_id: it.produtos?.id || (it as any).produto_id,
      nome: it.produtos?.nome || 'Produto',
      quantidade: it.quantidade,
      preco_unitario_centavos: it.preco_unitario_centavos,
    }))
    setEditedItens(itensFormatados)

    if (catalogoProdutos.length === 0) {
      try {
        const res = await actionListarCatalogoProdutos()
        if (res.success && res.data) {
          setCatalogoProdutos(res.data)
        }
      } catch (e) {
        console.error('Erro ao carregar catálogo para edição:', e)
      }
    }
  }

  const handleCancelarEdicao = () => {
    setEditingPedidoId(null)
    setEditedItens([])
    setProdutoSelecionadoParaAdicionar('')
  }

  const handleAlterarQuantidadeEdicao = (produtoId: string, delta: number) => {
    setEditedItens((prev) =>
      prev
        .map((it) => {
          if (it.produto_id === produtoId) {
            const novaQtd = it.quantidade + delta
            return novaQtd > 0 ? { ...it, quantidade: novaQtd } : null
          }
          return it
        })
        .filter(Boolean) as ItemEdicao[]
    )
  }

  const handleRemoverItemEdicao = (produtoId: string) => {
    setEditedItens((prev) => prev.filter((it) => it.produto_id !== produtoId))
  }

  const handleAdicionarProdutoEdicao = () => {
    if (!produtoSelecionadoParaAdicionar) return
    const prod = catalogoProdutos.find((p) => p.id === produtoSelecionadoParaAdicionar)
    if (!prod) return

    setEditedItens((prev) => {
      const existe = prev.find((it) => it.produto_id === prod.id)
      if (existe) {
        return prev.map((it) =>
          it.produto_id === prod.id ? { ...it, quantidade: it.quantidade + 1 } : it
        )
      }
      return [
        ...prev,
        {
          produto_id: prod.id,
          nome: prod.nome,
          quantidade: 1,
          preco_unitario_centavos: prod.preco_centavos,
        },
      ]
    })
    setProdutoSelecionadoParaAdicionar('')
  }

  const handleSalvarEdicao = async (pedido: Pedido) => {
    if (editedItens.length === 0) {
      setErrorMsg('O pedido deve conter pelo menos 1 item.')
      return
    }

    setSalvandoEdicao(true)
    setErrorMsg(null)
    try {
      const res = await actionEditarItensPedidoOperador({
        pedidoId: pedido.id,
        itens: editedItens.map((it) => ({
          produto_id: it.produto_id,
          quantidade: it.quantidade,
          preco_unitario_centavos: it.preco_unitario_centavos,
        })),
        notificarCliente: true,
      })

      if (res.success) {
        setSuccessMsg('Pedido atualizado com sucesso! O cliente foi notificado em tempo real.')
        setEditingPedidoId(null)
        setEditedItens([])
        await carregarPedidos(true)
        setTimeout(() => setSuccessMsg(null), 4000)
      } else {
        setErrorMsg(res.error || 'Erro ao salvar alterações no pedido.')
      }
    } catch (err: any) {
      console.error('Erro ao salvar edição:', err)
      setErrorMsg('Erro inesperado ao salvar pedido.')
    } finally {
      setSalvandoEdicao(false)
    }
  }

  const handleAtualizarStatus = async (pedidoId: string, novoStatus: 'confirmado' | 'entregue') => {
    setActionLoadingId(pedidoId)
    setErrorMsg(null)
    setSuccessMsg(null)

    try {
      const res = await actionAtualizarStatusPedido({
        pedidoId,
        novoStatus,
      })

      if (res.success) {
        setSuccessMsg(novoStatus === 'entregue' ? 'Pedido marcado como entregue.' : 'Pedido confirmado com sucesso.')
        await carregarPedidos(true)
        setTimeout(() => setSuccessMsg(null), 3000)
      } else {
        setErrorMsg((res as any).error || 'Erro ao atualizar status do pedido.')
      }
    } catch (err: any) {
      console.error('Erro ao marcar entregue:', err)
      setErrorMsg('Erro ao atualizar pedido.')
    } finally {
      setActionLoadingId(null)
    }
  }

  const handleCancelarPedido = async (pedidoId: string) => {
    if (!confirm('Deseja realmente cancelar este pedido? O estoque dos produtos será restaurado automaticamente.')) {
      return
    }

    setActionLoadingId(pedidoId)
    setErrorMsg(null)
    setSuccessMsg(null)

    try {
      const res = await actionAtualizarStatusPedido({
        pedidoId,
        novoStatus: 'cancelado',
      })

      if (res.success) {
        setSuccessMsg('Pedido cancelado e estoque restaurado!')
        await carregarPedidos(true)
        setTimeout(() => setSuccessMsg(null), 3000)
      } else {
        setErrorMsg((res as any).error || 'Erro ao cancelar pedido.')
      }
    } catch (err: any) {
      console.error('Erro ao cancelar pedido:', err)
      setErrorMsg('Erro ao cancelar pedido.')
    } finally {
      setActionLoadingId(null)
    }
  }

  const handleAprovarPagamento = async (pedidoId: string) => {
    const reason = window.prompt('Informe o motivo da aprovação manual do pagamento:')?.trim()
    if (!reason) {
      setErrorMsg('Informe o motivo para registrar a aprovação manual.')
      return
    }
    const attempt = `${pedidoId}:aprovado:${reason}`
    const idempotencyKey = paymentAttemptKeys.current.get(attempt) ?? crypto.randomUUID()
    paymentAttemptKeys.current.set(attempt, idempotencyKey)

    setActionLoadingId(pedidoId)
    setErrorMsg(null)
    setSuccessMsg(null)

    try {
      const res = await actionAtualizarStatusPagamento({
        pedidoId,
        statusPagamento: 'aprovado',
        reason,
        idempotencyKey,
      })

      if (res.success) {
        paymentAttemptKeys.current.delete(attempt)
        setSuccessMsg('Pagamento marcado como Aprovado!')
        await carregarPedidos(true)
        setTimeout(() => setSuccessMsg(null), 3000)
      } else {
        setErrorMsg(res.error || 'Erro ao aprovar pagamento.')
      }
    } catch (err: any) {
      console.error('Erro ao aprovar pagamento:', err)
      setErrorMsg('Erro ao aprovar pagamento.')
    } finally {
      setActionLoadingId(null)
    }
  }

  const handleOrderAction = async (pedidoId: string, action: OrderAction) => {
    if (action === 'confirmar') return handleAtualizarStatus(pedidoId, 'confirmado')
    if (action === 'entregar') return handleAtualizarStatus(pedidoId, 'entregue')
    if (action === 'cancelar') return handleCancelarPedido(pedidoId)
    if (action === 'aprovar_pagamento') return handleAprovarPagamento(pedidoId)
    return handleGerarLinkPagamento(pedidoId)
  }

  const handleGerarLinkPagamento = async (pedidoId: string) => {
    setActionLoadingId(pedidoId)
    setErrorMsg(null)

    try {
      const pedido = pedidos.find((p) => p.id === pedidoId)
      const res = await gerarCobrancaPixPedido(pedidoId)
      if (res.success && res.pix) {
        setModalPixPedido({
          id: pedidoId,
          clienteNome: clienteNome || 'Cliente',
          dadosPix: res.pix,
          statusPagamento: pedido?.status_pagamento || 'pendente',
        })
      } else {
        setErrorMsg((res as any).error || 'Erro ao gerar cobrança PIX.')
      }
    } catch (err: any) {
      console.error('Erro ao gerar cobrança PIX:', err)
      setErrorMsg('Erro ao gerar cobrança PIX.')
    } finally {
      setActionLoadingId(null)
    }
  }

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-zinc-500">
        <Loader2 className="h-6 w-6 animate-spin text-amber-500 mb-2" />
        <p className="text-xs">Carregando pedidos de {clienteNome}...</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-zinc-950 text-zinc-100 overflow-hidden">
      {/* Cabeçalho */}
      <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/40 px-4 py-3 shrink-0">
        <div className="flex items-center gap-2">
          <Package className="h-4 w-4 text-amber-500" />
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-200">
            Pedidos Realizados ({pedidos.length})
          </span>
        </div>
        <button
          type="button"
          disabled={refreshing}
          onClick={() => carregarPedidos(true)}
          className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors focus:outline-none cursor-pointer"
          title="Atualizar lista de pedidos"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin text-amber-500' : ''}`} />
        </button>
      </div>

      {/* Alertas */}
      {errorMsg && (
        <div className="mx-4 mt-3 flex items-center gap-2 rounded-lg bg-red-950/40 border border-red-900/50 p-2.5 text-xs text-red-200 shrink-0">
          <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
          <span className="flex-1">{errorMsg}</span>
        </div>
      )}

      {successMsg && (
        <div className="mx-4 mt-3 flex items-center gap-2 rounded-lg bg-emerald-950/40 border border-emerald-900/50 p-2.5 text-xs text-emerald-200 shrink-0">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
          <span className="flex-1">{successMsg}</span>
        </div>
      )}

      {/* Lista de Pedidos */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {pedidos.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-800 bg-zinc-900/20 p-8 text-center text-zinc-500">
            <Package className="h-8 w-8 mb-2 stroke-zinc-700" />
            <p className="text-xs font-medium text-zinc-400">Nenhum Pedido Concluído</p>
            <p className="text-[11px] text-zinc-600 mt-1 max-w-[220px]">
              Os pedidos confirmados e convertidos do carrinho para este cliente aparecerão aqui.
            </p>
          </div>
        ) : (
          pedidos.map((pedido) => {
            const isExpanded = expandedPedidoId === pedido.id
            const isEditing = editingPedidoId === pedido.id
            const isCurrentAction = actionLoadingId === pedido.id
            const isPodeEditar = pedido.status === 'novo' || pedido.status === 'confirmado'

            const statusColors: Record<string, string> = {
              novo: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
              confirmado: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
              entregue: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
              cancelado: 'bg-red-500/10 text-red-400 border-red-500/20',
            }

            const statusLabels: Record<string, string> = {
              novo: 'Recebido',
              confirmado: 'Confirmado / Em Preparo',
              entregue: 'Entregue / Concluído',
              cancelado: 'Cancelado',
            }

            const pagamentoColors: Record<string, string> = {
              pendente: 'text-amber-400',
              aprovado: 'text-emerald-400',
              rejeitado: 'text-red-400',
              reembolsado: 'text-zinc-400',
            }

            const pagamentoLabels: Record<string, string> = {
              pendente: 'Pagamento Pendente',
              aprovado: 'Pago & Aprovado',
              rejeitado: 'Pagamento Rejeitado',
              reembolsado: 'Reembolsado',
            }

            // Recálculo em tempo real no card durante a edição
            const totalItensEdicaoCentavos = isEditing
              ? editedItens.reduce((acc, it) => acc + it.preco_unitario_centavos * it.quantidade, 0)
              : pedido.total_produtos_centavos
            const totalFinalExibicao = isEditing
              ? totalItensEdicaoCentavos + (pedido.taxa_entrega_centavos || 0)
              : pedido.total_pedido_centavos

            return (
              <div
                key={pedido.id}
                className={`rounded-xl border transition-all ${
                  isEditing
                    ? 'border-amber-500/60 bg-zinc-900/90 ring-1 ring-amber-500/40 shadow-lg'
                    : pedido.status === 'cancelado'
                    ? 'border-zinc-800/60 bg-zinc-950/40 opacity-75'
                    : pedido.status === 'entregue'
                    ? 'border-emerald-950 bg-emerald-950/10'
                    : 'border-zinc-800 bg-zinc-900/30 hover:border-zinc-700'
                }`}
              >
                {/* Cabeçalho do Card */}
                <div className="p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div
                        className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-lg bg-amber-500/15 border border-amber-500/40 shadow-sm"
                        title="Identificador do Pedido"
                      >
                        <span className="text-[9px] font-black uppercase tracking-wider text-amber-500">
                          PEDIDO
                        </span>
                        <span className="font-mono text-xs font-black tracking-tight text-amber-300 select-all">
                          #{pedido.id.substring(0, 8).toUpperCase()}
                        </span>
                      </div>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-bold border uppercase tracking-wider ${
                          statusColors[pedido.status] || 'bg-zinc-800 text-zinc-400 border-zinc-700'
                        }`}
                      >
                        {statusLabels[pedido.status] || pedido.status}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      {isPodeEditar && !isEditing && (
                        <button
                          type="button"
                          onClick={() => handleIniciarEdicao(pedido)}
                          className="flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-amber-400 hover:text-amber-300 text-[10px] font-bold border border-zinc-700 transition-all cursor-pointer"
                          title="Editar componentes e itens do pedido"
                        >
                          <Edit3 className="h-3 w-3" />
                          <span>Editar Itens</span>
                        </button>
                      )}

                      <span className="text-[10px] text-zinc-500 flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {formatarData(pedido.data_criacao)}
                      </span>
                    </div>
                  </div>

                  {/* Detalhes de Pagamento e Total */}
                  <div className="flex items-center justify-between pt-1 border-t border-zinc-800/60 text-xs">
                    <div>
                      <div className="text-[10px] text-zinc-500 capitalize">
                        {pedido.meio_pagamento.replace('_', ' ')} • {pedido.tipo_entrega}
                      </div>
                      <div className={`text-[11px] font-medium ${pagamentoColors[pedido.status_pagamento]}`}>
                        {pagamentoLabels[pedido.status_pagamento]}
                      </div>
                    </div>
                    <div className="text-right">
                      {isEditing && (
                        <span className="text-[10px] text-amber-400 font-semibold block animate-pulse">
                          Recalculando ao vivo
                        </span>
                      )}
                      <span className="text-sm font-bold font-mono text-amber-400">
                        {formatarMoeda(totalFinalExibicao)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Painel de Edição Interativa dos Itens do Pedido */}
                {isEditing ? (
                  <div className="p-3 border-t border-amber-500/30 bg-zinc-950/60 rounded-b-xl space-y-3 max-w-full overflow-hidden">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-amber-400 flex items-center gap-1.5">
                        <Sparkles className="h-3.5 w-3.5 shrink-0" />
                        <span>Editar Componentes</span>
                      </span>
                      <span className="text-[10px] text-zinc-400 font-mono">
                        {editedItens.length} {editedItens.length === 1 ? 'item' : 'itens'}
                      </span>
                    </div>

                    {/* Lista de Itens em Edição */}
                    <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                      {editedItens.map((item) => (
                        <div
                          key={item.produto_id}
                          className="flex items-center justify-between p-2 rounded-lg bg-zinc-900 border border-zinc-800 text-xs gap-2"
                        >
                          <div className="flex-1 min-w-0">
                            <span className="font-semibold text-zinc-200 block truncate">
                              {item.nome}
                            </span>
                            <span className="text-[10px] text-zinc-400 font-mono">
                              {formatarMoeda(item.preco_unitario_centavos)} un
                            </span>
                          </div>

                          {/* Controles de Quantidade */}
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              onClick={() => handleAlterarQuantidadeEdicao(item.produto_id, -1)}
                              className="p-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors cursor-pointer"
                              title="Diminuir quantidade"
                            >
                              <Minus className="h-3 w-3" />
                            </button>
                            <span className="font-mono font-bold text-amber-400 px-1 min-w-[20px] text-center">
                              {item.quantidade}
                            </span>
                            <button
                              type="button"
                              onClick={() => handleAlterarQuantidadeEdicao(item.produto_id, 1)}
                              className="p-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors cursor-pointer"
                              title="Aumentar quantidade"
                            >
                              <Plus className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRemoverItemEdicao(item.produto_id)}
                              className="p-1 ml-1 rounded bg-red-950/40 hover:bg-red-900/60 text-red-400 hover:text-red-300 transition-colors cursor-pointer"
                              title="Remover item"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </div>

                          <div className="text-right shrink-0 min-w-[60px]">
                            <span className="font-mono font-bold text-zinc-200 text-xs">
                              {formatarMoeda(item.preco_unitario_centavos * item.quantidade)}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Seletor para Adicionar Novos Produtos do Cardápio (Layout vertical sem overflow) */}
                    <div className="pt-2.5 border-t border-zinc-800/80 space-y-2">
                      <label className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 block">
                        Adicionar produto ao pedido:
                      </label>
                      <div className="space-y-2">
                        <select
                          value={produtoSelecionadoParaAdicionar}
                          onChange={(e) => setProdutoSelecionadoParaAdicionar(e.target.value)}
                          className="w-full min-w-0 max-w-full bg-zinc-900 border border-zinc-700 hover:border-zinc-600 focus:border-amber-500 text-zinc-200 text-xs rounded-lg px-2.5 py-2 focus:outline-none transition-colors truncate cursor-pointer"
                        >
                          <option value="">+ Selecione um produto do cardápio...</option>
                          {catalogoProdutos.map((prod) => (
                            <option key={prod.id} value={prod.id}>
                              {prod.nome} — {formatarMoeda(prod.preco_centavos)}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={handleAdicionarProdutoEdicao}
                          disabled={!produtoSelecionadoParaAdicionar}
                          className="w-full flex items-center justify-center gap-1.5 py-2 px-3 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-amber-400 hover:text-amber-300 font-bold rounded-lg text-xs border border-zinc-700/80 transition-all cursor-pointer disabled:cursor-not-allowed shadow-sm"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          <span>Adicionar este Produto ao Pedido</span>
                        </button>
                      </div>
                    </div>

                    {/* Resumo com Recálculo Imediato e Ações */}
                    <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-zinc-400 font-medium">Total Recalculado:</span>
                        <span className="text-sm font-black font-mono text-amber-400">
                          {formatarMoeda(totalFinalExibicao)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 pt-1 border-t border-amber-500/20">
                        <button
                          type="button"
                          onClick={handleCancelarEdicao}
                          disabled={salvandoEdicao}
                          className="flex-1 py-2 px-2.5 rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 text-xs font-semibold transition-colors cursor-pointer text-center"
                        >
                          Cancelar
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSalvarEdicao(pedido)}
                          disabled={salvandoEdicao || editedItens.length === 0}
                          className="flex-2 flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-zinc-950 text-xs font-bold transition-all shadow-md shadow-amber-500/10 active:scale-95 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                        >
                          {salvandoEdicao ? (
                            <>
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              <span>Salvando...</span>
                            </>
                          ) : (
                            <>
                              <Check className="h-3.5 w-3.5" />
                              <span>Salvar e Notificar</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  /* Modo Normal (Visualização dos Itens e Ações) */
                  <div className="px-3 pb-3">
                    <button
                      type="button"
                      onClick={() => setExpandedPedidoId(isExpanded ? null : pedido.id)}
                      className="w-full flex items-center justify-between py-1 px-2 rounded-lg bg-zinc-900/60 hover:bg-zinc-900 text-[11px] text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer select-none"
                    >
                      <span>
                        {pedido.itens?.length || 0} {pedido.itens?.length === 1 ? 'item' : 'itens'} no pedido
                      </span>
                      {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                    </button>

                    {isExpanded && pedido.itens && pedido.itens.length > 0 && (
                      <div className="mt-2 space-y-1.5 pt-1 border-t border-zinc-800/40">
                        {pedido.itens.map((item) => (
                          <div
                            key={item.id}
                            className="flex items-center justify-between text-[11px] py-1 px-1.5 rounded bg-zinc-950/40"
                          >
                            <div className="flex items-center gap-1.5 min-w-0 pr-2">
                              <span className="font-bold text-amber-500 font-mono">
                                {item.quantidade}x
                              </span>
                              <span className="truncate text-zinc-200">
                                {item.produtos?.nome || 'Assado Especial'}
                              </span>
                            </div>
                            <span className="font-mono text-zinc-400 shrink-0">
                              {formatarMoeda(item.preco_total_centavos ?? (item.preco_unitario_centavos * item.quantidade))}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    {(() => {
                      const continuation = getOrderContinuation(pedido)
                      const labels: Record<OrderAction, string> = {
                        confirmar: 'Confirmar pedido',
                        entregar: 'Marcar entregue',
                        cancelar: 'Cancelar pedido',
                        aprovar_pagamento: 'Aprovar pagamento',
                        gerar_pagamento: 'Cobrança PIX',
                      }
                      return (
                        <div className="mt-3 border-t border-zinc-800/60 pt-2" aria-label="Próximas ações do pedido">
                          <p className="mb-2 text-[11px] text-zinc-400" role="status">{continuation.message}</p>
                          {continuation.actions.length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                              {continuation.actions.map((action) => (
                                <button
                                  key={action}
                                  type="button"
                                  disabled={isCurrentAction}
                                  onClick={() => handleOrderAction(pedido.id, action)}
                                  aria-label={labels[action]}
                                  className={
                                    action === 'cancelar'
                                      ? 'rounded-lg border border-zinc-700 px-2 py-1.5 text-[11px] font-bold text-zinc-300 hover:border-red-900 hover:bg-red-950/30 hover:text-red-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 disabled:opacity-50 cursor-pointer'
                                      : 'rounded-lg bg-amber-500 px-2 py-1.5 text-[11px] font-bold text-zinc-950 hover:bg-amber-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 disabled:opacity-50 cursor-pointer'
                                  }
                                >
                                  {isCurrentAction ? <Loader2 className="h-3 w-3 animate-spin" /> : labels[action]}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      {modalPixPedido && (
        <ModalCobrancaPix
          isOpen={!!modalPixPedido}
          onClose={() => setModalPixPedido(null)}
          pedidoId={modalPixPedido.id}
          clienteNome={modalPixPedido.clienteNome}
          dadosPix={modalPixPedido.dadosPix}
          statusPagamento={modalPixPedido.statusPagamento}
        />
      )}
    </div>
  )
}
