import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { obterConfiguracaoSistema, obterSofiaGlobalChannelConfig } from '@/lib/config/sistema'
import { processarRagPipeline } from '@/lib/ai/openrouter'
import { verificarHorarioAtendimento } from '@/lib/horarios/verificar'
import { resolveWhatsAppInboundConversation } from '@/lib/whatsapp/sofia-control'
import { normalizeCuritibaPhone } from '@/lib/auth/phone'
import { processarStatusContatoInbound } from '@/lib/whatsapp/contact-status'
import { normalizarMensagemEvolution } from '@/lib/whatsapp/inbound-normalizer'
import { processarAcaoInterativaWhatsApp } from '@/lib/whatsapp/action-router'
import { enviarPromptCatalogoWhatsApp, formatarPromptCatalogoTexto } from '@/lib/whatsapp/gateways/catalog-gateway'
import { getBusinessProfile } from '@/lib/config/business-profile'
import { ingestEvolutionCanonicalPaymentProof } from '@/lib/payment-proofs/canonical-intake'
import { downloadEvolutionMedia } from '@/lib/whatsapp/evolution-media-download'
import { evaluateEvolutionPaymentProofCompatibility } from '@/lib/whatsapp/evolution-payment-proof-compatibility'
import { resolveEvolutionInboundPhoneLocalPart } from '@/lib/whatsapp/evolution-inbound-sender'
import { decodeEvolutionDocumentSize } from '@/lib/whatsapp/evolution-document-size'
import { paymentProofOperationalGates } from '@/lib/payment-proofs/operational-gates'
import { evolutionInboundBatchEnqueueEnabled } from '@/lib/sofia/inbound-batch-gates'
import { attachPersistedSofiaInboundMessage } from '@/lib/sofia/inbound-batch-producer'
import { evolutionHeaders } from '@/lib/whatsapp/evolution-headers'

