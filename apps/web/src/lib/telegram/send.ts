import { createAdminClient } from '@/lib/supabase/admin'
import { obterConfiguracaoSistema } from '@/lib/config/sistema'
import { deriveTelegramMessageKey } from '@/lib/telegram/idempotency'
import {
  buildTelegramCatalogCard,
  buildTelegramCatalogFeedbackMessage,
  buildTelegramCatalogPromptMessage,
  type TelegramCatalogFeedbackReason,
} from '@/lib/telegram/catalog'
import type { ProdutoCardapio } from '@/lib/cardapio/formatar'

async function postTelegram(token: string, method: string, payload: unknown) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}))
    throw new Error(`Erro na API do Telegram (${method}): ${response.statusText}. Detalhes: ${JSON.stringify(errorData)}`)
  }

  return response.json()
}

export async function enviarPromptCatalogoTelegram(chatId: string): Promise<void> {
  const token = await obterConfiguracaoSistema('TELEGRAM_BOT_TOKEN')
  if (!token) throw new Error('Token do bot do Telegram não configurado.')

  const prompt = buildTelegramCatalogPromptMessage()
  await postTelegram(token, 'sendMessage', {
    chat_id: chatId,
    text: prompt.text,
    reply_markup: prompt.reply_markup,
  })
}

export async function enviarFeedbackCatalogoTelegram(
  chatId: string,
  reason: TelegramCatalogFeedbackReason,
): Promise<void> {
  const token = await obterConfiguracaoSistema('TELEGRAM_BOT_TOKEN')
  if (!token) throw new Error('Token do bot do Telegram não configurado.')

  const feedback = buildTelegramCatalogFeedbackMessage(reason)
  await postTelegram(token, 'sendMessage', {
    chat_id: chatId,
    text: feedback.text,
  })
}

export async function enviarCatalogoTelegram(chatId: string, products: ProdutoCardapio[]) {
  const token = await obterConfiguracaoSistema('TELEGRAM_BOT_TOKEN')
  if (!token) throw new Error('Token do bot do Telegram não configurado.')

  for (const product of products) {
    const card = buildTelegramCatalogCard(
      product,
      process.env.NEXT_PUBLIC_APP_URL || 'https://crmsofiamanager.duckdns.org',
    )
    const textPayload = {
      chat_id: chatId,
      text: card.caption,
      parse_mode: 'Markdown',
      reply_markup: card.reply_markup,
    }
    if (!card.photo) {
      await postTelegram(token, 'sendMessage', textPayload)
      continue
    }

    try {
      await postTelegram(token, 'sendPhoto', {
        chat_id: chatId,
        photo: card.photo,
        caption: card.caption,
        parse_mode: 'Markdown',
        reply_markup: card.reply_markup,
      })
    } catch (error) {
      console.warn('[Telegram Catalog] Foto rejeitada; enviando cartão textual.', error)
      await postTelegram(token, 'sendMessage', textPayload)
    }
  }
}

export async function enviarOrientacaoComprovanteTelegram(chatId: string): Promise<void> {
  const token = await obterConfiguracaoSistema('TELEGRAM_BOT_TOKEN')
  if (!token) return

  await postTelegram(token, 'sendMessage', {
    chat_id: chatId,
    text: 'Envie o comprovante como PDF, imagem JPEG ou PNG para que possamos analisar.',
  }).catch(() => undefined)
}

export async function responderCallbackTelegram(callbackQueryId: string, text: string) {
  const token = await obterConfiguracaoSistema('TELEGRAM_BOT_TOKEN')
  if (!token) throw new Error('Token do bot do Telegram não configurado.')
  await postTelegram(token, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false,
  })
}

/**
 * Conjunto fechado e sanitizado de motivos para uma ação de chat não aceita.
 * Nunca é derivado de texto do provedor, token ou identificador de chat.
 */
export const TELEGRAM_CHAT_ACTION_REASONS = [
  'conversation_not_found',
  'chat_id_missing',
  'token_missing',
  'config_unavailable',
  'query_unavailable',
  'network_error',
  'malformed_response',
  'provider_rejected',
  'provider_error',
] as const

export type TelegramChatActionReason = (typeof TELEGRAM_CHAT_ACTION_REASONS)[number]

export type TelegramChatActionOutcome = 'accepted' | 'rejected' | 'unavailable'

/**
 * Resultado tipado de `sendChatAction`.
 *
 * `accepted` significa apenas que a API do Telegram confirmou a ação com o corpo
 * documentado `ok: true` / `result: true`. Não é prova de que o cliente viu o
 * indicador de digitação: a API só promete manter o status por até 5 segundos, ou
 * até que uma mensagem chegue ao chat.
 */
export type TelegramChatActionReport =
  | { outcome: 'accepted' }
  | { outcome: 'rejected'; reason: TelegramChatActionReason }
  | { outcome: 'unavailable'; reason: TelegramChatActionReason }

function unavailableChatAction(reason: TelegramChatActionReason): TelegramChatActionReport {
  return { outcome: 'unavailable', reason }
}

/**
 * Caminho dedicado de `sendChatAction`. Não reutiliza `postTelegram` para não
 * alterar o comportamento dos enviadores de mensagem, foto e callback.
 */
