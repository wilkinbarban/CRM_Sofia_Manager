'use client'

import React, { useState, useEffect, useRef } from 'react'
import { User, Tag, FileText, MapPin, Plus, X, Save, Loader2, Star, ShoppingCart, Package, Sparkles } from 'lucide-react'
import { atualizarClienteCrm } from '@/app/actions/clientes'
import { Cliente } from './ConversationsQueue'
import OperatorCartPanel from './OperatorCartPanel'
import OperatorClientOrdersList from './OperatorClientOrdersList'
import OperatorClientFactsPanel from './OperatorClientFactsPanel'

interface ClientCrmPanelProps {
  cliente: Cliente | null
  onClienteUpdated?: (clienteId: string, updatedData: Partial<Cliente>) => void
}

type ClientPanelTab = 'carrinho' | 'pedidos' | 'crm' | 'fatos'

export default function ClientCrmPanel({
  cliente,
  onClienteUpdated
}: ClientCrmPanelProps) {
  const [activeTab, setActiveTab] = useState<ClientPanelTab>('carrinho')
  const tabRefs = useRef<Record<ClientPanelTab, HTMLButtonElement | null>>({
    carrinho: null,
    pedidos: null,
    crm: null,
    fatos: null,
  })
  const [endereco, setEndereco] = useState('')
  const [notas, setNotas] = useState('')
  const [score, setScore] = useState(0)
  const [tags, setTags] = useState<string[]>([])
  const [newTag, setNewTag] = useState('')
  const [loading, setLoading] = useState(false)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // Sincroniza o estado interno sempre que o cliente selecionado muda
  useEffect(() => {
    if (cliente) {
      setEndereco(cliente.endereco || '')
      setNotas(cliente.notas || '')
      setScore(cliente.score || 0)
      setTags(cliente.tags || [])
      setNewTag('')
      setSuccessMsg(null)
      setErrorMsg(null)
    }
  }, [cliente])

  if (!cliente) {
    return (
      <div className="flex h-full w-full xl:w-[22rem] 2xl:w-[27rem] flex-col items-center justify-center border-l border-zinc-800 bg-zinc-950/20 text-zinc-500 p-6 text-center">
        <User className="h-12 w-12 mb-3 stroke-zinc-700 animate-pulse" />
        <p className="text-sm">Selecione uma conversa para ver as informações de CRM do cliente</p>
      </div>
    )
  }

  const handleAddTag = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = newTag.trim()
    if (trimmed && !tags.includes(trimmed)) {
      setTags([...tags, trimmed])
      setNewTag('')
    }
  }

  const handleRemoveTag = (tagToRemove: string) => {
    setTags(tags.filter((t) => t !== tagToRemove))
  }

  const handleSave = async () => {
    setLoading(true)
    setSuccessMsg(null)
    setErrorMsg(null)

    try {
      const res = await atualizarClienteCrm(cliente.id, {
        endereco: endereco.trim(),
        notas: notas.trim(),
        score,
        tags
      })

      if (res.success) {
        setSuccessMsg('Alterações salvas com sucesso!')
        if (onClienteUpdated) {
          onClienteUpdated(cliente.id, {
            endereco: endereco.trim(),
            notas: notas.trim(),
            score,
            tags
          })
        }
        // Limpar mensagem de sucesso após 3 segundos
        setTimeout(() => setSuccessMsg(null), 3000)
      } else {
        setErrorMsg(res.error || 'Erro ao salvar alterações.')
      }
    } catch (err: any) {
      console.error('Erro ao salvar CRM:', err)
      setErrorMsg('Erro inesperado ao salvar.')
    } finally {
      setLoading(false)
    }
  }

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, currentTab: ClientPanelTab) => {
    const tabs: ClientPanelTab[] = ['carrinho', 'pedidos', 'crm', 'fatos']
    const currentIndex = tabs.indexOf(currentTab)
    let nextTab: ClientPanelTab | null = null

    if (event.key === 'ArrowRight') nextTab = tabs[(currentIndex + 1) % tabs.length]
    if (event.key === 'ArrowLeft') nextTab = tabs[(currentIndex - 1 + tabs.length) % tabs.length]
    if (event.key === 'Home') nextTab = tabs[0]
    if (event.key === 'End') nextTab = tabs[tabs.length - 1]
    if (!nextTab) return

    event.preventDefault()
    setActiveTab(nextTab)
    tabRefs.current[nextTab]?.focus()
  }

  return (
    <aside className="w-full h-full border-l border-zinc-800 bg-zinc-950 flex flex-col overflow-hidden shadow-2xl shadow-black/20">
      <div className="shrink-0 border-b border-zinc-800 bg-gradient-to-br from-zinc-900 via-zinc-900/95 to-amber-950/20 px-4 py-3.5">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-400">
            <ShoppingCart className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-amber-400">
              Venda em andamento
            </p>
            <div className="flex items-center gap-2"><p className="truncate text-sm font-semibold text-zinc-100">{cliente.nome}</p><span className="rounded-full border border-zinc-700 bg-zinc-950/60 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-zinc-400">Cliente</span></div>
          </div>
        </div>
      </div>

      {/* Carrinho e pedidos formam o fluxo principal; CRM é informação de apoio. */}
      <div
        className="grid grid-cols-[1fr_1fr_auto_auto] gap-1.5 border-b border-zinc-800 bg-zinc-900/60 p-2 shrink-0"
        role="tablist"
        aria-label="Áreas do atendimento ao cliente"
      >
        <button
          type="button"
          onClick={() => setActiveTab('carrinho')}
          onKeyDown={(event) => handleTabKeyDown(event, 'carrinho')}
          ref={(element) => { tabRefs.current.carrinho = element }}
          role="tab"
          aria-selected={activeTab === 'carrinho'}
          tabIndex={activeTab === 'carrinho' ? 0 : -1}
          className={`flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 text-xs font-bold transition-all cursor-pointer ${
            activeTab === 'carrinho'
              ? 'border border-amber-400 bg-amber-500 text-zinc-950 shadow-lg shadow-amber-500/15'
              : 'border border-zinc-800 bg-zinc-950/40 text-zinc-300 hover:border-zinc-700 hover:bg-zinc-800/70'
          }`}
          title="Carrinho aberto e seleção de itens"
        >
          <ShoppingCart className="h-3.5 w-3.5" />
          <span>Carrinho</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('pedidos')}
          onKeyDown={(event) => handleTabKeyDown(event, 'pedidos')}
          ref={(element) => { tabRefs.current.pedidos = element }}
          role="tab"
          aria-selected={activeTab === 'pedidos'}
          tabIndex={activeTab === 'pedidos' ? 0 : -1}
          className={`flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 text-xs font-bold transition-all cursor-pointer ${
            activeTab === 'pedidos'
              ? 'border border-amber-400 bg-amber-500 text-zinc-950 shadow-lg shadow-amber-500/15'
              : 'border border-zinc-800 bg-zinc-950/40 text-zinc-300 hover:border-zinc-700 hover:bg-zinc-800/70'
          }`}
          title="Histórico de pedidos confirmados deste cliente"
        >
          <Package className="h-3.5 w-3.5" />
          <span>Pedidos</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('crm')}
          onKeyDown={(event) => handleTabKeyDown(event, 'crm')}
          ref={(element) => { tabRefs.current.crm = element }}
          role="tab"
          aria-selected={activeTab === 'crm'}
          tabIndex={activeTab === 'crm' ? 0 : -1}
          aria-label="Dados do cliente (CRM)"
          className={`flex min-h-11 items-center justify-center gap-1.5 rounded-xl border px-3 text-[11px] font-semibold transition-all cursor-pointer ${
            activeTab === 'crm'
              ? 'border-zinc-600 bg-zinc-700 text-zinc-100'
              : 'border-zinc-800 bg-zinc-950/40 text-zinc-500 hover:border-zinc-700 hover:bg-zinc-800/70 hover:text-zinc-300'
          }`}
          title="Informações de cadastro e notas do cliente"
        >
          <User className="h-3.5 w-3.5" />
          <span>CRM</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('fatos')}
          onKeyDown={(event) => handleTabKeyDown(event, 'fatos')}
          ref={(element) => { tabRefs.current.fatos = element }}
          role="tab"
          aria-selected={activeTab === 'fatos'}
          tabIndex={activeTab === 'fatos' ? 0 : -1}
          aria-label="Fatos do cliente (memória)"
          className={`flex min-h-11 items-center justify-center gap-1.5 rounded-xl border px-3 text-[11px] font-semibold transition-all cursor-pointer ${
            activeTab === 'fatos'
              ? 'border-zinc-600 bg-zinc-700 text-zinc-100'
              : 'border-zinc-800 bg-zinc-950/40 text-zinc-500 hover:border-zinc-700 hover:bg-zinc-800/70 hover:text-zinc-300'
          }`}
          title="Fatos lembrados sobre o cliente (memória da Sofia)"
        >
          <Sparkles className="h-3.5 w-3.5" />
          <span>Fatos</span>
        </button>
      </div>

      {/* Conteúdo da Aba Selecionada */}
      {activeTab === 'carrinho' ? (
        <div className="flex-1 min-h-0 overflow-hidden">
          <OperatorCartPanel
            clienteId={cliente.id}
            clienteNome={cliente.nome}
          />
        </div>
      ) : activeTab === 'pedidos' ? (
        <div className="flex-1 min-h-0 overflow-hidden">
          <OperatorClientOrdersList
            clienteId={cliente.id}
            clienteNome={cliente.nome}
          />
        </div>
      ) : activeTab === 'crm' ? (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* Conteúdo do CRM */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Informações Básicas */}
        <div>
          <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Dados Gerais</h3>
          <div className="rounded-lg bg-zinc-900/50 border border-zinc-800 p-4 space-y-2">
            <div>
              <div className="text-[10px] text-zinc-500 uppercase">Nome</div>
              <div className="text-sm font-medium text-zinc-100">{cliente.nome}</div>
            </div>
            <div>
              <div className="text-[10px] text-zinc-500 uppercase">Telefone</div>
              <div className="text-sm font-mono text-zinc-300">
                {cliente.telefone.startsWith('55') && cliente.telefone.length === 13
                  ? `+55 (${cliente.telefone.substring(2, 4)}) ${cliente.telefone.substring(4, 9)}-${cliente.telefone.substring(9)}`
                  : cliente.telefone}
              </div>
            </div>
          </div>
        </div>

        {/* Score */}
        <div>
          <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Star className="h-3.5 w-3.5 text-zinc-400" />
            Classificação (Score)
          </h3>
          <div className="flex items-center gap-2">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                type="button"
                onClick={() => setScore(star)}
                className="focus:outline-none transition-transform active:scale-95 cursor-pointer"
              >
                <Star
                  className={`h-6 w-6 transition-colors ${
                    star <= score
                      ? 'fill-amber-500 stroke-amber-500'
                      : 'stroke-zinc-600 hover:stroke-zinc-500'
                  }`}
                />
              </button>
            ))}
            <span className="text-xs text-zinc-500 ml-2">Nota: {score}/5</span>
          </div>
        </div>

        {/* Endereço */}
        <div>
          <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <MapPin className="h-3.5 w-3.5 text-zinc-400" />
            Endereço de Entrega
          </h3>
          <textarea
            value={endereco}
            onChange={(e) => setEndereco(e.target.value)}
            placeholder="Nenhum endereço cadastrado"
            rows={3}
            className="w-full text-xs rounded-lg border border-zinc-800 bg-zinc-900/30 px-3 py-2 text-zinc-100 placeholder-zinc-600 focus:border-amber-500/50 focus:outline-none resize-none transition-colors"
          />
        </div>

        {/* Tags */}
        <div>
          <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Tag className="h-3.5 w-3.5 text-zinc-400" />
            Tags / Marcadores
          </h3>
          
          {/* Pills de Tags */}
          <div className="flex flex-wrap gap-1.5 mb-3">
            {tags.length === 0 ? (
              <span className="text-xs text-zinc-600 italic">Sem tags associadas</span>
            ) : (
              tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 rounded bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 text-xs text-amber-500"
                >
                  {tag}
                  <button
                    type="button"
                    onClick={() => handleRemoveTag(tag)}
                    className="hover:bg-amber-500/20 rounded p-0.5 transition-colors focus:outline-none cursor-pointer"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))
            )}
          </div>

          {/* Adicionar Tag */}
          <form onSubmit={handleAddTag} className="flex gap-2">
            <input
              type="text"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              placeholder="Nova tag..."
              className="flex-1 text-xs rounded-lg border border-zinc-800 bg-zinc-900/30 px-3 py-1.5 text-zinc-100 placeholder-zinc-600 focus:border-amber-500/50 focus:outline-none transition-colors"
            />
            <button
              type="submit"
              disabled={!newTag.trim()}
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-800 text-zinc-300 border border-zinc-700/50 transition-colors hover:bg-zinc-700 hover:text-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer shrink-0"
            >
              <Plus className="h-4 w-4" />
            </button>
          </form>
        </div>

        {/* Notas */}
        <div>
          <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <FileText className="h-3.5 w-3.5 text-zinc-400" />
            Notas Internas (Atendimento)
          </h3>
          <textarea
            value={notas}
            onChange={(e) => setNotas(e.target.value)}
            placeholder="Observações importantes sobre o cliente, preferências, restrições alimentares..."
            rows={5}
            className="w-full text-xs rounded-lg border border-zinc-800 bg-zinc-900/30 px-3 py-2 text-zinc-100 placeholder-zinc-600 focus:border-amber-500/50 focus:outline-none resize-none transition-colors"
          />
        </div>

        {/* Feedback de Ação */}
        {successMsg && (
          <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-3 text-xs text-emerald-400 text-center animate-pulse">
            {successMsg}
          </div>
        )}

        {errorMsg && (
          <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-xs text-red-400 text-center">
            {errorMsg}
          </div>
        )}
      </div>

      {/* Botão de Ação Inferior */}
      <div className="border-t border-zinc-800 bg-zinc-900/20 p-4 shrink-0">
        <button
          type="button"
          onClick={handleSave}
          disabled={loading}
          className="w-full flex h-10 items-center justify-center gap-2 rounded-xl bg-amber-500 font-semibold text-zinc-950 transition-all hover:bg-amber-600 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer shadow-lg shadow-amber-500/10 text-sm"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          Salvar Alterações
        </button>
      </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-hidden">
          <OperatorClientFactsPanel
            clienteId={cliente.id}
            clienteNome={cliente.nome}
          />
        </div>
      )}
    </aside>
  )
}
