'use client'

import React, { useState, useEffect, useCallback } from 'react'
import Image from 'next/image'
import {
  ShoppingCart,
  Plus,
  Minus,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Clock,
  CreditCard,
  Utensils,
  RefreshCw,
  Search,
  X,
  PackagePlus,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import {
  actionObterCarrinhoAtivo,
  actionAdicionarItemAoCarrinho,
  actionAtualizarQuantidadeItem,
  actionRemoverItemDoCarrinho,
  actionLimparCarrinho,
  actionConverterCarrinhoEmPedido,
} from '@/app/actions/carrinho'
import type { CarrinhoCompleto } from '@/lib/carrinho/service'

interface ProdutoDisponivel {
  id: string
  nome: string
  descricao: string | null
  preco_centavos: number
  url_imagem: string | null
  url_imagem_thumb: string | null
}

interface OperatorCartPanelProps {
  clienteId: string
  clienteNome?: string
  onPedidoConvertido?: (pedidoId: string) => void
}

const HORARIOS_RETIRADA = [
  '11:30',
  '11:45',
  '12:00',
  '12:15',
  '12:30',
  '12:45',
  '13:00',
  '13:15',
]

export default function OperatorCartPanel({
  clienteId,
  clienteNome,
  onPedidoConvertido,
}: OperatorCartPanelProps) {
  const supabase = createClient()
  const [carrinho, setCarrinho] = useState<CarrinhoCompleto | null>(null)
  const [loading, setLoading] = useState(true)
  const [updatingItemId, setUpdatingItemId] = useState<string | null>(null)
  const [addingProdutoId, setAddingProdutoId] = useState<string | null>(null)
  const [converting, setConverting] = useState(false)
  const [horarioRetirada, setHorarioRetirada] = useState<string>('12:00')
  const [meioPagamento, setMeioPagamento] = useState<'pix' | 'cartao_credito' | 'cartao_debito' | 'dinheiro'>('pix')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)

  // Catálogo de produtos para inserção pelo atendente
  const [showCatalogModal, setShowCatalogModal] = useState(false)
  const [produtosDisponiveis, setProdutosDisponiveis] = useState<ProdutoDisponivel[]>([])
  const [searchTerm, setSearchTerm] = useState('')
  const [loadingProdutos, setLoadingProdutos] = useState(false)

  const carregarCarrinho = useCallback(async () => {
    if (!clienteId) return
    setLoading(true)
    setErrorMsg(null)
    try {
      const res = await actionObterCarrinhoAtivo(clienteId)
      if (res.success && res.carrinho) {
        setCarrinho(res.carrinho)
        if (res.carrinho.horario_retirada) {
          setHorarioRetirada(res.carrinho.horario_retirada)
        }
      } else {
        setErrorMsg(res.error || 'Erro ao buscar carrinho ativo.')
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Erro inesperado ao carregar carrinho.')
    } finally {
      setLoading(false)
    }
  }, [clienteId])

  const carregarProdutosDisponiveis = useCallback(async () => {
    setLoadingProdutos(true)
    try {
      const { data, error } = await supabase
        .from('produtos')
        .select('id, nome, descricao, preco_centavos, url_imagem, url_imagem_thumb')
        .eq('ativo', true)
        .order('nome', { ascending: true })

      if (error) {
        console.error('Erro ao buscar produtos:', error)
      } else if (data) {
        setProdutosDisponiveis(data as ProdutoDisponivel[])
      }
    } catch (err) {
      console.error('Falha ao carregar catálogo no painel do operador:', err)
    } finally {
      setLoadingProdutos(false)
    }
  }, [supabase])

  useEffect(() => {
    carregarCarrinho()
  }, [carregarCarrinho])

  useEffect(() => {
    if (showCatalogModal && produtosDisponiveis.length === 0) {
      carregarProdutosDisponiveis()
    }
  }, [showCatalogModal, produtosDisponiveis.length, carregarProdutosDisponiveis])

  const handleAdicionarProduto = async (produto: ProdutoDisponivel) => {
    if (!clienteId) return
    setAddingProdutoId(produto.id)
    setErrorMsg(null)
    setSuccessMsg(null)

    try {
      const res = await actionAdicionarItemAoCarrinho({
        clienteId,
        produtoId: produto.id,
        quantidade: 1,
      })

      if (res.success && res.carrinho) {
        setCarrinho(res.carrinho)
        setSuccessMsg(`Adicionado: ${produto.nome}`)
        setTimeout(() => setSuccessMsg(null), 2500)
      } else {
        setErrorMsg(res.error || 'Erro ao adicionar item ao carrinho.')
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Erro ao adicionar item.')
    } finally {
      setAddingProdutoId(null)
    }
  }

  const handleAlterarQuantidade = async (produtoId: string, novaQuantidade: number) => {
    if (!clienteId) return
    setUpdatingItemId(produtoId)
    setErrorMsg(null)
    setSuccessMsg(null)
    try {
      const res = await actionAtualizarQuantidadeItem({
        clienteId,
        produtoId,
        quantidade: novaQuantidade,
      })
      if (res.success && res.carrinho) {
        setCarrinho(res.carrinho)
      } else {
        setErrorMsg(res.error || 'Falha ao atualizar quantidade.')
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Erro ao alterar quantidade.')
    } finally {
      setUpdatingItemId(null)
    }
  }

  const handleRemoverItem = async (produtoId: string) => {
    if (!clienteId) return
    setUpdatingItemId(produtoId)
    setErrorMsg(null)
    try {
      const res = await actionRemoverItemDoCarrinho({
        clienteId,
        produtoId,
      })
      if (res.success && res.carrinho) {
        setCarrinho(res.carrinho)
      } else {
        setErrorMsg(res.error || 'Falha ao remover item.')
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Erro ao remover item.')
    } finally {
      setUpdatingItemId(null)
    }
  }

  const handleLimparCarrinho = async () => {
    if (!clienteId) return
    if (!confirm('Deseja realmente esvaziar todo o carrinho deste cliente?')) return
    setLoading(true)
    setErrorMsg(null)
    try {
      const res = await actionLimparCarrinho(clienteId)
      if (res.success && res.carrinho) {
        setCarrinho(res.carrinho)
        setSuccessMsg('Carrinho esvaziado.')
      } else {
        setErrorMsg(res.error || 'Falha ao limpar carrinho.')
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Erro ao limpar carrinho.')
    } finally {
      setLoading(false)
    }
  }

  const handleConverterEmPedido = async () => {
    if (!carrinho || !carrinho.itens_carrinho || carrinho.itens_carrinho.length === 0) {
      setErrorMsg('Não é possível converter um carrinho vazio.')
      return
    }

    setConverting(true)
    setErrorMsg(null)
    setSuccessMsg(null)

    try {
      const res = await actionConverterCarrinhoEmPedido({
        carrinhoId: carrinho.id,
        meioPagamento,
        horarioRetirada,
      })

      if (res.success && res.pedidoId) {
        setSuccessMsg(`✅ Pedido confirmado com sucesso! (ID: ${res.pedidoId.substring(0, 8)})`)
        if (onPedidoConvertido) {
          onPedidoConvertido(res.pedidoId)
        }
        await carregarCarrinho()
      } else {
        setErrorMsg(res.error || 'Erro ao converter carrinho em pedido.')
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Erro inesperado na conversão do pedido.')
    } finally {
      setConverting(false)
    }
  }

  const formatarMoeda = (centavos: number) => {
    return (centavos / 100).toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    })
  }

  const itens = carrinho?.itens_carrinho || []
  const totalItens = itens.reduce((acc, i) => acc + i.quantidade, 0)

  const produtosFiltrados = produtosDisponiveis.filter((p) =>
    p.nome.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (p.descricao && p.descricao.toLowerCase().includes(searchTerm.toLowerCase()))
  )

  return (
    <div className="flex h-full flex-col bg-zinc-950 text-zinc-100">
      {/* Barra superior de status do carrinho */}
      <div className="flex items-center justify-between border-b border-amber-500/20 bg-gradient-to-r from-amber-500/10 via-zinc-900/70 to-zinc-900/40 px-4 py-3 shrink-0">
        <div className="flex items-center gap-2">
          <ShoppingCart className="h-4 w-4 text-amber-500" />
          <div>
            <span className="block text-xs font-bold uppercase tracking-wider text-zinc-100">
              Carrinho Aberto ({totalItens})
            </span>
            <span className="block max-w-[13rem] truncate text-[10px] text-zinc-500">
              Pedido de {clienteNome || 'cliente selecionado'}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowCatalogModal(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 bg-amber-500 hover:bg-amber-400 text-zinc-950 rounded-lg text-xs font-bold transition-all shadow-xs cursor-pointer select-none active:scale-95"
            title="Adicionar itens ao carrinho do cliente"
          >
            <Plus className="h-3.5 w-3.5 stroke-[3]" />
            <span>Adicionar Item</span>
          </button>
          <button
            type="button"
            onClick={carregarCarrinho}
            disabled={loading}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors focus:outline-none cursor-pointer"
            title="Atualizar carrinho"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Conteúdo rolável */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {loading && !carrinho ? (
          <div className="flex flex-col items-center justify-center p-8 text-zinc-500">
            <Loader2 className="h-6 w-6 animate-spin mb-2 text-amber-500" />
            <p className="text-xs">Carregando carrinho ativo...</p>
          </div>
        ) : itens.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-800 bg-zinc-900/20 p-6 text-center text-zinc-500">
            <Utensils className="h-8 w-8 mb-2 stroke-zinc-700" />
            <p className="text-xs font-medium text-zinc-400">Carrinho Vazio</p>
            <p className="text-[11px] text-zinc-600 mt-1 max-w-[220px]">
              Os itens adicionados pelo cliente no WhatsApp ou no aplicativo web aparecerão aqui em tempo real. Clique em &quot;Adicionar Item&quot; para incluir produtos.
            </p>
            <button
              type="button"
              onClick={() => setShowCatalogModal(true)}
              className="mt-3 flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-amber-400 text-xs font-semibold rounded-lg transition-all cursor-pointer"
            >
              <PackagePlus className="h-4 w-4" />
              <span>Abrir Catálogo de Assados</span>
            </button>
          </div>
        ) : (
          <div className="space-y-2.5">
            {itens.map((item) => {
              const prod = item.produtos
              const isUpdating = updatingItemId === item.produto_id

              return (
                <div
                  key={item.id}
                  className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5 transition-all hover:border-zinc-700/80"
                >
                  {/* Miniatura do produto */}
                  <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-md bg-zinc-800 border border-zinc-700/50">
                    {prod?.url_imagem ? (
                      <Image
                        src={prod.url_imagem}
                        alt={prod.nome || 'Produto'}
                        fill
                        className="object-cover"
                        sizes="48px"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-zinc-600">
                        <Utensils className="h-5 w-5" />
                      </div>
                    )}
                  </div>

                  {/* Detalhes do item */}
                  <div className="flex-1 min-w-0">
                    <h4 className="text-xs font-medium text-zinc-200 truncate" title={prod?.nome}>
                      {prod?.nome || 'Item do Cardápio'}
                    </h4>
                    <div className="text-[11px] text-amber-400 font-mono mt-0.5">
                      {formatarMoeda(item.preco_unitario_centavos)}
                    </div>
                  </div>

                  {/* Controles de Quantidade */}
                  <div className="flex items-center gap-1.5 shrink-0 bg-zinc-950/80 border border-zinc-800 rounded-md p-1">
                    <button
                      type="button"
                      disabled={isUpdating}
                      onClick={() => handleAlterarQuantidade(item.produto_id, item.quantidade - 1)}
                      className="rounded p-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-50 cursor-pointer"
                      title="Diminuir"
                    >
                      <Minus className="h-3 w-3" />
                    </button>

                    <span className="w-5 text-center text-xs font-semibold text-zinc-100">
                      {item.quantidade}
                    </span>

                    <button
                      type="button"
                      disabled={isUpdating}
                      onClick={() => handleAlterarQuantidade(item.produto_id, item.quantidade + 1)}
                      className="rounded p-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-50 cursor-pointer"
                      title="Aumentar"
                    >
                      <Plus className="h-3 w-3" />
                    </button>
                  </div>

                  {/* Remover Item */}
                  <button
                    type="button"
                    disabled={isUpdating}
                    onClick={() => handleRemoverItem(item.produto_id)}
                    className="p-1 text-zinc-500 hover:text-red-400 transition-colors cursor-pointer shrink-0"
                    title="Remover"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              )
            })}
          </div>
        )}

        {/* Feedback visual de alertas */}
        {errorMsg && (
          <div className="flex items-start gap-2 rounded-lg bg-red-950/40 border border-red-800/60 p-2.5 text-xs text-red-300">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-red-400" />
            <span>{errorMsg}</span>
          </div>
        )}

        {successMsg && (
          <div className="flex items-start gap-2 rounded-lg bg-emerald-950/40 border border-emerald-800/60 p-2.5 text-xs text-emerald-300">
            <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5 text-emerald-400" />
            <span>{successMsg}</span>
          </div>
        )}

        {/* Seção de Resumo Financeiro e Parâmetros de Pedido */}
        {carrinho && itens.length > 0 && (
          <div className="space-y-4 rounded-xl border border-amber-500/20 bg-gradient-to-b from-amber-500/5 to-zinc-900/40 p-3.5 shadow-lg shadow-black/10">
            {/* Totais */}
            <div className="space-y-1.5 text-xs border-b border-zinc-800/60 pb-3">
              <div className="flex justify-between text-zinc-400">
                <span>Subtotal:</span>
                <span className="font-mono text-zinc-200">{formatarMoeda(carrinho.subtotal_centavos)}</span>
              </div>
              {carrinho.desconto_centavos > 0 && (
                <div className="flex justify-between text-emerald-400">
                  <span>Desconto:</span>
                  <span className="font-mono">-{formatarMoeda(carrinho.desconto_centavos)}</span>
                </div>
              )}
              {carrinho.taxa_entrega_centavos > 0 && (
                <div className="flex justify-between text-zinc-400">
                  <span>Taxa de Entrega:</span>
                  <span className="font-mono text-zinc-200">+{formatarMoeda(carrinho.taxa_entrega_centavos)}</span>
                </div>
              )}
              <div className="flex items-end justify-between pt-2">
                <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-400">Total do pedido</span>
                <span className="font-mono text-xl font-black text-amber-400">{formatarMoeda(carrinho.total_centavos)}</span>
              </div>
            </div>

            {/* Parâmetros: Horário e Pagamento */}
            <div className="space-y-3 pt-1">
              <div>
                <label className="block text-[11px] font-medium text-zinc-400 mb-1 flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5 text-amber-500" />
                  <span>Janela de Retirada (Domingo):</span>
                </label>
                <select
                  value={horarioRetirada}
                  onChange={(e) => setHorarioRetirada(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 focus:border-amber-500 focus:outline-none"
                >
                  {HORARIOS_RETIRADA.map((h) => (
                    <option key={h} value={h}>
                      {h} (Balcão de Retirada)
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-zinc-400 mb-1 flex items-center gap-1.5">
                  <CreditCard className="h-3.5 w-3.5 text-amber-500" />
                  <span>Meio de Pagamento:</span>
                </label>
                <select
                  value={meioPagamento}
                  onChange={(e) => setMeioPagamento(e.target.value as any)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 focus:border-amber-500 focus:outline-none"
                >
                  <option value="pix">PIX (Chave / QR Code)</option>
                  <option value="cartao_credito">Cartão de Crédito</option>
                  <option value="cartao_debito">Cartão de Débito</option>
                  <option value="dinheiro">Dinheiro no Balcão</option>
                </select>
              </div>
            </div>

            {/* Botões de Ação */}
            <div className="space-y-2 pt-2 border-t border-zinc-800">
              <button
                type="button"
                disabled={converting}
                onClick={handleConverterEmPedido}
                className="w-full flex items-center justify-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 px-3 py-2.5 text-xs font-bold text-white shadow-md shadow-emerald-900/30 transition-all cursor-pointer select-none active:scale-98 disabled:opacity-50"
              >
                {converting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Reservando Estoque...</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-4 w-4" />
                    <span>Converter em Pedido Oficial</span>
                  </>
                )}
              </button>

              <button
                type="button"
                disabled={loading || converting}
                onClick={handleLimparCarrinho}
                className="w-full rounded-lg border border-zinc-800 hover:bg-zinc-900 px-3 py-1.5 text-[11px] font-medium text-zinc-400 hover:text-red-400 transition-colors cursor-pointer select-none"
              >
                Esvaziar Carrinho
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Modal / Gaveta de Catálogo para Inserção de Produtos */}
      {showCatalogModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs animate-in fade-in duration-200">
          <div className="w-full max-w-lg bg-zinc-950 border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
            {/* Header do modal */}
            <div className="flex items-center justify-between border-b border-zinc-800 p-4 bg-zinc-900/40">
              <div className="flex items-center gap-2">
                <PackagePlus className="h-5 w-5 text-amber-500" />
                <h3 className="text-sm font-bold text-zinc-100">Adicionar Produtos ao Carrinho</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowCatalogModal(false)}
                className="p-1 text-zinc-400 hover:text-zinc-100 rounded-lg hover:bg-zinc-800 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Campo de Busca */}
            <div className="p-3 border-b border-zinc-800/80 bg-zinc-900/20">
              <div className="relative flex items-center">
                <Search className="absolute left-3 h-4 w-4 text-zinc-500" />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Buscar combo ou assado..."
                  className="w-full pl-9 pr-4 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-xs text-zinc-200 placeholder-zinc-500 focus:border-amber-500 focus:outline-hidden"
                />
              </div>
            </div>

            {/* Lista de Produtos */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {loadingProdutos ? (
                <div className="flex flex-col items-center justify-center py-12 text-zinc-500">
                  <Loader2 className="h-6 w-6 animate-spin text-amber-500 mb-2" />
                  <span className="text-xs">Carregando catálogo oficial...</span>
                </div>
              ) : produtosFiltrados.length === 0 ? (
                <div className="text-center py-10 text-zinc-500">
                  <p className="text-xs">Nenhum produto encontrado com &quot;{searchTerm}&quot;.</p>
                </div>
              ) : (
                produtosFiltrados.map((p) => {
                  const isAdding = addingProdutoId === p.id

                  return (
                    <div
                      key={p.id}
                      className="flex items-center justify-between gap-3 p-3 rounded-xl border border-zinc-800/80 bg-zinc-900/40 hover:bg-zinc-900/70 hover:border-zinc-700 transition-all"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-zinc-800 border border-zinc-700/50">
                          {p.url_imagem_thumb || p.url_imagem ? (
                            <Image
                              src={p.url_imagem_thumb || p.url_imagem || ''}
                              alt={p.nome}
                              fill
                              className="object-cover"
                              sizes="48px"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-zinc-600">
                              <Utensils className="h-5 w-5" />
                            </div>
                          )}
                        </div>

                        <div className="min-w-0">
                          <h4 className="text-xs font-bold text-zinc-200 truncate">{p.nome}</h4>
                          <p className="text-[11px] text-zinc-500 line-clamp-1 mt-0.5">
                            {p.descricao || 'Assado tradicional'}
                          </p>
                          <span className="text-xs font-extrabold text-amber-400 font-mono mt-1 block">
                            {formatarMoeda(p.preco_centavos)}
                          </span>
                        </div>
                      </div>

                      <button
                        type="button"
                        disabled={isAdding}
                        onClick={() => handleAdicionarProduto(p)}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-zinc-950 rounded-lg text-xs font-bold transition-all shadow-xs cursor-pointer select-none active:scale-95 shrink-0 disabled:opacity-50"
                      >
                        {isAdding ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Plus className="h-3.5 w-3.5 stroke-[3]" />
                        )}
                        <span>{isAdding ? 'Adicionando...' : 'Adicionar'}</span>
                      </button>
                    </div>
                  )
                })
              )}
            </div>

            {/* Rodapé do modal */}
            <div className="p-3 border-t border-zinc-800 bg-zinc-900/40 flex justify-end">
              <button
                type="button"
                onClick={() => setShowCatalogModal(false)}
                className="px-4 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-xs font-medium transition-colors"
              >
                Concluir
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
