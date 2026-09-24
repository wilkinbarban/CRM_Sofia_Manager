import { createAdminClient } from '@/lib/supabase/admin'
import { allowsIntegrationMock } from '@/lib/runtime/environment'
import { processarRagPipeline } from '@/lib/ai/openrouter'
import { obterConfiguracaoSistema, obterSofiaGlobalChannelConfig } from '@/lib/config/sistema'
import { getBusinessProfile, type BusinessProfile } from '@/lib/config/business-profile'
import { verificarHorarioAtendimento } from '@/lib/horarios/verificar'
import { deriveTelegramMessageKey } from '@/lib/telegram/idempotency'
import { downloadTelegramDocument } from '@/lib/telegram/document-download'
import { queueCanonicalPaymentProof } from '@/lib/payment-proofs/canonical-intake'
import { paymentProofOperationalGates } from '@/lib/payment-proofs/operational-gates'
import { normalizeCuritibaPhone, maskPhone } from '@/lib/auth/phone'
import { classificarIntencaoMensagem, processarStatusContatoInbound } from '@/lib/whatsapp/contact-status'
import { executarToolSofia } from '@/lib/ai/tools'
import { parseTelegramCatalogCallback, selectOfficialTelegramCombos } from '@/lib/telegram/catalog'
import { telegramInboundBatchEnqueueEnabled } from '@/lib/sofia/inbound-batch-gates'
import { attachPersistedSofiaInboundMessage } from '@/lib/sofia/inbound-batch-producer'
import {
  enviarCatalogoTelegram,
  enviarFeedbackCatalogoTelegram,
  enviarOrientacaoComprovanteTelegram,
  enviarPromptCatalogoTelegram,
  responderCallbackTelegram,
} from '@/lib/telegram/send'

/**
 * Envia mensagem direta via API do Telegram (sem passar pelo pipeline RAG)
 */
async function enviarMensagemDireta(chatId: string, texto: string): Promise<boolean> {
  try {
    const token = await obterConfiguracaoSistema('TELEGRAM_BOT_TOKEN')
    if (!token) {
      console.error('[Telegram Webhook] TELEGRAM_BOT_TOKEN não configurado para mensagem direta.')
      return false
    }
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: texto })
    })
    return response.ok
  } catch (err) {
    console.error('[Telegram Webhook] Erro ao enviar mensagem direta:', err)
    return false
  }
}

export function obterMensagemBoasVindasTelegram(profile: BusinessProfile): string {
  const brand = profile.shortName || profile.name
  const role = profile.personaRole || 'assistente virtual'
  return `*Olá! Seja bem-vindo(a) à ${brand}!*

Sou a Sofía, ${role} da ${profile.name} em ${profile.location}. 😊

Para continuar o atendimento e personalizar sua experiência, preciso que você compartilhe seu número de telefone. É rapidinho!

👇 *Toque no botão abaixo para compartilhar:*`
}

export function buildTelegramContactConfirmationMessage(contatoNome: string): string {
  return `✅ *Obrigado, ${contatoNome}!* Seu número foi registrado.

Como posso te ajudar hoje? 😊`
}



type TelegramMessage = {
  message_id: string | number
  chat: { id: string | number; first_name?: string; username?: string }
  from?: { id?: string | number }
  text?: string
  contact?: { phone_number?: string; first_name?: string; user_id?: string | number }
  document?: {
    file_id?: string
    file_name?: string
    mime_type?: string
    file_size?: number
  }
  photo?: Array<{
    file_id?: string
    width?: number
    height?: number
    file_size?: number
  }>
}

type TelegramCallbackQuery = {
  id: string
  data?: string
  from: { id: string | number }
  message?: TelegramMessage
}

function isCatalogRequest(text: string) {
  return /\b(card[aá]pio|menu|combos?|op[cç][oõ]es|o que tem)\b/i.test(text)
}

