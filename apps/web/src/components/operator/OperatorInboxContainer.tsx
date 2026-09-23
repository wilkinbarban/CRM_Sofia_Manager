'use client'

import React, { useState, useEffect, useCallback } from 'react'
import {
  AlertTriangle,
  Package,
  X,
  ArrowRight,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { alternarSofiaGlobal, alternarSofiaWhatsApp, obterStatusSofiaAtendimento } from '@/app/actions/atendimento'
import type { SofiaAtendimentoStatus } from '@/app/actions/atendimento'
import type { SofiaGlobalChannel } from '@/lib/config/sistema'
import ConversationsQueue, { Conversa, Mensagem, Cliente, WhatsAppSofiaState } from './ConversationsQueue'
import OperatorChatConsole from './OperatorChatConsole'
import ClientCrmPanel from './ClientCrmPanel'
import SofiaGlobalStatusBar from './SofiaGlobalStatusBar'
import { notificationSound } from '@/lib/audio/notification-sound'

interface OperatorInboxContainerProps {
  conversasIniciais: Conversa[]
  initialSofiaStatus: SofiaAtendimentoStatus | null
}

interface UrgentToast {
  id: string
  conversaId: string
  clienteNome: string
  tipo: 'alteracao' | 'cancelamento' | 'novo_pedido'
  mensagem: string
  timestamp: string
}

function isPriorityIntent(text: string | null): boolean {
  if (!text) return false
  const lower = text.toLowerCase()
  return (
    lower.includes('cancelar') ||
    lower.includes('cancelamento') ||
    lower.includes('cancela') ||
    lower.includes('alterar pedido') ||
    lower.includes('modificar pedido') ||
    lower.includes('mudar pedido') ||
    lower.includes('mudar horário') ||
    lower.includes('mudar horario') ||
    lower.includes('trocar item') ||
    lower.includes('trocar pedido') ||
    lower.includes('alterar item') ||
    lower.includes('remover item') ||
    lower.includes('adicionar item') ||
    lower.includes('queria mudar') ||
    lower.includes('queria cancelar')
  )
}

export default function OperatorInboxContainer({
  conversasIniciais,
  initialSofiaStatus
}: OperatorInboxContainerProps) {
  const [conversas, setConversas] = useState<Conversa[]>(conversasIniciais)
  const [selectedConversaId, setSelectedConversaId] = useState<string | null>(
    conversasIniciais.length > 0 ? conversasIniciais[0].id : null
  )
  const [sofiaToggleConversaId, setSofiaToggleConversaId] = useState<string | null>(null)
  const [sofiaToggleError, setSofiaToggleError] = useState<string | null>(null)
  const [sofiaStatus, setSofiaStatus] = useState<SofiaAtendimentoStatus | null>(initialSofiaStatus)
  const [sofiaStatusError, setSofiaStatusError] = useState<string | null>(null)
  const [refreshingSofiaStatus, setRefreshingSofiaStatus] = useState(false)
  const [togglingGlobalChannel, setTogglingGlobalChannel] = useState<SofiaGlobalChannel | null>(null)
  const [urgentToast, setUrgentToast] = useState<UrgentToast | null>(null)

  // Encontra a conversa ativa correspondente ao id selecionado
  const activeConversa = conversas.find((c) => c.id === selectedConversaId) || null

  const mapWhatsAppSofiaState = useCallback((state: any): WhatsAppSofiaState | null => {
    if (!state) return null

    return {
      id: state.id,
      cliente_id: state.cliente_id ?? state.clienteId,
      canal: state.canal,
      sofia_dormindo: state.sofia_dormindo ?? state.sleeping,
      motivo: state.motivo ?? state.reason,
      origem: state.origem ?? state.source,
      alterado_por: state.alterado_por ?? state.actorUserId,
      data_criacao: state.data_criacao ?? state.createdAt,
      data_atualizacao: state.data_atualizacao ?? state.updatedAt,
    }
  }, [])

  // Auto-dismiss do Toast urgente após 12 segundos
  useEffect(() => {
    if (!urgentToast) return
    const timer = setTimeout(() => {
      setUrgentToast(null)
    }, 12000)
    return () => clearTimeout(timer)
  }, [urgentToast])

  // Solicitar permissão para Notificações Desktop no navegador
  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      if (Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {})
      }
    }
  }, [])

  const refreshSofiaStatus = useCallback(async () => {
    setRefreshingSofiaStatus(true)
    setSofiaStatusError(null)
    try {
      const res = await obterStatusSofiaAtendimento()
      if (res.success && res.data) {
        setSofiaStatus(res.data)
      } else {
        setSofiaStatusError(res.error || 'Erro ao carregar status da Sofia')
      }
    } catch {
      setSofiaStatusError('Falha ao conectar com o servidor para status da Sofia')
    } finally {
      setRefreshingSofiaStatus(false)
    }
  }, [])

  const handleToggleGlobalSofia = async (channel: SofiaGlobalChannel, enabled: boolean) => {
    setTogglingGlobalChannel(channel)
    setSofiaStatusError(null)
    try {
      const res = await alternarSofiaGlobal(channel, enabled)
      if (res.success) {
        await refreshSofiaStatus()
      } else {
        setSofiaStatusError(res.error || 'Erro ao alternar status global')
      }
    } catch {
      setSofiaStatusError('Falha ao alternar status global da Sofia')
    } finally {
      setTogglingGlobalChannel(null)
    }
  }

  const buscarEstadoSofiaWhatsApp = useCallback(
    async (supabase: any, clienteId: string | null | undefined): Promise<WhatsAppSofiaState | null> => {
      if (!clienteId) return null

      const { data, error } = await supabase
        .from('whatsapp_sofia_states')
        .select('*')
        .eq('cliente_id', clienteId)
        .eq('canal', 'whatsapp')
        .maybeSingle()

      if (error || !data) {
        return null
      }

      return mapWhatsAppSofiaState(data)
    },
    [mapWhatsAppSofiaState]
  )

  // Função auxiliar para buscar detalhes completos de uma conversa e sincronizar
  const buscarEAtualizarConversaCompleta = useCallback(async (id: string) => {
    const supabase = createClient()

    const { data: cData, error: cError } = await supabase
      .from('conversas')
      .select(`
        id,
        cliente_id,
        status,
        ia_ativa,
        data_criacao,
        data_atualizacao,
        clientes (
          id,
          nome,
          telefone,
          endereco,
          tags,
          notas,
          score
        ),
        mensagens (
          id,
          conversa_id,
          remetente,
          conteudo,
          url_anexo,
          data_criacao
        )
      `)
      .eq('id', id)
      .single()

    if (!cError && cData) {
      const sofiaState = await buscarEstadoSofiaWhatsApp(supabase, cData.cliente_id)

      const msgsOrdenadas = (cData.mensagens || []).sort(
        (a: any, b: any) => new Date(a.data_criacao).getTime() - new Date(b.data_criacao).getTime()
      )

      const conversaAtualizada: Conversa = {
        ...cData,
        clientes: cData.clientes as any,
        mensagens: msgsOrdenadas as any,
        whatsapp_sofia_state: sofiaState,
      }

      setConversas((prev) => {
        const existe = prev.some((c) => c.id === id)
        if (existe) {
          return prev.map((c) => (c.id === id ? conversaAtualizada : c))
        }
        return [conversaAtualizada, ...prev]
      })
    }
  }, [buscarEstadoSofiaWhatsApp])

  // Ao montar, carrega as mensagens e detalhes de todas as conversas iniciais
  useEffect(() => {
    conversasIniciais.forEach((c) => {
      buscarEAtualizarConversaCompleta(c.id)
    })
    if (!initialSofiaStatus) {
      refreshSofiaStatus()
    }
  }, [conversasIniciais, buscarEAtualizarConversaCompleta, initialSofiaStatus, refreshSofiaStatus])

  // Configuração da escuta em Tempo Real (Supabase Realtime)
  useEffect(() => {
    const supabase = createClient()

    const canal = supabase
      .channel('operator-atendimento-realtime')
      // Escutar novos inserts em mensagens
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'mensagens' },
        async (payload) => {
          const novaMsg = payload.new as Mensagem
          
          if (novaMsg.remetente === 'cliente') {
            const isPrioritaria = isPriorityIntent(novaMsg.conteudo)
            
            if (typeof window !== 'undefined') {
              const somSalvo = (localStorage.getItem('crm_notificacoes_som') ?? localStorage.getItem('asados_notificacoes_som')) !== 'false'
              if (somSalvo) {
                if (isPrioritaria) {
                  notificationSound.playPriorityAlert()
                } else {
                  notificationSound.playChime()
                }
              }

              // Disparo de notificação Desktop nativa
              if (isPrioritaria) {
                notificationSound.showDesktopNotification('🚨 ATENÇÃO: Alteração ou Cancelamento de Pedido!', {
                  body: novaMsg.conteudo || 'O cliente solicitou ajuste ou cancelamento urgente do pedido.',
                })
              }
            }

            // Exibir Toast Flutuante de Alta Prioridade
            if (isPrioritaria) {
              setUrgentToast({
                id: crypto.randomUUID(),
                conversaId: novaMsg.conversa_id,
                clienteNome: 'Solicitação de Alteração / Cancelamento',
                tipo: novaMsg.conteudo?.toLowerCase().includes('cancel') ? 'cancelamento' : 'alteracao',
                mensagem: novaMsg.conteudo || 'O cliente solicitou modificação no pedido.',
                timestamp: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
              })
            }
          }
          
          setConversas((prevConversas) => {
            const conversaExiste = prevConversas.some((c) => c.id === novaMsg.conversa_id)

            if (!conversaExiste) {
              buscarEAtualizarConversaCompleta(novaMsg.conversa_id)
              return prevConversas
            }

            return prevConversas.map((c) => {
              if (c.id === novaMsg.conversa_id) {
                const msgs = c.mensagens || []
                if (msgs.some((m) => m.id === novaMsg.id)) {
                  return c
                }
                return {
                  ...c,
                  data_atualizacao: novaMsg.data_criacao,
                  mensagens: [...msgs, novaMsg].sort(
                    (a, b) => new Date(a.data_criacao).getTime() - new Date(b.data_criacao).getTime()
                  )
                }
              }
              return c
            })
          })
        }
      )
      // Escutar novos pedidos submetidos no sistema
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'pedidos' },
        async (payload) => {
          const novoPedido = payload.new as any

          if (typeof window !== 'undefined') {
            const somSalvo = (localStorage.getItem('crm_notificacoes_som') ?? localStorage.getItem('asados_notificacoes_som')) !== 'false'
            if (somSalvo) {
              notificationSound.playNewOrderAlert()
            }
            notificationSound.showDesktopNotification('📦 Novo Pedido Recebido!', {
              body: `Pedido #${novoPedido.id?.substring(0, 8).toUpperCase()} recebido no balcão de atendimento.`
            })
          }

          if (novoPedido.conversa_id) {
            buscarEAtualizarConversaCompleta(novoPedido.conversa_id)
          }

          setUrgentToast({
            id: crypto.randomUUID(),
            conversaId: novoPedido.conversa_id || selectedConversaId || '',
            clienteNome: 'Novo Pedido no Balcão',
            tipo: 'novo_pedido',
            mensagem: `Pedido #${novoPedido.id?.substring(0, 8).toUpperCase()} submetido pelo cliente para preparo.`,
            timestamp: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
          })
        }
      )
      // Escutar updates na tabela de conversas
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'conversas' },
        async (payload) => {
          const conversaAlt = payload.new as Conversa
          
          setConversas((prevConversas) => {
            const existe = prevConversas.some((c) => c.id === conversaAlt.id)
            if (existe) {
              return prevConversas.map((c) => {
                if (c.id === conversaAlt.id) {
                  return {
                    ...c,
                    status: conversaAlt.status,
                    ia_ativa: conversaAlt.ia_ativa,
                    data_atualizacao: conversaAlt.data_atualizacao
                  }
                }
                return c
              })
            } else {
              buscarEAtualizarConversaCompleta(conversaAlt.id)
              return prevConversas
            }
          })
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'whatsapp_sofia_states' },
        async (payload) => {
          const statePayload = (payload.new && Object.keys(payload.new).length > 0 ? payload.new : payload.old) as any
          const clienteId = statePayload?.cliente_id
          if (!clienteId) return

          const refreshedState = payload.eventType === 'DELETE'
            ? null
            : mapWhatsAppSofiaState(statePayload)

          setConversas((prev) =>
            prev.map((conversa) =>
              conversa.cliente_id === clienteId
                ? { ...conversa, whatsapp_sofia_state: refreshedState }
                : conversa
            )
          )
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(canal)
    }
  }, [buscarEAtualizarConversaCompleta, mapWhatsAppSofiaState, selectedConversaId])

  // Callback de alteração de conversa selecionada
  const handleSelectConversa = (id: string) => {
    setSelectedConversaId(id)
    buscarEAtualizarConversaCompleta(id)
    if (urgentToast && urgentToast.conversaId === id) {
      setUrgentToast(null)
    }
  }

  // Atualização local no estado ao alternar IA no console
  const handleConversaUpdated = (
    conversaId: string,
    iaAtiva: boolean,
    status: 'ia_atendendo' | 'aberta' | 'fechada'
  ) => {
    setConversas((prev) =>
      prev.map((c) =>
        c.id === conversaId
          ? {
              ...c,
              ia_ativa: iaAtiva,
              status,
              data_atualizacao: new Date().toISOString()
            }
          : c
      )
    )
  }

  // Toggle do sono da Sofía no WhatsApp por conversa
  const handleToggleSofiaSleep = async (conversa: Conversa, dormir: boolean) => {
    setSofiaToggleConversaId(conversa.id)
    setSofiaToggleError(null)

    const res = await alternarSofiaWhatsApp(conversa.cliente_id, dormir, conversa.id)

    if (res.success) {
      const refreshedState = res.state ? mapWhatsAppSofiaState(res.state) : null

      setConversas((prev) =>
        prev.map((item) => {
          if (item.cliente_id !== conversa.cliente_id) return item
          return {
            ...item,
            whatsapp_sofia_state: refreshedState,
            ia_ativa: !dormir,
            status: dormir && item.id === conversa.id ? 'aberta' : item.status,
            data_atualizacao: item.id === conversa.id ? new Date().toISOString() : item.data_atualizacao,
          }
        })
      )
    } else {
      setSofiaToggleError(`Erro ao alterar Sofía WhatsApp: ${res.error}`)
    }

    setSofiaToggleConversaId(null)
  }

  // Atualização local no estado ao enviar mensagem
  const handleMensagemEnviada = (conversaId: string, mensagem: Mensagem) => {
    setConversas((prev) =>
      prev.map((c) => {
        if (c.id === conversaId) {
          const msgs = c.mensagens || []
          if (msgs.some((m) => m.id === mensagem.id)) return c
          return {
            ...c,
            data_atualizacao: message_data_criacao(mensagem),
            mensagens: [...msgs, mensagem].sort(
              (a, b) => new Date(a.data_criacao).getTime() - new Date(b.data_criacao).getTime()
            )
          }
        }
        return c
      })
    )
  }

  function message_data_criacao(mensagem: Mensagem) {
    return mensagem.data_criacao
  }

  // Atualização local no estado ao salvar CRM do cliente
  const handleClienteUpdated = (clienteId: string, updatedFields: Partial<Cliente>) => {
    setConversas((prev) =>
      prev.map((c) => {
        if (c.clientes && c.clientes.id === clienteId) {
          return {
            ...c,
            clientes: {
              ...c.clientes,
              ...updatedFields
            }
          }
        }
        return c
      })
    )
  }

  return (
    <div className="relative flex h-full w-full flex-col bg-zinc-950 overflow-hidden">
      {/* Toast Flutuante de Alerta Urgente / Novo Pedido */}
      {urgentToast && (
        <div className="absolute top-4 right-4 z-50 max-w-md w-full animate-in fade-in slide-in-from-top-4 duration-300">
          <div
            className={`p-4 rounded-2xl border shadow-2xl backdrop-blur-md flex items-start gap-3 transition-all ${
              urgentToast.tipo === 'cancelamento'
                ? 'bg-red-950/95 border-red-500/80 text-red-100 shadow-red-950/50 ring-2 ring-red-500/30'
                : urgentToast.tipo === 'novo_pedido'
                ? 'bg-amber-950/95 border-amber-500/80 text-amber-100 shadow-amber-950/50 ring-2 ring-amber-500/30'
                : 'bg-orange-950/95 border-orange-500/80 text-orange-100 shadow-orange-950/50 ring-2 ring-orange-500/30'
            }`}
          >
            <div
              className={`p-2.5 rounded-xl shrink-0 ${
                urgentToast.tipo === 'cancelamento'
                  ? 'bg-red-500/20 text-red-400 animate-pulse'
                  : 'bg-amber-500/20 text-amber-400 animate-pulse'
              }`}
            >
              {urgentToast.tipo === 'novo_pedido' ? (
                <Package className="h-5 w-5" />
              ) : (
                <AlertTriangle className="h-5 w-5" />
              )}
            </div>

            <div className="flex-1 min-w-0 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-black uppercase tracking-wider block truncate">
                  {urgentToast.tipo === 'cancelamento'
                    ? '🚨 Cancelamento Solicitado'
                    : urgentToast.tipo === 'novo_pedido'
                    ? '🥩 Novo Pedido Recebido'
                    : '🚨 Alteração de Pedido'}
                </span>
                <span className="text-[10px] opacity-75 font-mono">
                  {urgentToast.timestamp}
                </span>
              </div>

              <p className="text-xs line-clamp-2 leading-relaxed opacity-90">
                {urgentToast.mensagem}
              </p>

              {urgentToast.conversaId && (
                <button
                  type="button"
                  onClick={() => handleSelectConversa(urgentToast.conversaId)}
                  className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900/90 hover:bg-zinc-900 text-amber-400 hover:text-amber-300 text-xs font-bold border border-amber-500/40 transition-all cursor-pointer shadow-sm active:scale-95"
                >
                  <span>Atender Agora</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={() => setUrgentToast(null)}
              className="p-1 rounded-lg hover:bg-black/20 text-zinc-400 hover:text-zinc-200 transition-colors shrink-0 cursor-pointer"
              title="Fechar notificação"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {sofiaStatus && (
        <SofiaGlobalStatusBar
          status={sofiaStatus}
          refreshing={refreshingSofiaStatus}
          togglingChannel={togglingGlobalChannel}
          error={sofiaStatusError}
          onToggleChannel={handleToggleGlobalSofia}
          onRefresh={refreshSofiaStatus}
        />
      )}

      <div
        data-testid="operator-workspace"
        className="flex min-h-0 flex-1 w-full flex-col overflow-y-auto xl:flex-row xl:overflow-hidden"
      >
        {/* Lista lateral de conversas */}
        <section
          data-testid="queue-region"
          aria-label="Fila de atendimento"
          data-workspace-label="Atendimento"
          className="h-64 w-full shrink-0 overflow-hidden border-b border-zinc-800 xl:h-full xl:w-72 xl:border-b-0 2xl:w-[22rem]"
        >
          {sofiaToggleError && (
            <div className="border-b border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {sofiaToggleError}
            </div>
          )}
          <ConversationsQueue
            conversas={conversas}
            selectedConversaId={selectedConversaId}
            onSelectConversa={handleSelectConversa}
            onToggleSofiaSleep={handleToggleSofiaSleep}
            sofiaToggleConversaId={sofiaToggleConversaId}
          />
        </section>

        {/* Console ativo de conversa */}
        <section
          data-testid="chat-region"
          aria-label="Conversa ativa"
          className="min-h-[24rem] w-full flex-1 overflow-hidden border-b border-zinc-800 xl:min-h-0 xl:h-full xl:border-b-0"
        >
          <OperatorChatConsole
            conversa={activeConversa}
            onConversaUpdated={handleConversaUpdated}
            onMensagemEnviada={handleMensagemEnviada}
          />
        </section>

        {/* Painel lateral de CRM */}
        <section
          data-testid="commercial-region"
          aria-label="Carrinho, pedidos e dados do cliente"
          data-workspace-label="Venda e relacionamento"
          className="h-[36rem] w-full shrink-0 overflow-hidden xl:h-full xl:w-[28rem] 2xl:w-[32rem]"
        >
          <ClientCrmPanel
            cliente={activeConversa?.clientes || null}
            onClienteUpdated={handleClienteUpdated}
          />
        </section>
      </div>
    </div>
  )
}
