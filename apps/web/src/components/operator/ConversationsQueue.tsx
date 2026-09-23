'use client'

import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { MessageSquare, Bot, UserCheck, Inbox, PauseCircle, PlayCircle, Loader2, Clock, Volume2, VolumeX, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { notificationSound } from '@/lib/audio/notification-sound'

export interface Cliente {
  id: string
  nome: string
  telefone: string
  endereco?: string | null
  tags?: string[]
  notas?: string | null
  score?: number
}

export interface WhatsAppSofiaState {
  id: string
  cliente_id: string
  canal: 'whatsapp'
  sofia_dormindo: boolean
  motivo: 'manual' | 'handoff_phrase' | null
  origem: 'operator' | 'meta_webhook' | 'evolution_webhook' | null
  alterado_por: string | null
  data_criacao: string
  data_atualizacao: string
}

export interface Mensagem {
  id: string;
  conversa_id: string;
  remetente: 'cliente' | 'operador' | 'ia';
  conteudo: string | null;
  url_anexo: string | null;
  payment_proof_id?: string | null;
  data_criacao: string;
}

export interface Conversa {
  id: string
  cliente_id: string
  status: 'ia_atendendo' | 'aberta' | 'fechada'
  ia_ativa: boolean
  data_criacao: string
  data_atualizacao: string
  clientes: Cliente | null
  mensagens?: Mensagem[]
  whatsapp_sofia_state?: WhatsAppSofiaState | null
}

interface ConversationsQueueProps {
  conversas: Conversa[]
  selectedConversaId: string | null
  onSelectConversa: (id: string) => void
  onToggleSofiaSleep?: (conversa: Conversa, dormir: boolean) => Promise<void>
  sofiaToggleConversaId?: string | null
}

type TabType = 'ia' | 'humano' | 'fechada'

export default function ConversationsQueue({
  conversas,
  selectedConversaId,
  onSelectConversa,
  onToggleSofiaSleep,
  sofiaToggleConversaId
}: ConversationsQueueProps) {
  const [activeTab, setActiveTab] = React.useState<TabType>('ia')
  const [somHabilitado, setSomHabilitado] = useState(true)

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('crm_notificacoes_som') ?? localStorage.getItem('asados_notificacoes_som')
      if (saved !== null) {
        setSomHabilitado(saved === 'true')
      }
    }
  }, [])

  const handleToggleSom = () => {
    const novoValor = !somHabilitado
    setSomHabilitado(novoValor)
    if (typeof window !== 'undefined') {
      localStorage.setItem('crm_notificacoes_som', String(novoValor))
    }
    if (novoValor) {
      notificationSound.playChime()
    }
  }

  // Formata data e hora de atualização para exibição no card
  const formatarDataHora = (isoString: string) => {
    if (!isoString) return ''
    const data = new Date(isoString)
    const hoje = new Date()
    if (data.toDateString() === hoje.toDateString()) {
      return data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    }
    return data.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
  }

  // Formata o número de telefone de Curitiba para exibição legível
  const formatarTelefone = (tel: string) => {
    if (!tel) return ''
    if (tel.startsWith('55') && tel.length === 13) {
      return `+55 (${tel.substring(2, 4)}) ${tel.substring(4, 9)}-${tel.substring(9)}`
    }
    return tel
  }

  // Retorna um fragmento estilizado da última mensagem
  const obterUltimaMensagem = (conversa: Conversa) => {
    const msgs = conversa.mensagens || []
    if (msgs.length === 0) return 'Nenhuma mensagem'
    const ultima = msgs[msgs.length - 1]
    const remetentePrefixo = 
      ultima.remetente === 'operador' ? 'Você: ' : 
      ultima.remetente === 'ia' ? 'Sofía: ' : ''
    
    if (ultima.conteudo) {
      return `${remetentePrefixo}${ultima.conteudo}`
    } else if (ultima.url_anexo) {
      return `${remetentePrefixo}📎 Anexo`
    }
    return 'Nenhuma mensagem'
  }

  // Heurística para contar mensagens não respondidas pelo operador ou IA
  const obterNaoLidasCount = useCallback((conversa: Conversa) => {
    if (conversa.id === selectedConversaId) return 0
    const msgs = conversa.mensagens || []
    if (msgs.length === 0) return 0

    let ultimoIndexAtendimento = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].remetente === 'operador' || msgs[i].remetente === 'ia') {
        ultimoIndexAtendimento = i
        break
      }
    }

    let count = 0
    for (let i = ultimoIndexAtendimento + 1; i < msgs.length; i++) {
      if (msgs[i].remetente === 'cliente') {
        count++
      }
    }
    return count
  }, [selectedConversaId])

  // Heurística para tempo de espera em minutos para a fila humana
  const obterTempoEsperaMinutos = (conversa: Conversa) => {
    if (conversa.ia_ativa || conversa.status !== 'aberta') return null
    const msgs = conversa.mensagens || []
    if (msgs.length === 0) return null
    const ultima = msgs[msgs.length - 1]
    if (ultima.remetente !== 'cliente') return null

    const dataMsg = new Date(ultima.data_criacao).getTime()
    if (!Number.isFinite(dataMsg)) return null
    const diffMs = Date.now() - dataMsg
    return Math.floor(diffMs / 60000)
  }

  // Contadores globais e mensagens não lidas por fila
  const statsPorAba = useMemo(() => {
    let iaTotal = 0
    let iaNaoLidas = 0
    let humanoTotal = 0
    let humanoNaoLidas = 0
    let fechadaTotal = 0

    for (const c of conversas) {
      const naoLidas = obterNaoLidasCount(c)
      if (c.ia_ativa && c.status === 'ia_atendendo') {
        iaTotal++
        iaNaoLidas += naoLidas
      } else if (!c.ia_ativa && c.status === 'aberta') {
        humanoTotal++
        humanoNaoLidas += naoLidas
      } else if (c.status === 'fechada') {
        fechadaTotal++
      }
    }

    return { iaTotal, iaNaoLidas, humanoTotal, humanoNaoLidas, fechadaTotal }
  }, [conversas, obterNaoLidasCount])

  // Detecção de solicitação de alteração ou cancelamento de pedido pelo cliente e se já foi atendida/resolvida
  const detectarSolicitacaoPrioritaria = useCallback((conversa: Conversa): {
    isPrioritaria: boolean
    tipo: 'alteracao' | 'cancelamento' | 'comprovante' | null
    status: 'pendente' | 'resolvido' | null
  } => {
    const msgs = conversa.mensagens || []
    if (msgs.length === 0) return { isPrioritaria: false, tipo: null, status: null }

    let indexSolicitacao = -1
    let tipoDetectado: 'alteracao' | 'cancelamento' | 'comprovante' | null = null

    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.remetente === 'cliente' && m.conteudo) {
        const txt = m.conteudo.toLowerCase()
        if (
          txt.includes('cancelar') ||
          txt.includes('cancelamento') ||
          txt.includes('cancela') ||
          txt.includes('queria cancelar')
        ) {
          indexSolicitacao = i
          tipoDetectado = 'cancelamento'
          break
        }
        if (
          txt.includes('comprovante') ||
          txt.includes('comprovante de pagamento') ||
          txt.includes('comprovante pix') ||
          m.url_anexo
        ) {
          indexSolicitacao = i
          tipoDetectado = 'comprovante'
          break
        }
        if (
          txt.includes('alterar pedido') ||
          txt.includes('modificar pedido') ||
          txt.includes('mudar pedido') ||
          txt.includes('mudar horário') ||
          txt.includes('mudar horario') ||
          txt.includes('trocar item') ||
          txt.includes('trocar pedido') ||
          txt.includes('alterar item') ||
          txt.includes('remover item') ||
          txt.includes('adicionar item') ||
          txt.includes('queria mudar')
        ) {
          indexSolicitacao = i
          tipoDetectado = 'alteracao'
          break
        }
      }
    }

    if (!tipoDetectado && (conversa.whatsapp_sofia_state as any)?.motivo === 'solicitacao_cliente_alteracao_cancelamento') {
      tipoDetectado = 'alteracao'
      indexSolicitacao = msgs.length - 1
    }

    if (!tipoDetectado || indexSolicitacao === -1) {
      return { isPrioritaria: false, tipo: null, status: null }
    }

    // Verifica se há resposta do operador ou confirmação de sistema após a solicitação do cliente
    let resolvido = false
    for (let j = indexSolicitacao + 1; j < msgs.length; j++) {
      const mPosterior = msgs[j]
      if (mPosterior.remetente === 'operador') {
        resolvido = true
        break
      }
      if (mPosterior.conteudo) {
        const cLower = mPosterior.conteudo.toLowerCase()
        if (
          cLower.includes('atualizado no balcão') ||
          cLower.includes('pedido confirmado') ||
          cLower.includes('pedido cancelado') ||
          cLower.includes('cancelado pelo atendimento') ||
          cLower.includes('conforme combinado') ||
          cLower.includes('pagamento aprovado') ||
          cLower.includes('comprovante validado') ||
          cLower.includes('pagamento confirmado')
        ) {
          resolvido = true
          break
        }
      }
    }

    return {
      isPrioritaria: true,
      tipo: tipoDetectado,
      status: resolvido ? 'resolvido' : 'pendente',
    }
  }, [])

  const prioridadesHumanoCount = useMemo(() => {
    return conversas.filter((c) => {
      if (c.ia_ativa || c.status !== 'aberta') return false
      const prio = detectarSolicitacaoPrioritaria(c)
      return prio.isPrioritaria && prio.status === 'pendente'
    }).length
  }, [conversas, detectarSolicitacaoPrioritaria])

  const isWhatsAppCustomer = (conversa: Conversa) => {
    const telefone = conversa.clientes?.telefone
    return typeof telefone === 'string' && /^55419[0-9]{8}$/.test(telefone)
  }

  // Filtra as conversas com base na aba selecionada
  const conversasFiltradas = conversas.filter((c) => {
    if (activeTab === 'ia') {
      return c.ia_ativa && c.status === 'ia_atendendo'
    } else if (activeTab === 'humano') {
      return !c.ia_ativa && c.status === 'aberta'
    } else {
      return c.status === 'fechada'
    }
  })

  // Ordena de forma decrescente pela última atualização, priorizando solicitações pendentes no topo
  const conversasOrdenadas = [...conversasFiltradas].sort((a, b) => {
    if (activeTab === 'humano') {
      const prioA = detectarSolicitacaoPrioritaria(a)
      const prioB = detectarSolicitacaoPrioritaria(b)
      const pesoA = prioA.isPrioritaria && prioA.status === 'pendente' ? 2 : prioA.isPrioritaria && prioA.status === 'resolvido' ? 1 : 0
      const pesoB = prioB.isPrioritaria && prioB.status === 'pendente' ? 2 : prioB.isPrioritaria && prioB.status === 'resolvido' ? 1 : 0
      if (pesoA !== pesoB) {
        return pesoB - pesoA
      }
    }
    const dateA = new Date(a.data_atualizacao || a.data_criacao).getTime()
    const dateB = new Date(b.data_atualizacao || b.data_criacao).getTime()
    return dateB - dateA
  })

  return (
    <div className="flex h-full w-full flex-col border-r border-zinc-800 bg-zinc-950">
      {/* Cabeçalho da Fila com Toggle de Alerta Sonoro */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800/80 bg-zinc-900/60">
        <div className="flex items-center gap-1.5">
          <MessageSquare className="h-4 w-4 text-amber-500" />
          <span className="text-xs font-bold text-zinc-200 tracking-tight">Fila de Atendimento</span>
        </div>
        <button
          type="button"
          onClick={handleToggleSom}
          className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold border transition-all cursor-pointer select-none ${
            somHabilitado
              ? 'bg-amber-500/10 text-amber-400 border-amber-500/20 hover:bg-amber-500/20'
              : 'bg-zinc-800/60 text-zinc-500 border-zinc-700/50 hover:bg-zinc-800'
          }`}
          title={somHabilitado ? 'Notificações sonoras ativas (clique para silenciar)' : 'Notificações sonoras silenciadas (clique para ativar)'}
        >
          {somHabilitado ? (
            <>
              <Volume2 className="h-3 w-3 text-amber-400" />
              <span>Som ativo</span>
            </>
          ) : (
            <>
              <VolumeX className="h-3 w-3 text-zinc-500" />
              <span>Mudo</span>
            </>
          )}
        </button>
      </div>

      {/* Abas de Filtros Rápidos com Contadores Numéricos */}
      <div className="grid grid-cols-3 border-b border-zinc-800 bg-zinc-900/30 p-1.5 gap-1">
        <button
          onClick={() => setActiveTab('ia')}
          className={`flex items-center justify-center py-2 px-1 text-xs font-medium rounded-lg transition-all gap-1.5 cursor-pointer relative ${
            activeTab === 'ia'
              ? 'bg-zinc-800 text-amber-400 shadow-sm border border-zinc-700/60 font-semibold'
              : 'text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'
          }`}
        >
          <Bot className="h-3.5 w-3.5 shrink-0" />
          <span>Fila IA</span>
          <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold ${
            activeTab === 'ia' ? 'bg-amber-500/20 text-amber-300' : 'bg-zinc-800 text-zinc-400'
          }`}>
            {statsPorAba.iaTotal}
          </span>
          {statsPorAba.iaNaoLidas > 0 && (
            <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse absolute top-1 right-1" />
          )}
        </button>

        <button
          onClick={() => setActiveTab('humano')}
          className={`flex items-center justify-center py-2 px-1 text-xs font-medium rounded-lg transition-all gap-1.5 cursor-pointer relative ${
            activeTab === 'humano'
              ? 'bg-zinc-800 text-amber-400 shadow-sm border border-zinc-700/60 font-semibold'
              : 'text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'
          }`}
        >
          <UserCheck className="h-3.5 w-3.5 shrink-0" />
          <span>Humana</span>
          <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold ${
            prioridadesHumanoCount > 0
              ? 'bg-red-500 text-white animate-pulse shadow-sm shadow-red-500/50'
              : statsPorAba.humanoNaoLidas > 0 
              ? 'bg-rose-500 text-white animate-pulse' 
              : activeTab === 'humano' ? 'bg-amber-500/20 text-amber-300' : 'bg-zinc-800 text-zinc-400'
          }`}>
            {statsPorAba.humanoTotal}
          </span>
          {prioridadesHumanoCount > 0 ? (
            <span className="h-2.5 w-2.5 rounded-full bg-red-500 animate-ping absolute top-1 right-1" title="Solicitações prioritárias pendentes" />
          ) : statsPorAba.humanoNaoLidas > 0 ? (
            <span className="h-2 w-2 rounded-full bg-rose-500 animate-ping absolute top-1 right-1" />
          ) : null}
        </button>

        <button
          onClick={() => setActiveTab('fechada')}
          className={`flex items-center justify-center py-2 px-1 text-xs font-medium rounded-lg transition-all gap-1.5 cursor-pointer ${
            activeTab === 'fechada'
              ? 'bg-zinc-800 text-amber-400 shadow-sm border border-zinc-700/60 font-semibold'
              : 'text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'
          }`}
        >
          <Inbox className="h-3.5 w-3.5 shrink-0" />
          <span>Fechadas</span>
          <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-zinc-800 text-zinc-400 font-bold">
            {statsPorAba.fechadaTotal}
          </span>
        </button>
      </div>

      {/* Fila de Cards de Conversa */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {conversasOrdenadas.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-zinc-500">
            <MessageSquare className="h-8 w-8 mb-2 stroke-zinc-600 animate-pulse" />
            <p className="text-xs">Nenhum atendimento nesta fila</p>
          </div>
        ) : (
          conversasOrdenadas.map((conversa) => {
            const isSelected = conversa.id === selectedConversaId
            const naoLidas = obterNaoLidasCount(conversa)
            const ultimaMsg = obterUltimaMensagem(conversa)
            const tempoEspera = obterTempoEsperaMinutos(conversa)
            const prio = detectarSolicitacaoPrioritaria(conversa)

            return (
              <div
                key={conversa.id}
                onClick={() => onSelectConversa(conversa.id)}
                className={`relative flex flex-col p-3.5 rounded-xl border transition-all duration-200 cursor-pointer ${
                  prio.isPrioritaria && prio.status === 'pendente'
                    ? isSelected
                      ? 'bg-zinc-900 border-red-500/80 shadow-lg shadow-red-950/30 ring-2 ring-red-500/40'
                      : 'bg-zinc-900/60 border-red-500/40 hover:bg-zinc-900 hover:border-red-500/60 shadow-md ring-1 ring-red-500/20'
                    : prio.isPrioritaria && prio.status === 'resolvido'
                    ? isSelected
                      ? 'bg-zinc-900 border-emerald-500/80 shadow-lg shadow-emerald-950/30 ring-2 ring-emerald-500/40'
                      : 'bg-zinc-900/60 border-emerald-500/40 hover:bg-zinc-900 hover:border-emerald-500/60 shadow-md ring-1 ring-emerald-500/20'
                    : isSelected
                    ? 'bg-zinc-900 border-amber-500/60 shadow-lg shadow-amber-500/5 ring-1 ring-amber-500/20'
                    : 'bg-zinc-900/40 border-zinc-800/80 hover:bg-zinc-900/80 hover:border-zinc-700/80'
                }`}
              >
                {/* Nome do Cliente e Data */}
                <div className="flex items-start justify-between gap-2 mb-1">
                  <span className="font-semibold text-sm text-zinc-100 truncate max-w-[70%]">
                    {conversa.clientes?.nome || 'Cliente Sem Nome'}
                  </span>
                  <span className="text-[10px] text-zinc-500 whitespace-nowrap font-mono">
                    {formatarDataHora(conversa.data_atualizacao || conversa.data_criacao)}
                  </span>
                </div>

                {/* Telefone Formatado */}
                {conversa.clientes?.telefone && (
                  <span className="text-xs text-zinc-500 font-mono mb-1.5 block">
                    {formatarTelefone(conversa.clientes.telefone)}
                  </span>
                )}

                {/* Badge de Prioridade (Pendente em Vermelho / Resolvido em Verde) */}
                {(() => {
                  if (!prio.isPrioritaria) return null

                  if (prio.status === 'resolvido') {
                    return (
                      <div className="mb-2 inline-flex items-center gap-1.5 text-[10px] font-bold text-emerald-300 bg-emerald-950/80 border border-emerald-500/50 px-2 py-0.5 rounded-md w-fit shadow-sm shadow-emerald-500/20">
                        <CheckCircle2 className="h-3 w-3 text-emerald-400 shrink-0" />
                        <span>
                          {prio.tipo === 'cancelamento'
                            ? '✅ CANCELAMENTO ATENDIDO & CONFIRMADO'
                            : prio.tipo === 'comprovante'
                            ? '✅ COMPROVANTE VALIDADO & ATENDIDO'
                            : '✅ ALTERAÇÃO ATENDIDA & ATUALIZADA'}
                        </span>
                      </div>
                    )
                  }

                  return (
                    <div className="mb-2 inline-flex items-center gap-1.5 text-[10px] font-bold text-red-300 bg-red-950/80 border border-red-500/50 px-2 py-0.5 rounded-md w-fit animate-pulse shadow-sm shadow-red-500/20">
                      <AlertTriangle className="h-3 w-3 text-red-400 shrink-0" />
                      <span>
                        {prio.tipo === 'cancelamento'
                          ? '🚨 CANCELAMENTO DE PEDIDO SOLICITADO'
                          : prio.tipo === 'comprovante'
                          ? '🚨 COMPROVANTE DE PAGAMENTO ENVIADO'
                          : '🚨 ALTERAÇÃO DE ITENS SOLICITADA'}
                      </span>
                    </div>
                  )
                })()}

                {/* Indicador de "Em Espera" (+5 min sem resposta humana) */}
                {tempoEspera !== null && tempoEspera >= 5 && (
                  <div className="mb-2 inline-flex items-center gap-1.5 text-[10px] font-bold text-rose-400 bg-rose-500/10 border border-rose-500/30 px-2 py-0.5 rounded-md w-fit">
                    <Clock className="h-3 w-3 text-rose-400 shrink-0" />
                    <span>Em espera há {tempoEspera} min</span>
                  </div>
                )}

                {isWhatsAppCustomer(conversa) && (
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span
                      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium border ${
                        conversa.whatsapp_sofia_state?.sofia_dormindo
                          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                          : 'bg-amber-500/10 text-amber-500 border-amber-500/20'
                      }`}
                    >
                      {conversa.whatsapp_sofia_state?.sofia_dormindo ? 'Human handling' : 'Sofía awake'}
                    </span>
                    {onToggleSofiaSleep && conversa.status !== 'fechada' && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          onToggleSofiaSleep(conversa, !conversa.whatsapp_sofia_state?.sofia_dormindo)
                        }}
                        disabled={sofiaToggleConversaId === conversa.id}
                        className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800/80 px-2 py-0.5 text-[10px] font-medium text-zinc-200 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {sofiaToggleConversaId === conversa.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : conversa.whatsapp_sofia_state?.sofia_dormindo ? (
                          <PlayCircle className="h-3 w-3" />
                        ) : (
                          <PauseCircle className="h-3 w-3" />
                        )}
                        {conversa.whatsapp_sofia_state?.sofia_dormindo ? 'Wake' : 'Sleep'}
                      </button>
                    )}
                  </div>
                )}

                {/* Snippet da Última Mensagem */}
                <p className="text-xs text-zinc-400 line-clamp-1 pr-6 leading-relaxed">
                  {ultimaMsg}
                </p>

                {/* Badge de Mensagens Não Lidas */}
                {naoLidas > 0 && (
                  <span className="absolute bottom-3.5 right-3.5 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-bold text-zinc-950 animate-bounce shadow-md">
                    {naoLidas}
                  </span>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
