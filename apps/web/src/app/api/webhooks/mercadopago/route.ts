import { NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { obterConfiguracaoSistema } from '@/lib/config/sistema'
import { allowsIntegrationMock } from '@/lib/runtime/environment'

const MERCADO_PAGO_MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000

export interface ResultadoPagamentoMercadoPago {
  pedido_id: string
  status_pagamento: 'aprovado' | 'rejeitado' | 'pendente' | 'reembolsado'
  idempotent: boolean
}

function parseMercadoPagoSignature(header: string | null): { timestamp: string; signature: string } | null {
  if (!header) return null

  const entries = new Map(
    header.split(',').map((entry) => {
      const [key, value] = entry.trim().split('=', 2)
      return [key, value]
    })
  )
  const timestamp = entries.get('ts')
  const signature = entries.get('v1')

  return timestamp && signature ? { timestamp, signature } : null
}

function isMercadoPagoSignatureTimestampFresh(timestamp: string): boolean {
  if (!/^\d{10}$|^\d{13}$/.test(timestamp)) return false

  const timestampMs = timestamp.length === 10 ? Number(timestamp) * 1000 : Number(timestamp)
  if (!Number.isSafeInteger(timestampMs)) return false

  const receivedAtMs = Date.now()
  return timestampMs <= receivedAtMs && receivedAtMs - timestampMs <= MERCADO_PAGO_MAX_SIGNATURE_AGE_MS
}

export function isMercadoPagoWebhookSignatureValid(
  xSignature: string | null,
  xRequestId: string | null,
  dataId: string | null,
  secret: string | null,
): boolean {
  if (!xRequestId || !dataId || !secret) return false

  const parsed = parseMercadoPagoSignature(xSignature)
  if (!parsed || !isMercadoPagoSignatureTimestampFresh(parsed.timestamp) || !/^[a-f0-9]{64}$/i.test(parsed.signature)) return false

  const manifest = `id:${dataId};request-id:${xRequestId};ts:${parsed.timestamp};`
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex')
  const received = Buffer.from(parsed.signature, 'hex')
  const expectedBuffer = Buffer.from(expected, 'hex')

  return received.length === expectedBuffer.length && crypto.timingSafeEqual(received, expectedBuffer)
}

export function isMercadoPagoAccessTokenConfigured(token: string | undefined): boolean {
  if (!token) return false

  return ![
    'placeholder',
    'insert_here',
    'seu_access_token_mercado_pago_aqui',
    'your_access_token',
  ].some((placeholder) => token.toLowerCase().includes(placeholder))
}

/**
 * Auxiliar para obter um ID ofuscado para logs seguros.
 */
function obfuscateId(id: string | null | undefined): string {
  if (!id) return 'null'
  if (id.length <= 8) return '********'
  return id.substring(0, 8) + '...'
}

/**
 * Executa o processamento do pagamento em background assíncrono.
 * Garante que nenhuma PII ou segredos sejam logados de forma insegura.
 */
export interface MercadoPagoBackgroundDependencies {
  resolvePayment?: (paymentId: string, pedidoIdMock?: string | null) => Promise<{ status: string | null; pedidoId: string | null }>
  completeDelivery?: (requestId: string, paymentId: string) => Promise<boolean>
  providerDeliveryId?: string
  failDelivery?: (requestId: string, paymentId: string, error: string) => Promise<boolean>
}

export interface MercadoPagoDeliveryContext {
  requestId: string
  providerDeliveryId?: string
}

export async function processarPagamentoBackground(
  paymentId: string,
  pedidoIdMock?: string | null,
  dependencies: MercadoPagoBackgroundDependencies = {},
  delivery?: MercadoPagoDeliveryContext,
): Promise<boolean> {
  const supabaseAdmin = createAdminClient()
  const failDelivery = async (message: string) => {
    if (delivery) {
      await (dependencies.failDelivery ?? (async (requestId, id, error) => {
        const { data } = await supabaseAdmin.rpc('falhar_webhook_mercado_pago', {
          p_request_id: requestId,
          p_payment_id: id,
          p_error: error,
        })
        return data === true
      }))(delivery.requestId, paymentId, message)
    }
  }
  const completeDelivery = async () => {
    if (!delivery) return true
    const completed = await (dependencies.completeDelivery ?? (async (requestId, id) => {
      const { data } = await supabaseAdmin.rpc('concluir_webhook_mercado_pago', {
        p_request_id: requestId,
        p_payment_id: id,
      })
      return data === true
    }))(delivery.requestId, paymentId)
    if (!completed) await failDelivery('DELIVERY_COMPLETION_UNAVAILABLE')
    return completed
  }

  try {
    const paymentIdLog = obfuscateId(paymentId)
    console.log(`[MercadoPago Webhook] [BG] Iniciando processamento do pagamento ${paymentIdLog}`)

    const token = (await obterConfiguracaoSistema('MERCADO_PAGO_ACCESS_TOKEN')) || process.env.MERCADO_PAGO_ACCESS_TOKEN
    const isPlaceholder = !isMercadoPagoAccessTokenConfigured(token || undefined)

    let status: string | null = null
    let pedidoId: string | null = null

    // Tratamento especial para teste de webhook simulado do portal Mercado Pago Developers
    if (paymentId === '123456') {
      console.log(`[MercadoPago Webhook] [BG] Teste simulado do portal de desenvolvedores (ID 123456) validado com sucesso.`)
      return completeDelivery()
    }

    if (dependencies.resolvePayment) {
      ({ status, pedidoId } = await dependencies.resolvePayment(paymentId, pedidoIdMock))
    } else if (isPlaceholder) {
      if (!allowsIntegrationMock()) {
        console.error(`[MercadoPago Webhook] [BG] Credenciais indisponíveis para processar ${paymentIdLog}.`)
        await failDelivery('CREDENCIAIS_INDISPONIVEIS')
        return false
      }

      // MOCK MODE
      console.log(`[MercadoPago Webhook] [BG] Rodando em modo MOCK devido a token ausente ou placeholder.`)
      
      if (paymentId.includes('approved')) {
        status = 'approved'
      } else if (paymentId.includes('rejected')) {
        status = 'rejected'
      } else if (paymentId.includes('cancelled')) {
        status = 'cancelled'
      } else {
        // Fallback default
        status = 'approved'
      }

      pedidoId = pedidoIdMock || null
    } else {
      // MODO REAL
      const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })

      if (!response.ok) {
        const errorMsg = `HTTP Error ${response.status} ao consultar API do Mercado Pago`
        console.error(`[MercadoPago Webhook] [BG] Falha ao consultar pagamento ${paymentIdLog}: ${errorMsg}`)
        await failDelivery(errorMsg)
        return false
      }

      const paymentData = await response.json()
      status = paymentData.status
      pedidoId = paymentData.external_reference
    }

    if (!pedidoId) {
      console.error(`[MercadoPago Webhook] [BG] Cancelando processamento: 'external_reference' (pedidoId) nao encontrado para o pagamento ${paymentIdLog}.`)
      await failDelivery('PEDIDO_NAO_ENCONTRADO_NA_REFERENCIA_EXTERNA')
      return false
    }

    if (!status) {
      console.error(`[MercadoPago Webhook] [BG] Cancelando processamento: 'status' nao encontrado para o pagamento ${paymentIdLog}.`)
      await failDelivery('STATUS_DE_PAGAMENTO_AUSENTE')
      return false
    }

    const pedidoIdLog = obfuscateId(pedidoId)
    console.log(`[MercadoPago Webhook] [BG] Pagamento ${paymentIdLog} resolvido. Status: ${status}, Pedido: ${pedidoIdLog}`)

    let statusPagamentoBanco: 'aprovado' | 'rejeitado' | 'reembolsado' | null = null

    if (status === 'approved') {
      statusPagamentoBanco = 'aprovado'
    } else if (status === 'rejected' || status === 'cancelled') {
      statusPagamentoBanco = 'rejeitado'
    } else if (status === 'refunded' || status === 'charged_back') {
      statusPagamentoBanco = 'reembolsado'
    }

    if (!statusPagamentoBanco) {
      console.log(`[MercadoPago Webhook] [BG] Status de pagamento '${status}' nao requer atualizacao para o pedido ${pedidoIdLog}.`)
      return completeDelivery()
    }

    // The service-role client owns the durable claim completion and payment write.

    console.log(`[MercadoPago Webhook] [BG] Registrando pagamento auditado para pedido ${pedidoIdLog}...`)
    const { data: paymentResult, error: updateError } = await supabaseAdmin
      .rpc('registrar_status_pagamento', {
        p_pedido_id: pedidoId,
        p_novo_status: statusPagamentoBanco,
        p_source: 'mercado_pago',
        p_external_reference: paymentId,
        p_reason: null,
        p_provider_delivery_id: delivery?.providerDeliveryId ?? delivery?.requestId ?? paymentId,
      })
      .single()

    if (updateError) {
      console.error(`[MercadoPago Webhook] [BG] Erro ao atualizar pedido ${pedidoIdLog} no banco: ${updateError?.message || 'Pedido nao encontrado'}`)
      await failDelivery(updateError?.message || 'REGISTRO_DE_PAGAMENTO_INDISPONIVEL')
      return false
    }

    // The audited payment row is the only evidence this delivery may complete on.
    const resultadoPagamento = paymentResult as ResultadoPagamentoMercadoPago | null

    if (!resultadoPagamento) {
      console.info(`[MercadoPago Webhook] [BG] Resultado de pagamento ausente para o pedido ${pedidoIdLog}.`)
      await failDelivery('RESULTADO_DE_PAGAMENTO_AUSENTE')
      return false
    }

    console.log(`[MercadoPago Webhook] [BG] Pagamento auditado para pedido ${pedidoIdLog}.`)

    return completeDelivery()
  } catch (error: any) {
    // A failed claim is made pending again so the provider retry can recover it.
    console.error(`[MercadoPago Webhook] [BG] Erro critico no loop de background: ${error.message || 'Sem mensagem'}`)
    await failDelivery(error?.message || 'PROCESSAMENTO_FALHOU').catch(() => undefined)
    return false
  }
}

