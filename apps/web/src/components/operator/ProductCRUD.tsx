'use client'

import React, { useState, useTransition } from 'react'
import { 
  Plus, 
  Search, 
  Edit2, 
  X, 
  Check, 
  Loader2, 
  Utensils, 
  Image as ImageIcon,
  AlertTriangle,
  GripVertical
} from 'lucide-react'
import { 
  criarProduto, 
  atualizarProduto, 
  alternarStatusProduto,
  reordenarProdutosVisiveis
} from '@/app/actions/produtos'

export interface Produto {
  id: string
  nome: string
  descricao: string | null
  preco_centavos: number
  ativo: boolean
  url_imagem: string | null
  ordem_exibicao: number | null
  data_criacao?: string
  data_atualizacao?: string
}

type FiltroAtivo = 'todos' | 'ativos' | 'inativos'

export function isProductReorderingDisabled(busca: string, filtroAtivo: FiltroAtivo) {
  return busca.trim().length > 0 || filtroAtivo !== 'todos'
}

export function buildVisibleProductOrderPayload(produtosVisiveis: Produto[]) {
  return produtosVisiveis.map((produto, index) => ({
    id: produto.id,
    ordem_exibicao: index + 1,
  }))
}

export function reorderProductsByVisibleDrop(
  produtos: Produto[],
  visibleIds: string[],
  draggedId: string,
  targetId: string
) {
  if (draggedId === targetId) return produtos

  const visibleOrder = visibleIds.filter((id) => produtos.some((produto) => produto.id === id))
  const fromIndex = visibleOrder.indexOf(draggedId)
  const toIndex = visibleOrder.indexOf(targetId)

  if (fromIndex === -1 || toIndex === -1) return produtos

  const reorderedVisibleIds = [...visibleOrder]
  const [movedId] = reorderedVisibleIds.splice(fromIndex, 1)
  reorderedVisibleIds.splice(toIndex, 0, movedId)

  const visibleProductsById = new Map(produtos.map((produto) => [produto.id, produto]))
  let visibleCursor = 0

  return produtos.map((produto) => {
    if (!visibleOrder.includes(produto.id)) return produto

    const replacementId = reorderedVisibleIds[visibleCursor++]
    return visibleProductsById.get(replacementId) ?? produto
  })
}

interface ProductCRUDProps {
  produtosIniciais: Produto[]
  perfilFuncao: string
}