function isOwnTelegramContact(message: TelegramMessage): boolean {
  return Boolean(
    message.contact?.user_id !== undefined &&
      message.from?.id !== undefined &&
      message.contact.user_id === message.from.id
  )
}

type TelegramPaymentProofMedia = {
  fileId: string
  mimeType: 'application/pdf' | 'image/jpeg' | 'image/png'
  fileSize: number
}

function selectTelegramPaymentProofMedia(message: TelegramMessage): TelegramPaymentProofMedia | null {
  if (message.document) {
    const mimeType = message.document.mime_type?.trim().toLowerCase()
    if (mimeType === 'application/pdf' || mimeType === 'image/jpeg' || mimeType === 'image/png') {
      return message.document.file_id && typeof message.document.file_size === 'number'
        ? { fileId: message.document.file_id, mimeType, fileSize: message.document.file_size }
        : null
    }
    return null
  }

  const largestPhoto = message.photo?.reduce((largest, photo) => {
    const area = (photo.width || 0) * (photo.height || 0)
    const largestArea = (largest?.width || 0) * (largest?.height || 0)
    return area > largestArea ? photo : largest
  })
  return largestPhoto?.file_id && typeof largestPhoto.file_size === 'number'
    ? { fileId: largestPhoto.file_id, mimeType: 'image/jpeg', fileSize: largestPhoto.file_size }
    : null
}

function getSafeTelegramMessageContent(message: TelegramMessage, senderName: string): string | null {
  if (message.text) return message.text

  if (message.contact) {
    const contatoNome = message.contact.first_name || senderName
    if (message.contact.phone_number && isOwnTelegramContact(message)) {
      const canonical = normalizeCuritibaPhone(message.contact.phone_number) || message.contact.phone_number
      return `[📱 Contact shared: ${contatoNome} — +${canonical}]`
    }
    return `[📱 Contact shared without verified ownership: ${contatoNome}]`
  }

  return null
}