async function resolveWhatsAppPersistenceConversation(
  supabaseAdmin: ReturnType<typeof createAdminClient>,
  clienteId: string
): Promise<string> {
  const { data: activeConversation, error: findError } = await supabaseAdmin
    .from('conversas')
    .select('id')
    .eq('cliente_id', clienteId)
    .eq('status', 'aberta')
    .order('data_atualizacao', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (findError) {
    throw new Error(`Failed to find persistence conversation: ${findError.message}`)
  }

  if (activeConversation?.id) return activeConversation.id

  const { data: newConversation, error: insertError } = await supabaseAdmin
    .from('conversas')
    .insert({ cliente_id: clienteId, status: 'aberta', ia_ativa: false })
    .select('id')
    .single()

  if (insertError) {
    throw new Error(`Failed to create persistence conversation: ${insertError.message}`)
  }

  return newConversation.id
}

async function sendEvolutionScheduleMessage(phone: string, message: string): Promise<void> {
  const evolutionUrl = await obterConfiguracaoSistema('EVOLUTION_API_URL')
  const evolutionApiKey = await obterConfiguracaoSistema('EVOLUTION_API_KEY')
  const evolutionInstanceName = await obterConfiguracaoSistema('EVOLUTION_INSTANCE_NAME')

  if (!evolutionUrl || !evolutionApiKey || !evolutionInstanceName) return

  const cleanUrl = evolutionUrl.replace(/\/$/, '')
  await fetch(`${cleanUrl}/message/sendText/${evolutionInstanceName}`, {
    method: 'POST',
    headers: evolutionHeaders(evolutionApiKey),
    body: JSON.stringify({
      number: phone,
      text: message,
      textMessage: { text: message }
    })
  })
}

function isRequestAborted(error: unknown): boolean {
  return error instanceof Error && /aborted/i.test(error.message)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function isCanonicalDeliveryId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
    && Buffer.byteLength(value, 'utf8') <= 256 && !/[\x00-\x1f\x7f]/.test(value)
}

function rejectCanonicalEnvelope() {
  console.warn('[Evolution Webhook] CANONICAL_ENVELOPE_REJECTED')
  return NextResponse.json({ success: false, status: 'payment_proof_rejected' }, { status: 422 })
}

export async function POST(request: Request) {
  try {
    // 1. Preserve legacy whole-route auth, while tracking dedicated-secret trust separately.
    const [webhookSecret, apiKey] = await Promise.all([
      obterConfiguracaoSistema('EVOLUTION_WEBHOOK_SECRET'),
      obterConfiguracaoSistema('EVOLUTION_API_KEY'),
    ])
    const requestSecret = request.headers.get('x-webhook-secret')
    const requestApiKey = request.headers.get('apikey') || request.headers.get('apiKey')
    const hasDedicatedSecretAuth = Boolean(webhookSecret && requestSecret === webhookSecret)
    const hasLegacyApiKeyAuth = Boolean(apiKey && requestApiKey === apiKey)

    if (!hasDedicatedSecretAuth && !hasLegacyApiKeyAuth) {
      console.warn('[Evolution Webhook] Autenticação falhou: credenciais de webhook inválidas.')
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // 2. Parsear corpo da requisição
    let body: any
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 })
    }

    // 3. Validar tipo de evento (MESSAGES_UPSERT)
    const event = body.event || ''
    if (event !== 'messages.upsert' && event !== 'MESSAGES_UPSERT') {
      return NextResponse.json({ success: true, message: `Evento ${event} ignorado` }, { status: 200 })
    }

    const data = body.data
    const isCanonicalMediaMessage = isPlainObject(data) && isPlainObject(data.message)
      && (Object.hasOwn(data.message, 'documentMessage') || Object.hasOwn(data.message, 'imageMessage'))
    if (isCanonicalMediaMessage && paymentProofOperationalGates.whatsappIngest.effective && !hasDedicatedSecretAuth) {
      console.warn('[Evolution Webhook] DOCUMENT_AUTH_REJECTED')
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const canonicalMediaCandidate = hasDedicatedSecretAuth && isPlainObject(data) && (
      !isPlainObject(data.message) || Object.hasOwn(data.message, 'documentMessage') || Object.hasOwn(data.message, 'imageMessage')
    )
    if (canonicalMediaCandidate) {
      const message = isPlainObject(data.message) ? data.message : null
      const media = message && (message.documentMessage ?? message.imageMessage)
      if (!isPlainObject(data.key) || !message || !isPlainObject(media) || data.key.fromMe !== false
        || !isCanonicalDeliveryId(data.key.id)) {
        return rejectCanonicalEnvelope()
      }
    }

    if (!data || !data.key) {
      return NextResponse.json({ success: true, message: 'Dados da mensagem ausentes' }, { status: 200 })
    }

    // 4. Ignorar mensagens enviadas pelo próprio número (fromMe: true)
    if (data.key.fromMe) {
      return NextResponse.json({ success: true, message: 'Mensagem enviada pelo próprio número ignorada' }, { status: 200 })
    }

    const messageId = data.key.id
    if (!messageId) {
      return NextResponse.json({ success: true, message: 'ID da mensagem ausente' }, { status: 200 })
    }

    const inboundPhoneLocalPart = resolveEvolutionInboundPhoneLocalPart(data.key)
    const inboundSender = normalizeCuritibaPhone(inboundPhoneLocalPart)

    // Canonical media retries intentionally run before the legacy mensagens dedupe.
    // A closed compatibility gate performs no download and falls through unchanged.
    const documentMessage = data.message?.documentMessage
    const imageMessage = data.message?.imageMessage
    const canonicalMedia = documentMessage || imageMessage
    let evolutionInstanceName: string | null = null
    if (canonicalMedia && hasDedicatedSecretAuth) {
      const [primaryProvider, fallbackProvider, operationalAttestation, configuredInstanceName] = await Promise.all([
        obterConfiguracaoSistema('PROVEDOR_WHATSAPP_ATIVO'),
        obterConfiguracaoSistema('WHATSAPP_PROVIDER'),
        obterConfiguracaoSistema('EVOLUTION_PAYMENT_PROOF_ATTESTATION'),
        obterConfiguracaoSistema('EVOLUTION_INSTANCE_NAME'),
      ])
      evolutionInstanceName = configuredInstanceName
      const compatibility = evaluateEvolutionPaymentProofCompatibility({
        gates: paymentProofOperationalGates,
        primaryProvider,
        fallbackProvider,
        operationalAttestation,
      })
      if (paymentProofOperationalGates.canonicalIngest.effective && paymentProofOperationalGates.whatsappIngest.effective && !compatibility.open) {
        console.warn('[Evolution Webhook] CANONICAL_COMPATIBILITY_REJECTED')
        return NextResponse.json({ success: false, status: 'payment_proof_rejected' }, { status: 422 })
      }

      if (compatibility.open) {
        const supabaseAdmin = createAdminClient()
        const normalizedDocumentMimeType = typeof canonicalMedia.mimetype === 'string'
          ? canonicalMedia.mimetype.trim().toLowerCase()
          : null
        if (!['application/pdf', 'image/jpeg', 'image/png'].includes(normalizedDocumentMimeType || '')) {
          console.warn('[Evolution Webhook] CANONICAL_DOCUMENT_MIME_REJECTED')
          return NextResponse.json({ success: false, status: 'payment_proof_rejected' }, { status: 422 })
        }
        if (!inboundSender) {
          console.warn('[Evolution Webhook] CANONICAL_SENDER_REJECTED')
          return NextResponse.json({ success: false, status: 'payment_proof_rejected' }, { status: 422 })
        }
        if (typeof body.instance !== 'string' || !body.instance || !evolutionInstanceName || body.instance !== evolutionInstanceName) {
          console.warn('[Evolution Webhook] CANONICAL_INSTANCE_REJECTED')
          return NextResponse.json({ success: false, status: 'payment_proof_rejected' }, { status: 422 })
        }
        const sender = inboundSender
        const deliveryKey = `evolution:${evolutionInstanceName}:${messageId}`
        const { data: deliveryStateResult, error: deliveryStateError } = await supabaseAdmin.rpc('get_payment_proof_delivery_state', {
          p_channel: 'whatsapp',
          p_delivery_key: deliveryKey,
        })
        const deliveryState = isPlainObject(deliveryStateResult) ? deliveryStateResult.state : null
        if (deliveryStateError || typeof deliveryState !== 'string' || !['missing', 'repairable', 'queued', 'complete'].includes(deliveryState)) {
          console.warn('[Evolution Webhook] CANONICAL_503_DELIVERY_STATE')
          return NextResponse.json({ success: false, status: 'payment_proof_retryable' }, { status: 503 })
        }
        if (deliveryState === 'queued' || deliveryState === 'complete') {
          return NextResponse.json({ success: true, status: 'payment_proof_duplicate' }, { status: 200 })
        }
        if (deliveryState === 'repairable') {
          console.warn('[Evolution Webhook] CANONICAL_DELIVERY_PROVENANCE_INCOMPLETE')
          return NextResponse.json({ success: false, status: 'payment_proof_rejected' }, { status: 422 })
        }
        {
            const declaredSize = decodeEvolutionDocumentSize(canonicalMedia.fileLength)
            if (declaredSize === null) {
              console.warn('[Evolution Webhook] CANONICAL_DOCUMENT_SIZE_REJECTED')
              return NextResponse.json({ success: false, status: 'payment_proof_rejected' }, { status: 422 })
            }

            const [evolutionApiUrl, evolutionApiKey] = await Promise.all([
              obterConfiguracaoSistema('EVOLUTION_API_URL'),
              obterConfiguracaoSistema('EVOLUTION_API_KEY'),
            ])
            if (!evolutionApiUrl || !evolutionApiKey || !evolutionInstanceName) {
              console.warn('[Evolution Webhook] CANONICAL_503_EVOLUTION_CONFIG')
              return NextResponse.json({ success: false, status: 'payment_proof_retryable' }, { status: 503 })
            }

            const downloaded = await downloadEvolutionMedia({
              apiUrl: evolutionApiUrl,
              apiKey: evolutionApiKey,
              instanceName: evolutionInstanceName,
              message: data,
              declaredMimeType: normalizedDocumentMimeType,
              declaredSize,
              timeoutMs: 10_000,
            })
            if (!downloaded.ok) {
              if (downloaded.retryable) {
                if (downloaded.error === 'EVOLUTION_MEDIA_HTTP_UPSTREAM') {
                  console.warn('[Evolution Webhook] CANONICAL_503_MEDIA_UPSTREAM')
                } else if (downloaded.error === 'EVOLUTION_MEDIA_NETWORK') {
                  console.warn('[Evolution Webhook] CANONICAL_503_MEDIA_NETWORK')
                } else if (downloaded.error === 'EVOLUTION_MEDIA_DOWNLOAD_TIMEOUT') {
                  console.warn('[Evolution Webhook] CANONICAL_503_MEDIA_TIMEOUT')
                } else {
                  console.warn('[Evolution Webhook] CANONICAL_503_MEDIA_UNKNOWN')
                }
                return NextResponse.json({ success: false, status: 'payment_proof_retryable' }, { status: 503 })
              }
              return NextResponse.json({ success: false, status: 'payment_proof_rejected' }, { status: 422 })
            }

            const processed = await ingestEvolutionCanonicalPaymentProof({
              channel: 'whatsapp',
              deliveryId: deliveryKey,
              orderId: null,
              sender,
              displayName: typeof data.pushName === 'string' ? data.pushName.slice(0, 100) : '',
              bytes: downloaded.bytes,
              mimeType: downloaded.mimeType,
              db: supabaseAdmin,
              storage: supabaseAdmin.storage.from('payment-proofs'),
            })
            if (processed.status === 'retryable') {
              console.warn('[Evolution Webhook] CANONICAL_503_PROCESSING')
              return NextResponse.json({ success: false, status: 'payment_proof_retryable' }, { status: 503 })
            }
            if (processed.status === 'rejected') {
              return NextResponse.json({ success: false, status: 'payment_proof_rejected' }, { status: 422 })
            }
            if (processed.status === 'duplicate') {
              return NextResponse.json({ success: true, status: 'payment_proof_duplicate' })
            }
          if (processed.status !== 'disabled') {
            return NextResponse.json({ success: true, status: 'payment_proof_received' }, { status: 202 })
          }
        }
      }
    }

    const supabaseAdmin = createAdminClient()

    // 5. Idempotência: verificar se whatsapp_mensagem_id já existe
    const { data: mensagemExistente, error: checkError } = await supabaseAdmin
      .from('mensagens')
      .select('id')
      .eq('whatsapp_mensagem_id', messageId)
      .maybeSingle()

    if (checkError) {
      console.error('[Evolution Webhook] LEGACY_DEDUPE_CHECK_FAILED')
      return NextResponse.json({ error: 'Erro de banco ao verificar idempotência' }, { status: 500 })
    }

    if (mensagemExistente) {
      console.log('[Evolution Webhook] LEGACY_DUPLICATE_IGNORED')
      return NextResponse.json({ success: true, message: 'Mensagem duplicada ignorada' }, { status: 200 })
    }

    // 6. Validar telefone do cliente (Brasil, DDD 41 — Curitiba)
    const sanitizedPhone = inboundSender
    if (!sanitizedPhone) {
      console.log('[Evolution Webhook] LEGACY_SENDER_REJECTED')
      return NextResponse.json({ success: true, message: 'Telefone fora do padrão descartado silenciosamente' }, { status: 200 })
    }

    // 7. Auto-registro do cliente
    const { data: cliente, error: clientError } = await supabaseAdmin
      .from('clientes')
      .select('id')
      .eq('telefone', sanitizedPhone)
      .maybeSingle()

    if (clientError) {
      console.error('[Evolution Webhook] LEGACY_CUSTOMER_LOOKUP_FAILED')
      return NextResponse.json({ error: 'Erro de banco ao buscar cliente' }, { status: 500 })
    }

    let clienteId: string
    if (!cliente) {
      const profileName = data.pushName || 'Contato Evolution'
      const { data: novoCliente, error: insertClientError } = await supabaseAdmin
        .from('clientes')
        .insert({
          usuario_id: null,
          nome: profileName,
          telefone: sanitizedPhone
        })
        .select('id')
        .single()

      if (insertClientError) {
        console.error('[Evolution Webhook] LEGACY_CUSTOMER_CREATE_FAILED')
        return NextResponse.json({ error: 'Erro ao criar cliente' }, { status: 500 })
      }
      clienteId = novoCliente.id
    } else {
      clienteId = cliente.id
    }

    // 8. Normalização de payloads
    const messageContent = data.message
    let mediaType: string | null = null

    if (messageContent) {
      if (messageContent.imageMessage) {
        mediaType = 'image'
      } else if (messageContent.audioMessage) {
        mediaType = 'audio'
      } else if (messageContent.documentMessage) {
        mediaType = 'document'
      } else if (messageContent.videoMessage) {
        mediaType = 'video'
      }
    }

    const textBody = 
      messageContent?.conversation ||
      messageContent?.extendedTextMessage?.text ||
      ''

    const caption = 
      messageContent?.imageMessage?.caption ||
      messageContent?.documentMessage?.caption ||
      messageContent?.videoMessage?.caption ||
      ''

    const conteudo = textBody || caption || (mediaType ? `[Evolution ${mediaType}]` : null)

    const sofiaGlobalWhatsApp = await obterSofiaGlobalChannelConfig('whatsapp')
    const horarioAtendimento = sofiaGlobalWhatsApp.enabled
      ? await verificarHorarioAtendimento()
      : null
    const shouldBypassSofia = !sofiaGlobalWhatsApp.enabled || (horarioAtendimento && !horarioAtendimento.dentro)
    const inboundResolution = shouldBypassSofia
      ? null
      : await resolveWhatsAppInboundConversation({
          supabase: supabaseAdmin,
          clienteId,
          inboundText: textBody || caption || null,
          source: 'evolution_webhook',
        })
    const conversaId = inboundResolution?.conversaId ?? await resolveWhatsAppPersistenceConversation(supabaseAdmin, clienteId)
    const iaAtiva = inboundResolution?.iaAtiva ?? false

    if (inboundResolution?.sleeping) {
      console.log('[Evolution Webhook] SOFIA_SLEEPING')
    }

    // 10. Persistir a mensagem recebida
    const { data: novaMensagem, error: insertMsgError } = await supabaseAdmin
      .from('mensagens')
      .insert({
        conversa_id: conversaId,
        remetente: 'cliente',
        conteudo,
        url_anexo: null,
        whatsapp_mensagem_id: messageId
      })
      .select()
      .single()

    if (insertMsgError) {
      console.error('[Evolution Webhook] LEGACY_MESSAGE_PERSIST_FAILED')
      return NextResponse.json({ error: 'Erro ao salvar mensagem' }, { status: 500 })
    }

    // 10. Processar Governança de Contatos (Opt-In / Opt-Out / Candidatos / Timestamps)
    const statusContato = await processarStatusContatoInbound(supabaseAdmin, clienteId, textBody || caption || null)

    if (statusContato.suprimirSofia) {
      console.log('[Evolution Webhook] SOFIA_OPT_OUT_SUPPRESSED')
      if (statusContato.mensagemRespostaCurta) {
        try {
          await sendEvolutionScheduleMessage(sanitizedPhone, statusContato.mensagemRespostaCurta)
          await supabaseAdmin.from('mensagens').insert({
            conversa_id: conversaId,
            remetente: 'ia',
            conteudo: statusContato.mensagemRespostaCurta,
          })
        } catch {
          console.error('[Evolution Webhook] OPT_OUT_REPLY_FAILED')
        }
      }
      return NextResponse.json({
        success: true,
        message: 'Opt-out processado com sucesso',
        data: novaMensagem,
      }, { status: 200 })
    }

    // 10.1 Interceptar Ações Interativas (Cliques em botões de carrinho, combos, etc)
    const norm = normalizarMensagemEvolution(body)
    if (norm?.interactiveId) {
      console.log('[Evolution Webhook] INTERACTIVE_ACTION_DETECTED')
      const acaoRes = await processarAcaoInterativaWhatsApp({
        clienteId,
        telefone: sanitizedPhone,
        interactiveId: norm.interactiveId,
        supabaseClient: supabaseAdmin,
      })

      if (acaoRes.handled && acaoRes.error) console.error('[Evolution Webhook] INTERACTIVE_ACTION_FAILED', acaoRes.error)

      if (acaoRes.handled && acaoRes.respostaTexto) {
        try {
          await sendEvolutionScheduleMessage(sanitizedPhone, acaoRes.respostaTexto)
          await supabaseAdmin.from('mensagens').insert({
            conversa_id: conversaId,
            remetente: 'ia',
            conteudo: acaoRes.respostaTexto,
          })
        } catch {
          console.error('[Evolution Webhook] INTERACTIVE_ACTION_REPLY_FAILED')
        }

        return NextResponse.json({
          success: true,
          message: 'Ação interativa processada com sucesso',
          data: novaMensagem,
        }, { status: 200 })
      }
    }

    if (!sofiaGlobalWhatsApp.enabled) {
      console.log('[Evolution Webhook] Sofia globally disabled for WhatsApp. Inbound persisted without automation.')
      return NextResponse.json({ success: true, message: 'Sofia globalmente desativada para WhatsApp', data: novaMensagem }, { status: 200 })
    }

    if (horarioAtendimento && !horarioAtendimento.dentro) {
      if (horarioAtendimento.mensagem) {
        try {
          await sendEvolutionScheduleMessage(sanitizedPhone, horarioAtendimento.mensagem)
        } catch {
          console.error('[Evolution Webhook] SCHEDULE_REPLY_FAILED')
        }
      }
      return NextResponse.json({ success: true, message: 'Fora do horário de atendimento', data: novaMensagem }, { status: 200 })
    }

    // Catalog opt-in confirmation (e.g. customer replies "1" or "sim" after the prompt)
    const trimmedInbound = (textBody || caption || '').trim()
    if (!norm?.interactiveId && /^(1|sim|quero(\s+ver)?|ver\s+(as\s+)?fotos?|fotos?)$/i.test(trimmedInbound)) {
      const { data: lastIaMsg } = await supabaseAdmin
        .from('mensagens')
        .select('conteudo, data_criacao')
        .eq('conversa_id', conversaId)
        .eq('remetente', 'ia')
        .order('data_criacao', { ascending: false })
        .limit(1)
        .maybeSingle()

      const promptAgeMs = lastIaMsg?.data_criacao
        ? Date.now() - new Date(lastIaMsg.data_criacao).getTime()
        : Infinity

      const isPromptAnswer = !!lastIaMsg?.conteudo?.includes('Cardápio Oficial de Domingo') && promptAgeMs < 30 * 60 * 1000
      if (isPromptAnswer) {
        const acaoRes = await processarAcaoInterativaWhatsApp({
          clienteId,
          telefone: sanitizedPhone,
          interactiveId: 'catalog:view',
          supabaseClient: supabaseAdmin,
        })

        if (acaoRes.handled && acaoRes.error) {
          console.error('[Evolution Webhook] CATALOG_CARDS_FAILED', acaoRes.error)
        }

        if (acaoRes.handled && acaoRes.respostaTexto) {
          try {
            await sendEvolutionScheduleMessage(sanitizedPhone, acaoRes.respostaTexto)
            await supabaseAdmin.from('mensagens').insert({
              conversa_id: conversaId,
              remetente: 'ia',
              conteudo: acaoRes.respostaTexto,
            })
          } catch {
            console.error('[Evolution Webhook] CATALOG_FALLBACK_REPLY_FAILED')
          }
        }

        return NextResponse.json({
          success: true,
          status: 'catalog_cards_delivered',
          data: novaMensagem,
        }, { status: 200 })
      }
    }

    // Catalog opt-in is handled before batching/RAG; keywords only send one prompt text.
    if (!norm?.interactiveId && /\b(card[aá]pio|menu|combos?)\b/i.test(textBody || caption || '')) {
      const prompt = await enviarPromptCatalogoWhatsApp(sanitizedPhone)
      if (!prompt.success) {
        console.error('[Evolution Webhook] CATALOG_PROMPT_FAILED', prompt.error)
      } else {
        try {
          const profile = await getBusinessProfile()
          await supabaseAdmin.from('mensagens').insert({
            conversa_id: conversaId,
            remetente: 'ia',
            conteudo: formatarPromptCatalogoTexto(profile),
          })
        } catch {
          console.error('[Evolution Webhook] CATALOG_PROMPT_PERSIST_FAILED')
        }
      }
      return NextResponse.json({
        success: prompt.success,
        status: prompt.success ? 'catalog_prompt_sent' : 'catalog_prompt_unavailable',
        data: novaMensagem,
      }, { status: 200 })
    }

    // 11. Never infer financial receipt from an attachment or payment-like text.
    // Only the canonical intake branch above may return payment_proof_received.

    // 12. Disparar RAG ou anexar a mensagem canônica já persistida.
    if (iaAtiva && conteudo && evolutionInboundBatchEnqueueEnabled()) {
      const attached = await attachPersistedSofiaInboundMessage({
        supabase: supabaseAdmin,
        messageId: novaMensagem.id,
        conversationId: conversaId,
        customerId: clienteId,
        channel: 'whatsapp',
      })
      if (!attached) console.error('[Evolution Webhook] SOFIA_BATCH_ATTACH_FAILED')
    } else if (iaAtiva && conteudo) {
      console.log('[Evolution Webhook] RAG_DISPATCHED')
      processarRagPipeline(conversaId, conteudo, 'whatsapp').catch(() => {
        console.error('[Evolution Webhook] RAG_BACKGROUND_FAILED')
      })
    }

    console.log('[Evolution Webhook] MESSAGE_PROCESSED')
    return NextResponse.json({
      success: true,
      message: 'Mensagem processada com sucesso',
      data: novaMensagem
    }, { status: 200 })

  } catch (error) {
    if (isRequestAborted(error)) {
      return NextResponse.json({ error: 'Request aborted' }, { status: 499 })
    }

    console.error('[Evolution Webhook] HANDLER_FAILED')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}