async function postTelegramChatAction(
  token: string,
  chatId: string,
  action: 'typing',
): Promise<TelegramChatActionReport> {
  let response: Response
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action }),
    })
  } catch {
    // O detalhe da falha de rede pode carregar token ou identificadores: fica fora do relatório.
    return unavailableChatAction('network_error')
  }

  if (!response.ok) {
    // 4xx: o provedor avaliou e recusou a ação. 5xx: o provedor não conseguiu responder.
    return response.status >= 500
      ? unavailableChatAction('provider_error')
      : { outcome: 'rejected', reason: 'provider_rejected' }
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return unavailableChatAction('malformed_response')
  }

  // Contrato estrito e documentado: o sucesso de sendChatAction é `ok: true` + `result: true`.
  const body = payload as { ok?: unknown; result?: unknown } | null
  if (body && typeof body === 'object' && body.ok === true && body.result === true) {
    return { outcome: 'accepted' }
  }

  return { outcome: 'rejected', reason: 'provider_rejected' }
}

/**
 * Solicita a ação de chat para uma conversa do Sofía.
 * Sempre resolve, nunca lança: a classificação `unavailable` cobre conversa, chat,
 * token, consulta e provedor indisponíveis sem expor token, IDs ou texto do provedor.
 */
export async function enviarAcaoChatTelegram(
  conversaId: string,
  action: 'typing',
): Promise<TelegramChatActionReport> {
  let telegramChatId: string
  try {
    const supabase = createAdminClient()
    const { data: conversa, error } = await supabase
      .from('conversas')
      .select('id, clientes (telegram_chat_id)')
      .eq('id', conversaId)
      .single()

    if (error || !conversa) return unavailableChatAction('conversation_not_found')

    const chatId = (conversa as any)?.clientes?.telegram_chat_id
    if (!chatId) return unavailableChatAction('chat_id_missing')

    telegramChatId = String(chatId)
  } catch {
    return unavailableChatAction('query_unavailable')
  }

  let token: string | null
  try {
    token = await obterConfiguracaoSistema('TELEGRAM_BOT_TOKEN')
  } catch {
    return unavailableChatAction('config_unavailable')
  }
  if (!token) return unavailableChatAction('token_missing')

  return postTelegramChatAction(token, telegramChatId, action)
}

export async function enviarMensagemTelegram(
  conversaId: string,
  payload: { texto: string; remetente: 'ia' | 'operador'; salvarNoBanco?: boolean }
) {
  const supabase = createAdminClient()

  // 1. Obter a conversa e o telegram_chat_id do cliente
  const { data: conversa, error: conversaError } = await supabase
    .from('conversas')
    .select('id, cliente_id, clientes (telegram_chat_id)')
    .eq('id', conversaId)
    .single()

  if (conversaError || !conversa) {
    throw new Error(`Conversa não encontrada: ${conversaError?.message || 'Sem dados'}`)
  }

  const telegramChatId = (conversa as any).clientes?.telegram_chat_id
  if (!telegramChatId) {
    throw new Error('Telegram Chat ID do cliente não encontrado para esta conversa.')
  }

  // 2. Obter token do bot do Telegram
  const token = await obterConfiguracaoSistema('TELEGRAM_BOT_TOKEN')
  if (!token) {
    throw new Error('Token do bot do Telegram (TELEGRAM_BOT_TOKEN) não configurado no sistema.')
  }

  // 3. Enviar mensagem via API do Telegram
  const data = await postTelegram(token, 'sendMessage', {
    chat_id: telegramChatId,
    text: payload.texto,
  })
  if (!data.ok || !data.result || !data.result.message_id) {
    throw new Error('Resposta inválida ou erro retornado pela API do Telegram.')
  }

  const telegramMensagemId = deriveTelegramMessageKey(telegramChatId, data.result.message_id)

  // 4. Inserir a mensagem no banco de dados (se salvarNoBanco não for explicitamente falso)
  let novaMensagem = null
  if (payload.salvarNoBanco !== false) {
    const { data: inserted, error: insertError } = await supabase
      .from('mensagens')
      .insert({
        conversa_id: conversaId,
        remetente: payload.remetente,
        conteudo: payload.texto,
        telegram_mensagem_id: telegramMensagemId,
      })
      .select()
      .single()

    if (insertError) {
      throw new Error(`Erro ao salvar mensagem no banco de dados: ${insertError.message}`)
    }
    novaMensagem = inserted
  }

  return {
    success: true,
    messageId: telegramMensagemId,
    mensagem: novaMensagem,
  }
}

/**
 * Envia um código OTP de verificação via Telegram para um chat_id específico.
 * Usado quando o cliente já possui vínculo com Telegram e prefere receber o código por lá.
 */
export async function enviarOtpTelegram(
  telegramChatId: string,
  codigo: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const token = await obterConfiguracaoSistema('TELEGRAM_BOT_TOKEN')
    if (!token) {
      return { success: false, error: 'TELEGRAM_BOT_TOKEN não configurado.' }
    }

    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text: `🔐 *Código de Verificação — Asados*\n\nSeu código OTP é: *${codigo}*\n\n⏳ Ele expira em *10 minutos*.\n\nSe você não solicitou este código, ignore esta mensagem.`,
        parse_mode: 'Markdown'
      })
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      return { success: false, error: `Erro na API do Telegram: ${JSON.stringify(errorData)}` }
    }

    return { success: true }
  } catch (err: any) {
    console.error('[Telegram OTP] Erro ao enviar:', err)
    return { success: false, error: err.message }
  }
}