async function resolveTelegramConversation(
  supabaseAdmin: ReturnType<typeof createAdminClient>,
  clienteId: string
): Promise<{ conversationId: string; iaAtiva: boolean }> {
  const { data: activeConv, error: convError } = await supabaseAdmin
    .from('conversas')
    .select('id, ia_ativa')
    .eq('cliente_id', clienteId)
    .neq('status', 'fechada')
    .order('data_atualizacao', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (convError) {
    throw new Error(`Erro ao buscar conversa: ${convError.message}`)
  }

  if (activeConv?.id) {
    return { conversationId: activeConv.id, iaAtiva: activeConv.ia_ativa ?? false }
  }

  const { data: newConv, error: insertConvError } = await supabaseAdmin
    .from('conversas')
    .insert({ cliente_id: clienteId, status: 'ia_atendendo', ia_ativa: true })
    .select('id, ia_ativa')
    .single()

  if (insertConvError) {
    throw new Error(`Erro ao criar conversa: ${insertConvError.message}`)
  }

  return { conversationId: newConv.id, iaAtiva: newConv.ia_ativa ?? true }
}

async function validateTelegramWebhookSecret(request: Request): Promise<boolean> {
  const expectedSecret = await obterConfiguracaoSistema('TELEGRAM_WEBHOOK_SECRET_TOKEN')

  if (!expectedSecret) {
    if (allowsIntegrationMock()) {
      console.warn('[Telegram Webhook] TELEGRAM_WEBHOOK_SECRET_TOKEN is not configured; accepting webhook in local/test mode.')
      return true
    }

    console.error('[Telegram Webhook] TELEGRAM_WEBHOOK_SECRET_TOKEN is required outside local/test mode.')
    return false
  }

  return request.headers.get('x-telegram-bot-api-secret-token') === expectedSecret
}

export async function POST(request: Request) {
  try {
    // Telegram secret validation must happen before request.json() so rejected requests do not process the update body.
    const isAuthorized = await validateTelegramWebhookSecret(request)
    if (!isAuthorized) {
      return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const callbackQuery = body.callback_query as TelegramCallbackQuery | undefined
    // O Telegram pode reentregar um callback_query. O tratamento de callbacks não tem
    // ledger durável de ids nem deduplicação, então um clique em catalog:view
    // reentregue pode reenviar os cartões oficiais. Isso é entrega ao menos uma vez,
    // não exatamente uma vez: não há garantia de supressão do envio repetido.
    if (callbackQuery) {
      const action = parseTelegramCatalogCallback(callbackQuery.data || '')
      const chatId = callbackQuery.message?.chat.id?.toString() || callbackQuery.from.id.toString()
      console.info('[Telegram Webhook] Catalog callback received.', {
        action: action?.action || 'unsupported',
        chatId,
      })
      if (!action) {
        await responderCallbackTelegram(callbackQuery.id, 'Ação indisponível.')
        return Response.json({ ok: true, status: 'unsupported_callback' })
      }

      const supabaseAdmin = createAdminClient()
      const { data: client, error: clientError } = await supabaseAdmin
        .from('clientes')
        .select('id, telefone')
        .eq('telegram_chat_id', chatId)
        .maybeSingle()

      if (clientError || !client) {
        await responderCallbackTelegram(callbackQuery.id, 'Compartilhe seu telefone antes de montar o pedido.')
        return Response.json({ ok: true, status: 'client_required' })
      }

      // Clique explícito em "Ver catálogo": só aqui o catálogo oficial em cartões sai.
      if (action.action === 'view') {
        // Ack neutro primeiro: nenhum texto promete envio antes de existir cartão confirmado.
        await responderCallbackTelegram(callbackQuery.id, 'Consultando o cardápio...')

        const { data: products, error: productsError } = await supabaseAdmin
          .from('produtos')
          .select('id, nome, descricao, preco_centavos, quantidade_estoque, url_imagem')
          .eq('ativo', true)
          .order('ordem_exibicao', { ascending: true })

        if (productsError) {
          await enviarFeedbackCatalogoTelegram(chatId, 'unavailable')
          return Response.json({ ok: true, status: 'catalog_view_unavailable' })
        }

        // A lista oficial é resolvida antes de qualquer afirmação de envio: o clique nunca
        // termina em "enviado" com zero cartões.
        const officialCombos = selectOfficialTelegramCombos(products ?? [])
        if (!officialCombos.length) {
          await enviarFeedbackCatalogoTelegram(chatId, 'empty')
          return Response.json({ ok: true, status: 'catalog_view_empty' })
        }

        await enviarCatalogoTelegram(chatId, officialCombos)
        return Response.json({ ok: true, status: 'catalog_view_sent' })
      }

      const result = action.action === 'cart'
        ? await executarToolSofia('ver_carrinho', {}, {
            clienteId: client.id,
            telefone: client.telefone || undefined,
            canal: 'telegram',
            supabaseClient: supabaseAdmin,
          })
        : action.action === 'details'
          ? await (async () => {
              const { data: product } = await supabaseAdmin
                .from('produtos')
                .select('id, nome, descricao, preco_centavos, url_imagem')
                .eq('id', action.productId)
                .eq('ativo', true)
                .maybeSingle()
              return product
                ? { success: true, mensagem: `${product.nome}\n\n${product.descricao || 'Assado especial da casa.'}\n\nR$ ${(product.preco_centavos / 100).toFixed(2).replace('.', ',')}` }
                : { success: false, mensagem: 'Esse produto não está disponível no momento.' }
            })()
          : await executarToolSofia('adicionar_ao_carrinho', {
              produtoId: action.productId,
              quantidade: 1,
            }, {
              clienteId: client.id,
              telefone: client.telefone || undefined,
              canal: 'telegram',
              supabaseClient: supabaseAdmin,
            })

      await responderCallbackTelegram(callbackQuery.id, result.success ? 'Pedido atualizado.' : result.mensagem)
      await enviarMensagemDireta(chatId, result.mensagem)
      return Response.json({ ok: true, status: `catalog_${action.action}` })
    }

    const message = body.message as TelegramMessage | undefined

    if (!message) {
      return Response.json({ ok: true })
    }

    const telegramChatId = message.chat.id.toString()
    const senderName = message.chat.first_name || message.chat.username || 'Cliente Telegram'
    const messageId = message.message_id.toString()
    const telegramMessageKey = deriveTelegramMessageKey(telegramChatId, messageId)

    const supabaseAdmin = createAdminClient()

    // Text/contact delivery deduplication remains in the chat ledger. Payment-proof
    // idempotency is owned by the canonical intake ledger instead.
    if (!message.document && !message.photo) {
      const { data: existingMessage, error: findError } = await supabaseAdmin
        .from('mensagens')
        .select('id')
        .eq('telegram_mensagem_id', telegramMessageKey)
        .maybeSingle()

      if (findError) {
        console.error('[Telegram Webhook] Erro ao buscar mensagem para idempotência:', findError)
        return Response.json({ ok: false, error: 'Erro ao verificar idempotência' }, { status: 500 })
      }

      if (existingMessage) {
        return Response.json({ ok: true, status: 'duplicate' })
      }
    }

    // ── BUSCAR OU CRIAR CLIENTE ───────────────────────────────
    const { data: client, error: clientError } = await supabaseAdmin
      .from('clientes')
      .select('id, telefone')
      .eq('telegram_chat_id', telegramChatId)
      .maybeSingle()

    if (clientError) {
      console.error('[Telegram Webhook] Erro ao buscar cliente:', clientError)
      return Response.json({ ok: false, error: 'Erro ao buscar cliente' }, { status: 500 })
    }

    let clienteId = client?.id
    let telefoneExistente = client?.telefone || null
    let isNewClient = false

    if (!clienteId) {
      const { data: newClient, error: insertClientError } = await supabaseAdmin
        .from('clientes')
        .insert({
          nome: senderName,
          telegram_chat_id: telegramChatId,
          telefone: null
        })
        .select('id')
        .single()

      if (insertClientError) {
        console.error('[Telegram Webhook] Erro ao criar cliente:', insertClientError)
        return Response.json({ ok: false, error: 'Erro ao criar cliente' }, { status: 500 })
      }
      clienteId = newClient.id
      isNewClient = true
    }

    // Canonical payment proofs are an intake concern, independent from Sofia's
    // automation and business-hours gates. When disabled, preserve the legacy
    // document path without validation, token lookup, or download side effects.
    const paymentProofMedia = selectTelegramPaymentProofMedia(message)
    const canonicalPaymentProofEnabled = Boolean(
      (message.document || message.photo) &&
      paymentProofOperationalGates.canonicalIngest.effective &&
      paymentProofOperationalGates.telegramIngest.effective
    )
    if ((message.document || message.photo) && canonicalPaymentProofEnabled) {
      let canonicalConversationId: string
      try {
        canonicalConversationId = (await resolveTelegramConversation(supabaseAdmin, clienteId)).conversationId
      } catch {
        return Response.json({ ok: false, status: 'payment_proof_retryable', message: 'Falha temporária ao receber documento.' }, { status: 503 })
      }
      const replay = await supabaseAdmin.rpc('get_payment_proof_delivery_state', {
        p_channel: 'telegram',
        p_delivery_key: telegramMessageKey,
      })
      if (replay.error) {
        return Response.json({ ok: false, status: 'payment_proof_retryable', message: 'Falha temporária ao receber documento.' }, { status: 503 })
      }
      const replayState = replay.data?.state
      if (!['missing', 'repairable', 'queued', 'complete'].includes(replayState)) {
        return Response.json({ ok: false, status: 'payment_proof_retryable', message: 'Falha temporária ao receber documento.' }, { status: 503 })
      }
      if (replayState === 'queued' || replayState === 'complete') {
        return Response.json({ ok: true, status: 'payment_proof_duplicate' })
      }

      const maxProofBytes = 5 * 1024 * 1024
      if (
        !paymentProofMedia ||
        !Number.isFinite(paymentProofMedia.fileSize) ||
        paymentProofMedia.fileSize <= 0 ||
        paymentProofMedia.fileSize > maxProofBytes
      ) {
        await enviarOrientacaoComprovanteTelegram(telegramChatId)
        return Response.json(
          { ok: false, status: 'payment_proof_rejected', message: 'Arquivo não suportado.' },
          { status: 422 }
        )
      }

      const token = await obterConfiguracaoSistema('TELEGRAM_BOT_TOKEN')
      if (!token) {
        return Response.json(
          { ok: false, status: 'payment_proof_retryable', message: 'Falha temporária ao receber documento.' },
          { status: 503 }
        )
      }

      const downloaded = await downloadTelegramDocument({
        token,
        fileId: paymentProofMedia.fileId,
        maxBytes: maxProofBytes,
        timeoutMs: 10_000,
        mimeType: paymentProofMedia.mimeType,
      })
      if (!downloaded.ok) {
        if (downloaded.retryable) {
          return Response.json(
            { ok: false, status: 'payment_proof_retryable', message: 'Falha temporária ao receber documento.' },
            { status: 503 }
          )
        }
        return Response.json(
          { ok: false, status: 'payment_proof_rejected', message: 'Arquivo não suportado.' },
          { status: 422 }
        )
      }

      const processed = await queueCanonicalPaymentProof({
        channel: 'telegram',
        deliveryId: telegramMessageKey,
        customerId: clienteId,
        orderId: null,
        conversationId: canonicalConversationId,
        sender: telegramChatId,
        bytes: downloaded.bytes,
        mimeType: downloaded.mimeType,
        db: supabaseAdmin,
        storage: supabaseAdmin.storage.from('payment-proofs'),
      })

      if (processed.status === 'retryable') {
        return Response.json(
          { ok: false, status: 'payment_proof_retryable', message: 'Falha temporária ao receber documento.' },
          { status: 503 }
        )
      }
      if (processed.status === 'rejected') {
        return Response.json(
          { ok: false, status: 'payment_proof_rejected', message: 'Documento PDF inválido.' },
          { status: 422 }
        )
      }
      if (processed.status === 'duplicate') {
        return Response.json({ ok: true, status: 'payment_proof_duplicate' })
      }
      if (processed.status !== 'disabled') {
        return Response.json({ ok: true, status: 'payment_proof_received' }, { status: 202 })
      }
      // The canonical processor retains its own defense-in-depth flag and can
      // still report disabled if configuration changes during this request.
    }

    const sofiaGlobalTelegram = await obterSofiaGlobalChannelConfig('telegram')
    if (!sofiaGlobalTelegram.enabled) {
      const safeContent = getSafeTelegramMessageContent(message, senderName)
      if (safeContent) {
        try {
          const { conversationId } = await resolveTelegramConversation(supabaseAdmin, clienteId)
          const { error: insertGlobalOffError } = await supabaseAdmin
            .from('mensagens')
            .insert({
              conversa_id: conversationId,
              remetente: 'cliente',
              conteudo: safeContent,
              telegram_mensagem_id: telegramMessageKey
            })

          if (insertGlobalOffError) {
            console.error('[Telegram Webhook] Erro ao salvar mensagem com Sofia globalmente desativada:', insertGlobalOffError)
            return Response.json({ ok: false, error: 'Erro ao salvar mensagem' }, { status: 500 })
          }
        } catch (conversationError: any) {
          console.error('[Telegram Webhook] Erro ao preparar conversa com Sofia globalmente desativada:', conversationError)
          return Response.json({ ok: false, error: conversationError.message || 'Erro ao preparar conversa' }, { status: 500 })
        }
      }

      console.log('[Telegram Webhook] Sofia globally disabled for Telegram. Inbound persisted without automation.')
      return Response.json({ ok: true, status: 'global_off' })
    }

    const batchingEnabled = telegramInboundBatchEnqueueEnabled()
    const horario = await verificarHorarioAtendimento()

    // Batching may defer only an eligible existing-phone text whose conversation
    // has Sofia active. Contacts, onboarding, media, and globally disabled flows
    // retain their immediate business-hours behavior.
    const contactIntent = message.text ? classificarIntencaoMensagem(message.text) : null
    const requiresImmediateOutOfHoursHandling = !batchingEnabled ||
      Boolean(message.contact?.phone_number) ||
      !message.text ||
      isNewClient ||
      !telefoneExistente ||
      contactIntent?.tipo === 'opt_out' ||
      contactIntent?.tipo === 'human_handoff' ||
      isCatalogRequest(message.text)

    if (!horario.dentro && requiresImmediateOutOfHoursHandling) {
      const safeContent = getSafeTelegramMessageContent(message, senderName)
      if (safeContent) {
        try {
          const { conversationId } = await resolveTelegramConversation(supabaseAdmin, clienteId)
          const { error: insertOutOfHoursError } = await supabaseAdmin
            .from('mensagens')
            .insert({
              conversa_id: conversationId,
              remetente: 'cliente',
              conteudo: safeContent,
              telegram_mensagem_id: telegramMessageKey
            })

          if (insertOutOfHoursError) {
            console.error('[Telegram Webhook] Erro ao salvar mensagem fora de horário:', insertOutOfHoursError)
            return Response.json({ ok: false, error: 'Erro ao salvar mensagem' }, { status: 500 })
          }
        } catch (conversationError: any) {
          console.error('[Telegram Webhook] Erro ao preparar conversa fora de horário:', conversationError)
          return Response.json({ ok: false, error: conversationError.message || 'Erro ao preparar conversa' }, { status: 500 })
        }

        await enviarMensagemDireta(telegramChatId, horario.mensagem!)
      }
      return Response.json({ ok: true, status: 'out_of_hours' })
    }

    // ── TRATAR COMPARTILHAMENTO DE CONTATO ────────────────────
    if (message.contact && message.contact.phone_number) {
      const contatoNome = message.contact.first_name || senderName
      const contactIsOwnedBySender = isOwnTelegramContact(message)
      const safeContactDisplay = contactIsOwnedBySender
        ? `[📱 Contact shared: ${contatoNome} — +${normalizeCuritibaPhone(message.contact.phone_number) || message.contact.phone_number}]`
        : `[📱 Contact shared without verified ownership: ${contatoNome}]`

      if (contactIsOwnedBySender) {
        const telefoneNormalizado = normalizeCuritibaPhone(message.contact.phone_number)

        if (telefoneNormalizado) {
          console.log(`[Telegram Webhook] Verified contact shared: ${contatoNome} (${maskPhone(telefoneNormalizado)})`)

          // Atualizar telefone e metadados de verificação explícita no registro do cliente
          const { error: updatePhoneError } = await supabaseAdmin
            .from('clientes')
            .update({
              telefone: telefoneNormalizado,
              nome: contatoNome,
              telefone_verificado_em: new Date().toISOString(),
              telefone_verificado_origem: 'telegram',
              data_atualizacao: new Date().toISOString()
            })
            .eq('id', clienteId)

          if (updatePhoneError) {
            console.error('[Telegram Webhook] Erro ao salvar telefone do contato:', updatePhoneError)
            return Response.json({ ok: false, error: 'Erro ao salvar telefone' }, { status: 500 })
          }

          telefoneExistente = telefoneNormalizado
        } else {
          console.warn('[Telegram Webhook] Telefone fora do padrão de Curitiba:', maskPhone(message.contact.phone_number))
        }
      } else {
        console.warn('[Telegram Webhook] Contact ignored because Telegram ownership could not be verified.', {
          chatId: telegramChatId,
          messageId,
          contactUserId: message.contact.user_id,
          senderUserId: message.from?.id,
        })
      }

      // ── BUSCAR OU CRIAR CONVERSA ───────────────────────────
      let conversationId: string
      let iaAtiva: boolean
      try {
        const resolvedConversation = await resolveTelegramConversation(supabaseAdmin, clienteId)
        conversationId = resolvedConversation.conversationId
        iaAtiva = resolvedConversation.iaAtiva
      } catch (conversationError: any) {
        console.error('[Telegram Webhook] Erro ao resolver conversa:', conversationError)
        return Response.json({ ok: false, error: conversationError.message || 'Erro ao resolver conversa' }, { status: 500 })
      }

      // Salvar mensagem do contato
      const { error: insertMsgError } = await supabaseAdmin
        .from('mensagens')
        .insert({
          conversa_id: conversationId,
          remetente: 'cliente',
          conteudo: safeContactDisplay,
          telegram_mensagem_id: telegramMessageKey
        })

      if (insertMsgError) {
        console.error('[Telegram Webhook] Erro ao salvar mensagem de contato:', insertMsgError)
        return Response.json({ ok: false, error: 'Erro ao salvar mensagem' }, { status: 500 })
      }

      if (!contactIsOwnedBySender) {
        return Response.json({ ok: true, status: 'contact_unverified' })
      }

      // Responder com confirmação e disparar RAG
      await enviarMensagemDireta(telegramChatId, buildTelegramContactConfirmationMessage(contatoNome))

      if (iaAtiva) {
        processarRagPipeline(conversationId, safeContactDisplay, 'telegram').catch((err) => {
          console.error('[Telegram Webhook] Erro no RAG após contato:', err)
        })
      }

      return Response.json({ ok: true })
    }

    // ── MENSAGEM DE TEXTO ─────────────────────────────────────
    if (!message.text) {
      return Response.json({ ok: true })
    }

    const messageText = message.text

    // ── NOVO CLIENTE SEM TELEFONE → Pedir contato ────────────
    if (isNewClient || !telefoneExistente) {
      console.log(`[Telegram Webhook] Novo cliente sem telefone (${senderName}). Solicitando contato.`)

      try {
        const { conversationId } = await resolveTelegramConversation(supabaseAdmin, clienteId)
        const { error: insertMissingPhoneError } = await supabaseAdmin
          .from('mensagens')
          .insert({
            conversa_id: conversationId,
            remetente: 'cliente',
            conteudo: messageText,
            telegram_mensagem_id: telegramMessageKey
          })

        if (insertMissingPhoneError) {
          console.error('[Telegram Webhook] Erro ao salvar mensagem antes de solicitar telefone:', insertMissingPhoneError)
          return Response.json({ ok: false, error: 'Erro ao salvar mensagem' }, { status: 500 })
        }
      } catch (conversationError: any) {
        console.error('[Telegram Webhook] Erro ao preparar conversa para solicitar telefone:', conversationError)
        return Response.json({ ok: false, error: conversationError.message || 'Erro ao preparar conversa' }, { status: 500 })
      }

      const profile = await getBusinessProfile()
      await enviarMensagemDireta(telegramChatId, obterMensagemBoasVindasTelegram(profile))

      // Também enviar um keyboard button para facilitar o compartilhamento
      try {
        const token = await obterConfiguracaoSistema('TELEGRAM_BOT_TOKEN')
        if (token) {
          await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: telegramChatId,
              text: 'Toque no botão abaixo para compartilhar:',
              reply_markup: {
                keyboard: [[{ text: '📱 Compartilhar meu número', request_contact: true }]],
                resize_keyboard: true,
                one_time_keyboard: true
              }
            })
          })
        }
      } catch (err) {
        console.error('[Telegram Webhook] Erro ao enviar keyboard de contato:', err)
      }

      return Response.json({ ok: true })
    }

    // ── CLIENTE EXISTENTE COM TELEFONE → Fluxo normal ────────
    let conversationId: string
    let iaAtiva: boolean
    try {
      const resolvedConversation = await resolveTelegramConversation(supabaseAdmin, clienteId)
      conversationId = resolvedConversation.conversationId
      iaAtiva = resolvedConversation.iaAtiva
    } catch (conversationError: any) {
      console.error('[Telegram Webhook] Erro ao resolver conversa:', conversationError)
      return Response.json({ ok: false, error: conversationError.message || 'Erro ao resolver conversa' }, { status: 500 })
    }

    if (!horario.dentro && !(batchingEnabled && iaAtiva)) {
      const { error: insertOutOfHoursError } = await supabaseAdmin
        .from('mensagens')
        .insert({
          conversa_id: conversationId,
          remetente: 'cliente',
          conteudo: messageText,
          telegram_mensagem_id: telegramMessageKey
        })

      if (insertOutOfHoursError) {
        console.error('[Telegram Webhook] Erro ao salvar mensagem fora de horário:', insertOutOfHoursError)
        return Response.json({ ok: false, error: 'Erro ao salvar mensagem' }, { status: 500 })
      }

      await enviarMensagemDireta(telegramChatId, horario.mensagem!)
      return Response.json({ ok: true, status: 'out_of_hours' })
    }

    // Salvar mensagem do cliente
    const { data: persistedMessage, error: insertMessageError } = await supabaseAdmin
      .from('mensagens')
      .insert({
        conversa_id: conversationId,
        remetente: 'cliente',
        conteudo: messageText,
        telegram_mensagem_id: telegramMessageKey
      })
      .select('id')
      .single()

    if (insertMessageError || !persistedMessage?.id) {
      console.error('[Telegram Webhook] Erro ao inserir mensagem:', insertMessageError)
      return Response.json({ ok: false, error: 'Erro ao salvar mensagem' }, { status: 500 })
    }

    // Processar Governança de Contatos (Opt-In / Opt-Out / Candidatos / Timestamps)
    const statusContato = await processarStatusContatoInbound(supabaseAdmin, clienteId, messageText)

    if (statusContato.suprimirSofia) {
      console.log(`[Telegram Webhook] Sofia suprimida por solicitação de opt-out para cliente ${clienteId}.`)
      if (statusContato.mensagemRespostaCurta) {
        try {
          await enviarMensagemDireta(telegramChatId, statusContato.mensagemRespostaCurta)
          await supabaseAdmin.from('mensagens').insert({
            conversa_id: conversationId,
            remetente: 'ia',
            conteudo: statusContato.mensagemRespostaCurta,
          })
        } catch (err) {
          console.error('[Telegram Webhook] Erro ao enviar resposta curta de opt-out:', err)
        }
      }
      return Response.json({ ok: true, message: 'Opt-out processado' })
    }

    // Opt-in do catálogo: a palavra-chave devolve apenas um prompt curto com um único
    // botão. Os cartões oficiais saem somente no clique explícito em catalog:view, e o
    // retorno antecipado mantém o turno fora do RAG e do produtor de batching.
    if (isCatalogRequest(messageText)) {
      await enviarPromptCatalogoTelegram(telegramChatId)
      return Response.json({ ok: true, status: 'catalog_prompt_sent' })
    }

    // Disparar pipeline RAG ou anexar a mensagem canônica já persistida.
    if (iaAtiva && batchingEnabled) {
      const attached = await attachPersistedSofiaInboundMessage({
        supabase: supabaseAdmin,
        messageId: persistedMessage.id,
        conversationId,
        customerId: clienteId,
        channel: 'telegram',
      })
      if (!attached) console.error('[Telegram Webhook] SOFIA_BATCH_ATTACH_FAILED')
    } else if (iaAtiva) {
      processarRagPipeline(conversationId, messageText, 'telegram').catch((err) => {
        console.error('[Telegram Webhook] Erro no processarRagPipeline:', err)
      })
    }

    return Response.json({ ok: true })
  } catch (err: any) {
    console.error('[Telegram Webhook] Erro crítico:', err)
    return Response.json({ ok: false, error: err.message || 'Erro interno' }, { status: 500 })
  }
}