export default function ProductCRUD({ produtosIniciais }: ProductCRUDProps) {
  const [produtos, setProdutos] = useState<Produto[]>(produtosIniciais)
  const [busca, setBusca] = useState('')
  const [filtroAtivo, setFiltroAtivo] = useState<FiltroAtivo>('todos')
  const [draggedProdutoId, setDraggedProdutoId] = useState<string | null>(null)
  const [isReorderPending, setIsReorderPending] = useState(false)
  
  // Estados dos Modais
  const [modalAberto, setModalAberto] = useState(false)
  const [produtoEdicao, setProdutoEdicao] = useState<Produto | null>(null)

  // Estado do Formulário
  const [nome, setNome] = useState('')
  const [descricao, setDescricao] = useState('')
  const [precoBrl, setPrecoBrl] = useState('')
  const [urlImagem, setUrlImagem] = useState('')
  const [ativo, setAtivo] = useState(true)

  // Estados de Operação / Loading
  const [isPending, startTransition] = useTransition()
  const [mensagemErro, setMensagemErro] = useState<string | null>(null)
  const [mensagemSucesso, setMensagemSucesso] = useState<string | null>(null)

  // Helper para formatar centavos para BRL
  const formatarCentavosParaBrl = (centavos: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(centavos / 100)
  }

  // Helper para converter string BRL para centavos
  const converterBrlParaCentavos = (valorStr: string): number => {
    const limpo = valorStr.replace(/\s/g, '').replace(/R\$/g, '').replace(/\./g, '').replace(/,/g, '.')
    const parsed = parseFloat(limpo)
    if (isNaN(parsed)) return 0
    return Math.round(parsed * 100)
  }

  // Resetar formulário
  const resetarFormulario = () => {
    setNome('')
    setDescricao('')
    setPrecoBrl('')
    setUrlImagem('')
    setAtivo(true)
    setProdutoEdicao(null)
    setMensagemErro(null)
  }

  // Abrir modal para criação
  const handleNovoProduto = () => {
    resetarFormulario()
    setModalAberto(true)
  }

  // Abrir modal para edição
  const handleEditarProduto = (produto: Produto) => {
    resetarFormulario()
    setProdutoEdicao(produto)
    setNome(produto.nome)
    setDescricao(produto.descricao || '')
    setPrecoBrl((produto.preco_centavos / 100).toFixed(2).replace('.', ','))
    setUrlImagem(produto.url_imagem || '')
    setAtivo(produto.ativo)
    setModalAberto(true)
  }

  // Alternar status ativo/inativo
  const handleAlternarStatus = (produto: Produto) => {
    const novoStatus = !produto.ativo
    startTransition(async () => {
      try {
        const res = await alternarStatusProduto(produto.id, novoStatus)
        if (res.success && res.data) {
          // Atualiza lista local
          setProdutos(prev => 
            prev.map(p => p.id === produto.id ? { ...p, ativo: res.data.ativo } : p)
          )
          exibirMensagemSucesso(`Produto ${novoStatus ? 'ativado' : 'desativado'} com sucesso!`)
        } else {
          setMensagemErro(res.error || 'Erro ao alternar status do produto')
        }
      } catch (err: any) {
        setMensagemErro(err.message || 'Erro inesperado')
      }
    })
  }

  // Submeter formulário
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setMensagemErro(null)

    const precoCentavos = converterBrlParaCentavos(precoBrl)
    if (!nome.trim()) {
      setMensagemErro('O nome do produto é obrigatório')
      return
    }
    if (precoCentavos <= 0 && precoBrl !== '0' && precoBrl !== '0,00') {
      setMensagemErro('Insira um preço válido maior ou igual a zero')
      return
    }

    startTransition(async () => {
      try {
        const payload = {
          nome: nome.trim(),
          descricao: descricao.trim() || null,
          preco_centavos: precoCentavos,
          ativo,
          url_imagem: urlImagem.trim() || null
        }

        let res
        if (produtoEdicao) {
          res = await atualizarProduto(produtoEdicao.id, payload)
        } else {
          res = await criarProduto(payload)
        }

        if (res.success && res.data) {
          const produtoRetornado = res.data as Produto
          if (produtoEdicao) {
            setProdutos(prev => 
              prev.map(p => p.id === produtoEdicao.id ? produtoRetornado : p)
            )
            exibirMensagemSucesso('Produto atualizado com sucesso!')
          } else {
            setProdutos(prev => [produtoRetornado, ...prev])
            exibirMensagemSucesso('Produto cadastrado com sucesso!')
          }
          setModalAberto(false)
          resetarFormulario()
        } else {
          setMensagemErro(res.error || 'Erro ao salvar produto')
        }
      } catch (err: any) {
        setMensagemErro(err.message || 'Erro inesperado ao salvar')
      }
    })
  }

  const exibirMensagemSucesso = (msg: string) => {
    setMensagemSucesso(msg)
    setTimeout(() => {
      setMensagemSucesso(null)
    }, 4000)
  }

  // Filtragem de produtos
  const produtosFiltrados = produtos.filter(produto => {
    const correspondeBusca = 
      produto.nome.toLowerCase().includes(busca.toLowerCase()) || 
      (produto.descricao && produto.descricao.toLowerCase().includes(busca.toLowerCase()))
    
    const correspondeStatus = 
      filtroAtivo === 'todos' || 
      (filtroAtivo === 'ativos' && produto.ativo) || 
      (filtroAtivo === 'inativos' && !produto.ativo)

    return correspondeBusca && correspondeStatus
  })
  const reorderDisabled = isProductReorderingDisabled(busca, filtroAtivo)

  const handleDropProduto = (targetId: string) => {
    if (!draggedProdutoId || reorderDisabled || isReorderPending) return

    const produtosAntes = produtos
    const visibleIds = produtosFiltrados.map((produto) => produto.id)
    const produtosReordenados = reorderProductsByVisibleDrop(produtos, visibleIds, draggedProdutoId, targetId)

    setDraggedProdutoId(null)
    if (produtosReordenados === produtos) return

    const produtosVisiveisReordenados = produtosReordenados.filter((produto) => visibleIds.includes(produto.id))
    const payload = buildVisibleProductOrderPayload(produtosVisiveisReordenados)

    setProdutos(produtosReordenados)
    setMensagemErro(null)
    setIsReorderPending(true)

    reordenarProdutosVisiveis(payload)
      .then((res) => {
        if (res.success) {
          exibirMensagemSucesso('Ordem dos produtos atualizada com sucesso!')
          return
        }

        setProdutos(produtosAntes)
        setMensagemErro(res.error || 'Erro ao reordenar produtos')
      })
      .catch((err: any) => {
        setProdutos(produtosAntes)
        setMensagemErro(err.message || 'Erro inesperado ao reordenar produtos')
      })
      .finally(() => {
        setIsReorderPending(false)
      })
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-zinc-950 font-sans">
      {/* Subcabeçalho de Controles */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-6 border-b border-zinc-800 bg-zinc-900/10 shrink-0">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-zinc-100 flex items-center gap-2">
            <Utensils className="h-5 w-5 text-amber-500" />
            Catálogo de Produtos
          </h1>
          <p className="text-xs text-zinc-400 mt-1">
            Gerencie o cardápio e preços dos produtos disponíveis para pedidos e vendas rápidas.
          </p>
        </div>

        <button
          onClick={handleNovoProduto}
          className="flex items-center justify-center gap-1.5 px-4 py-2 bg-amber-500 hover:bg-amber-600 active:scale-95 text-zinc-950 font-bold rounded-lg text-sm transition-all shadow-md shadow-amber-500/10 hover:shadow-amber-600/20 cursor-pointer select-none"
        >
          <Plus className="h-4 w-4 stroke-[3]" />
          Novo Produto
        </button>
      </div>

      {/* Alertas Temporários */}
      {mensagemSucesso && (
        <div className="mx-6 mt-4 p-3 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 rounded-lg text-sm flex items-center gap-2 animate-fadeIn shrink-0">
          <Check className="h-4 w-4 shrink-0" />
          <span>{mensagemSucesso}</span>
        </div>
      )}

      {mensagemErro && (
        <div className="mx-6 mt-4 p-3 bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg text-sm flex items-center gap-2 animate-fadeIn shrink-0">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{mensagemErro}</span>
        </div>
      )}

      {/* Área de Filtros e Busca */}
      <div className="flex flex-col sm:flex-row items-center gap-4 px-6 py-4 shrink-0 bg-zinc-900/5 border-b border-zinc-900">
        <div className="relative w-full sm:w-80">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
          <input
            type="text"
            placeholder="Buscar por nome ou descrição..."
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            className="w-full pl-9 pr-4 py-2 bg-zinc-900/60 border border-zinc-800 focus:border-amber-500 focus:ring-1 focus:ring-amber-500/30 rounded-lg text-sm text-zinc-100 placeholder-zinc-500 outline-none transition-all"
          />
        </div>

        <div className="flex rounded-lg border border-zinc-800 bg-zinc-900/40 p-0.5 w-full sm:w-auto">
          <button
            onClick={() => setFiltroAtivo('todos')}
            className={`flex-1 sm:flex-none px-3 py-1.5 rounded-md text-xs font-semibold transition-all cursor-pointer ${
              filtroAtivo === 'todos'
                ? 'bg-zinc-800 text-zinc-100 shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Todos
          </button>
          <button
            onClick={() => setFiltroAtivo('ativos')}
            className={`flex-1 sm:flex-none px-3 py-1.5 rounded-md text-xs font-semibold transition-all cursor-pointer ${
              filtroAtivo === 'ativos'
                ? 'bg-zinc-800 text-zinc-100 shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Ativos
          </button>
          <button
            onClick={() => setFiltroAtivo('inativos')}
            className={`flex-1 sm:flex-none px-3 py-1.5 rounded-md text-xs font-semibold transition-all cursor-pointer ${
              filtroAtivo === 'inativos'
                ? 'bg-zinc-800 text-zinc-100 shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Inativos
          </button>
        </div>
      </div>

      <div className="px-6 py-3 border-b border-zinc-900 text-xs text-zinc-400 bg-zinc-950/40">
        {reorderDisabled ? (
          <span className="text-amber-400">
            Ordenação manual pausada enquanto busca ou filtros estão ativos. Limpe os filtros para reordenar a lista completa.
          </span>
        ) : (
          <span>Arraste o indicador de ordem para reorganizar os produtos desta lista administrativa.</span>
        )}
        {isReorderPending && (
          <span className="ml-2 inline-flex items-center gap-1 text-amber-400">
            <Loader2 className="h-3 w-3 animate-spin" />
            Salvando ordem...
          </span>
        )}
      </div>

      {/* Lista de Produtos */}
      <div className="flex-1 overflow-y-auto p-6">
        {produtosFiltrados.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 border border-dashed border-zinc-800 rounded-xl bg-zinc-900/10">
            <Utensils className="h-10 w-10 text-zinc-600 mb-3" />
            <h3 className="text-zinc-400 font-semibold text-sm">Nenhum produto encontrado</h3>
            <p className="text-zinc-500 text-xs mt-1">Crie um novo produto ou altere os critérios de busca.</p>
          </div>
        ) : (
          <div className="border border-zinc-800 rounded-xl overflow-hidden bg-zinc-900/20 backdrop-blur">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900/60 text-zinc-400 text-xs font-bold uppercase tracking-wider">
                  <th className="py-3 px-4 w-14 text-center">Ordem</th>
                  <th className="py-3 px-4 w-16">Imagem</th>
                  <th className="py-3 px-4">Nome / Descrição</th>
                  <th className="py-3 px-4 w-32">Preço</th>
                  <th className="py-3 px-4 w-28 text-center">Status</th>
                  <th className="py-3 px-4 w-24 text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60 text-sm text-zinc-300">
                {produtosFiltrados.map((produto) => (
                  <tr 
                    key={produto.id}
                    data-testid="product-row"
                    draggable={!reorderDisabled && !isReorderPending}
                    onDragOver={(event) => {
                      if (!reorderDisabled && draggedProdutoId) {
                        event.preventDefault()
                      }
                    }}
                    onDrop={() => handleDropProduto(produto.id)}
                    className="hover:bg-zinc-900/30 transition-colors"
                  >
                    <td className="py-4 px-4 align-top text-center">
                      <button
                        type="button"
                        aria-label={`Reordenar produto ${produto.nome}`}
                        disabled={reorderDisabled || isReorderPending}
                        draggable={!reorderDisabled && !isReorderPending}
                        onDragStart={() => setDraggedProdutoId(produto.id)}
                        onDragEnd={() => setDraggedProdutoId(null)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-800 text-zinc-500 hover:text-amber-500 hover:border-amber-500/50 disabled:opacity-40 disabled:cursor-not-allowed cursor-grab active:cursor-grabbing"
                        title={reorderDisabled ? 'Limpe busca e filtros para reordenar' : 'Arraste para reordenar'}
                      >
                        <GripVertical className="h-4 w-4" />
                      </button>
                    </td>
                    <td className="py-4 px-4 align-top">
                      {produto.url_imagem ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={produto.url_imagem}
                          alt={produto.nome}
                          className="h-12 w-12 object-cover rounded-lg border border-zinc-800 bg-zinc-950"
                          onError={(e) => {
                            (e.target as HTMLElement).style.display = 'none'
                          }}
                        />
                      ) : (
                        <div className="h-12 w-12 rounded-lg border border-zinc-800 bg-zinc-950/60 flex items-center justify-center text-zinc-600">
                          <ImageIcon className="h-5 w-5" />
                        </div>
                      )}
                    </td>
                    <td className="py-4 px-4 align-top">
                      <div data-testid="product-name" className="font-semibold text-zinc-100">{produto.nome}</div>
                      {produto.descricao ? (
                        <div className="text-xs text-zinc-400 mt-1 line-clamp-2 max-w-xl">
                          {produto.descricao}
                        </div>
                      ) : (
                        <div className="text-xs text-zinc-500 italic mt-1">Sem descrição cadastrada</div>
                      )}
                    </td>
                    <td className="py-4 px-4 align-top font-mono font-medium text-amber-400/90">
                      {formatarCentavosParaBrl(produto.preco_centavos)}
                    </td>
                    <td className="py-4 px-4 align-top text-center">
                      <button
                        onClick={() => handleAlternarStatus(produto)}
                        disabled={isPending}
                        className="inline-flex items-center gap-1.5 justify-center py-1 px-2.5 rounded-full text-xs font-semibold border transition-all cursor-pointer hover:bg-zinc-800 select-none disabled:opacity-50"
                        title="Clique para alternar o status"
                      >
                        {produto.ativo ? (
                          <>
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                            <span className="text-emerald-400">Ativo</span>
                          </>
                        ) : (
                          <>
                            <span className="h-1.5 w-1.5 rounded-full bg-zinc-500"></span>
                            <span className="text-zinc-500">Inativo</span>
                          </>
                        )}
                      </button>
                    </td>
                    <td className="py-4 px-4 align-top text-right">
                      <button
                        onClick={() => handleEditarProduto(produto)}
                        className="p-2 text-zinc-400 hover:text-amber-500 hover:bg-zinc-800/40 rounded-lg transition-all cursor-pointer select-none"
                        title="Editar produto"
                      >
                        <Edit2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal CRUD (Criar/Editar) */}
      {modalAberto && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-950/80 backdrop-blur-sm animate-fadeIn">
          <div className="w-full max-w-lg bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden shadow-2xl animate-scaleUp">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4 bg-zinc-900/60">
              <h2 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                <Utensils className="h-4.5 w-4.5 text-amber-500" />
                {produtoEdicao ? 'Editar Produto' : 'Cadastrar Novo Produto'}
              </h2>
              <button
                onClick={() => setModalAberto(false)}
                className="p-1 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg transition-all cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Modal Body */}
            <form onSubmit={handleSubmit} className="p-6 flex flex-col gap-4">
              {mensagemErro && (
                <div className="p-3 bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg text-xs flex items-center gap-2 animate-fadeIn">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  <span>{mensagemErro}</span>
                </div>
              )}

              {/* Nome */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider">
                  Nome do Produto <span className="text-amber-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ex: Produto Modelo (unidade)"
                  value={nome}
                  onChange={(e) => setNome(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 focus:border-amber-500 rounded-lg text-sm text-zinc-100 placeholder-zinc-600 outline-none transition-all"
                />
              </div>

              {/* Descrição */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider">
                  Descrição
                </label>
                <textarea
                  placeholder="Ex: Corte nobre com gordura uniforme e maciez excepcional."
                  value={descricao}
                  onChange={(e) => setDescricao(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 focus:border-amber-500 rounded-lg text-sm text-zinc-100 placeholder-zinc-600 outline-none transition-all resize-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* Preço (BRL) */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider">
                    Preço (R$) <span className="text-amber-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="0,00"
                    value={precoBrl}
                    onChange={(e) => setPrecoBrl(e.target.value)}
                    className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 focus:border-amber-500 rounded-lg text-sm font-mono text-zinc-100 placeholder-zinc-600 outline-none transition-all"
                  />
                </div>

                {/* Status Ativo */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider">
                    Status Inicial
                  </label>
                  <button
                    type="button"
                    onClick={() => setAtivo(!ativo)}
                    className="flex items-center gap-2 px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-zinc-300 hover:text-zinc-100 hover:border-zinc-700 transition-all text-left cursor-pointer"
                  >
                    {ativo ? (
                      <>
                        <span className="h-2 w-2 rounded-full bg-emerald-500"></span>
                        <span>Ativo / Disponível</span>
                      </>
                    ) : (
                      <>
                        <span className="h-2 w-2 rounded-full bg-zinc-600"></span>
                        <span>Inativo / Indisponível</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* URL da Imagem */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider">
                  URL da Imagem
                </label>
                <input
                  type="text"
                  placeholder="https://exemplo.com/imagem.jpg"
                  value={urlImagem}
                  onChange={(e) => setUrlImagem(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 focus:border-amber-500 rounded-lg text-sm text-zinc-100 placeholder-zinc-600 outline-none transition-all"
                />
              </div>

              {/* Modal Footer / Actions */}
              <div className="flex items-center justify-end gap-3 mt-4 pt-4 border-t border-zinc-800/80">
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => setModalAberto(false)}
                  className="px-4 py-2 bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-300 font-semibold rounded-lg text-sm transition-all cursor-pointer disabled:opacity-50 select-none"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isPending}
                  className="flex items-center justify-center gap-1.5 px-5 py-2 bg-amber-500 hover:bg-amber-600 active:scale-95 text-zinc-950 font-bold rounded-lg text-sm transition-all shadow-md shadow-amber-500/10 cursor-pointer disabled:opacity-50 select-none"
                >
                  {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  {produtoEdicao ? 'Salvar' : 'Cadastrar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
