import { createAdminClient } from '@/lib/supabase/admin'
import { enviarMensagemWhatsapp } from '@/lib/whatsapp/send'
import { enviarMensagemTelegram } from '@/lib/telegram/send'
import type { SupabaseClient } from '@supabase/supabase-js'

export type TipoNotificacaoPedido = 'status_pedido' | 'status_pagamento'

export interface NotificacaoPedidoParams {
  pedidoId: string
  tipo: TipoNotificacaoPedido
  novoStatus?: string
  statusPagamento?: string
  motivo?: string
  /** Audited copy for a non-canonical event, such as an item edit. */
  mensagem?: string
  supabaseClient?: SupabaseClient
}

export interface ResultadoNotificacaoOmnichannel {
  web: boolean
  whatsapp: boolean
  telegram: boolean
  erros?: string[]
}

export function formatarMensagemNotificacao(params: NotificacaoPedidoParams, nomeCliente?: string): string {
  const saudacao = nomeCliente ? `Olá, *${nomeCliente}*!` : 'Olá!'

  if (params.tipo === 'status_pedido') {
    switch (params.novoStatus) {
      case 'confirmado':
        return `${saudacao}\n\n🥩 *Pedido Confirmado!*\nSeu pedido foi aceito pela nossa equipe e já está sendo preparado com todo o carinho. Este é um ambiente de demonstração com dados de teste.\n\n⏰ Avisaremos assim que estiver pronto para retirada ou sair para entrega!`
      case 'entregue':
        return `${saudacao}\n\n✨ *Pedido Concluído!*\nSeu pedido foi finalizado com sucesso. Que Deus abençoe a mesa da sua família e tenham uma excelente refeição!\n\nSeu comprovante de venda digital está disponível no seu painel.`
      case 'cancelado':
        const motivoTxt = params.motivo ? `\n*Motivo:* ${params.motivo}` : ''
        return `${saudacao}\n\n⚠️ *Atualização do Pedido: Cancelado*\nInformamos que seu pedido foi cancelado pelo atendimento.${motivoTxt}\n\nCaso tenha alguma dúvida, fale conosco aqui no chat.`
      default:
        return `${saudacao}\n\n📋 O status do seu pedido foi atualizado para: *${params.novoStatus}*.`
    }
  }

  if (params.tipo === 'status_pagamento') {
    switch (params.statusPagamento) {
      case 'aprovado':
        return `${saudacao}\n\n💳 *Pagamento Confirmado!*\nRecebemos a confirmação do seu pagamento com sucesso. Seu comprovante digital estará disponível no painel do pedido.`
      case 'rejeitado':
        return `${saudacao}\n\n❌ *Aviso de Pagamento*\nNão conseguimos confirmar o pagamento do seu pedido. Por favor, verifique com nosso atendente para regularizar.`
      case 'reembolsado':
        return `${saudacao}\n\n🔄 *Pagamento Reembolsado*\nO reembolso referente ao seu pedido foi processado pelo atendimento.`
      default:
        return `${saudacao}\n\n💳 O status do pagamento do seu pedido foi atualizado para: *${params.statusPagamento}*.`
    }
  }

  return `${saudacao}\n\nHá uma nova atualização no seu pedido neste ambiente de demonstração com dados de teste.`
}

/**
 * Legacy best-effort dispatcher for non-canonical events only (for example, item edits
 * and payment-proof rejection notices). Lifecycle and payment RPCs enqueue their own
 * canonical outbox delivery and must not call this function.
 */
export async function notificarClienteAtualizacaoPedido(
  params: NotificacaoPedidoParams
): Promise<ResultadoNotificacaoOmnichannel> {
  const supabase = params.supabaseClient ?? createAdminClient()
  const resultado: ResultadoNotificacaoOmnichannel = {
    web: false,
    whatsapp: false,
    telegram: false,
    erros: [],
  }

  try {
    // 1. Buscar dados do pedido, cliente e conversa
    const { data: pedido, error: pedidoError } = await supabase
      .from('pedidos')
      .select(`
        id,
        conversa_id,
        cliente_id,
        clientes (
          id,
          nome,
          telefone,
          telegram_chat_id
        )
      `)
      .eq('id', params.pedidoId)
      .single()

    if (pedidoError || !pedido) {
      console.warn('[Order Notifications] Pedido não encontrado para notificação')
      resultado.erros?.push('PEDIDO_NAO_ENCONTRADO')
      return resultado
    }

    const cliente = (pedido as any).clientes
    let conversaId = pedido.conversa_id

    // Se o pedido não tiver conversa_id associada diretamente, buscar a conversa mais recente do cliente
    if (!conversaId && pedido.cliente_id) {
      const { data: conversa } = await supabase
        .from('conversas')
        .select('id')
        .eq('cliente_id', pedido.cliente_id)
        .order('data_atualizacao', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (conversa) {
        conversaId = conversa.id
      }
    }

    const mensagemTexto = params.mensagem ?? formatarMensagemNotificacao(params, cliente?.nome)

    // 2. Canal WhatsApp (se houver telefone cadastrado)
    if (conversaId && cliente?.telefone) {
      try {
        const resWhatsapp = await enviarMensagemWhatsapp(conversaId, {
          texto: mensagemTexto,
          remetente: 'operador',
          categoria: 'REACTIVE',
        })
        if (resWhatsapp.sucesso) {
          resultado.whatsapp = true
          resultado.web = true
        } else if (resWhatsapp.motivo) {
          resultado.erros?.push('WHATSAPP_SKIPPED')
        }
      } catch {
        resultado.erros?.push('WHATSAPP_EXCEPTION')
      }
    }

    // 3. Canal Telegram (se houver telegram_chat_id)
    if (conversaId && cliente?.telegram_chat_id) {
      try {
        const resTelegram = await enviarMensagemTelegram(conversaId, {
          texto: mensagemTexto,
          remetente: 'operador',
          salvarNoBanco: !resultado.web,
        })
        if (resTelegram.success) {
          resultado.telegram = true
          if (!resultado.web) resultado.web = true
        }
      } catch {
        resultado.erros?.push('TELEGRAM_EXCEPTION')
      }
    }

    // 4. Canal Web Chat (se nenhum canal externo tiver gravado a mensagem no banco)
    if (conversaId && !resultado.web) {
      try {
        const { error: msgError } = await supabase.from('mensagens').insert({
          conversa_id: conversaId,
          remetente: 'operador',
          conteudo: mensagemTexto,
          url_anexo: null,
        })

        if (!msgError) {
          resultado.web = true
        } else {
          resultado.erros?.push('WEB_ERROR')
        }
      } catch {
        resultado.erros?.push('WEB_EXCEPTION')
      }
    }

    return resultado
  } catch {
    console.error('[Order Notifications] Falha geral ao notificar cliente')
    resultado.erros?.push('GLOBAL_ERROR')
    return resultado
  }
}