/**
 * Route Handler para receber notificacoes HTTP POST do Mercado Pago.
 */
export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const requestId = request.headers.get('x-request-id')
    const xSignature = request.headers.get('x-signature')

    // Ler do Body
    let body: any = null
    try {
      body = await request.clone().json()
    } catch {
      // Ignorar se nao for JSON ou estiver vazio
    }

    // Extrair dataId a partir de query params ou do payload JSON enviado pelo Mercado Pago
    const dataId =
      searchParams.get('data.id') ||
      (body?.data?.id ? String(body.data.id) : null) ||
      (body?.id ? String(body.id) : null) ||
      searchParams.get('id')

    const webhookSecret = await obterConfiguracaoSistema('MERCADO_PAGO_WEBHOOK_SECRET')

    if (!isMercadoPagoWebhookSignatureValid(
      xSignature,
      requestId,
      dataId,
      webhookSecret,
    )) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accessToken = (await obterConfiguracaoSistema('MERCADO_PAGO_ACCESS_TOKEN')) || process.env.MERCADO_PAGO_ACCESS_TOKEN

    if (!allowsIntegrationMock() && !isMercadoPagoAccessTokenConfigured(accessToken || undefined)) {
      return NextResponse.json({ error: 'payment_processing_unavailable' }, { status: 503 })
    }
    
    // Ler do Query Params ou Body
    const topic = searchParams.get('topic') || searchParams.get('type') || body?.type || body?.action
    const paymentId = dataId || searchParams.get('id') || (body?.data?.id ? String(body.data.id) : null) || (body?.id ? String(body.id) : null)
    const pedidoIdMock =
      searchParams.get('pedidoId') ||
      searchParams.get('pedido_id') ||
      searchParams.get('external_reference') ||
      body?.pedidoId ||
      body?.pedido_id ||
      body?.external_reference ||
      body?.data?.external_reference

    const paymentIdStr = paymentId ? String(paymentId) : null

    // Validar se e um topico de pagamento relevante
    const isPaymentTopic = !topic || topic === 'payment' || topic === 'payment.created' || topic === 'payment.updated'

    if (paymentIdStr && isPaymentTopic) {
      if (!requestId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }

      let admission: { data: boolean | null; error: { message: string } | null }
      try {
        admission = await createAdminClient().rpc('admitir_webhook_mercado_pago', {
          p_request_id: requestId,
          p_payment_id: paymentIdStr,
        })
      } catch {
        return NextResponse.json({ error: 'payment_delivery_unavailable' }, { status: 503 })
      }

      if (admission.error || admission.data === null) {
        return NextResponse.json({ error: 'payment_delivery_unavailable' }, { status: 503 })
      }

      let claim: { data: unknown; error: { message: string } | null }
      try {
        claim = await createAdminClient().rpc('reivindicar_webhook_mercado_pago', {
          p_request_id: requestId,
          p_payment_id: paymentIdStr,
          p_lease_seconds: 60,
        })
      } catch {
        return NextResponse.json({ error: 'payment_delivery_unavailable' }, { status: 503 })
      }

      const claimedDelivery = Array.isArray(claim.data) ? claim.data[0] : claim.data
      if (claim.error || !claimedDelivery) {
        return NextResponse.json({ error: 'payment_delivery_unavailable' }, { status: 503 })
      }

      if (!claimedDelivery.claimed) {
        return NextResponse.json(
          { status: claimedDelivery.delivery_status === 'completed' ? 'duplicate' : 'processing' },
          { status: claimedDelivery.delivery_status === 'completed' ? 200 : 503 },
        )
      }

      // Do not acknowledge a claim until processing reaches a terminal state.
      const processed = await processarPagamentoBackground(paymentIdStr, pedidoIdMock, {}, { requestId, providerDeliveryId: requestId })
      if (!processed) {
        return NextResponse.json({ error: 'payment_processing_retryable' }, { status: 503 })
      }
    } else {
      console.log(`[MercadoPago Webhook] [POST] Notificacao ignorada. Topico: ${topic || 'desconhecido'}, ID: ${obfuscateId(paymentIdStr)}`)
    }

    // 2.3 Responder imediatamente à requisicao do Mercado Pago com HTTP 200 OK
    return NextResponse.json({ status: 'received' }, { status: 200 })
  } catch (error: any) {
    // Unexpected delivery errors must remain retryable: a 2xx would lose the
    // provider retry before a durable terminal completion exists.
    console.error(`[MercadoPago Webhook] [POST] Erro ao tratar requisicao: ${error.message || 'Sem mensagem'}`)
    return NextResponse.json({ error: 'payment_delivery_unavailable' }, { status: 503 })
  }
}
