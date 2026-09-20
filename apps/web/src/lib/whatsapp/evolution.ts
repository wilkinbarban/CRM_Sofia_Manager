import { ProvedorWhatsApp, EnviarMensagemPayload, ResultadoEnvio, validarJanelaEnvio, inferirTipoMidia, shouldPersistOutbound } from './provider'
import { obterConfiguracaoSistema } from '@/lib/config/sistema'
import { createAdminClient } from '@/lib/supabase/admin'
import { allowsIntegrationMock } from '@/lib/runtime/environment'
import { validarEnvioWhatsAppSafety } from './safety'
import { withSafeRetry } from './retry'
import { calcularDelayDigitacao } from './delays'
import { whatsappCircuitBreaker } from './circuit-breaker'
import { createEvolutionPresence, type EvolutionPresenceEvent } from './evolution-presence'
import { evolutionHeaders } from './evolution-headers'

export function evolutionMaxRetries(payload: EnviarMensagemPayload): number {
  return payload.salvarNoBanco === false ? 0 : 2
}
function isEvolutionMockMode(apiUrl: string | null, apiKey: string | null, instanceName: string | null): boolean {
  if (!apiUrl || !apiKey || !instanceName) return true
  
  const placeholders = [
    'placeholder',
    'your_evolution_api_url',
    'your_evolution_api_key',
    'your_evolution_instance_name',
    'your_api_key',
    'your_instance_name',
    'insert_here',
    'your-'
  ]

  const lowerUrl = apiUrl.toLowerCase()
  const lowerKey = apiKey.toLowerCase()
  const lowerInstance = instanceName.toLowerCase()

  return placeholders.some(p => lowerUrl.includes(p) || lowerKey.includes(p) || lowerInstance.includes(p))
}

/**
 * Envia uma mensagem utilizando a Evolution API (texto ou mídia)
 */
export async function enviarMensagemEvolution(
  conversaId: string,
  payload: EnviarMensagemPayload
): Promise<ResultadoEnvio> {
  // 1. Obter configurações da Evolution API
  const apiUrl = await obterConfiguracaoSistema('EVOLUTION_API_URL')
  const apiKey = await obterConfiguracaoSistema('EVOLUTION_API_KEY')
  const instanceName = await obterConfiguracaoSistema('EVOLUTION_INSTANCE_NAME')

  const mockMode = isEvolutionMockMode(apiUrl, apiKey, instanceName)
  const supabase = createAdminClient()

  // 2. Validar janela de envio e obter telefone do cliente
  const { telefone } = await validarJanelaEnvio(conversaId, payload)

  // 3. Safety Gate: Validar permissão prévia do envio
  const { data: conversa } = await supabase
    .from('conversas')
    .select('id, cliente_id')
    .eq('id', conversaId)
    .single()

  if (conversa?.cliente_id) {
    const safety = await validarEnvioWhatsAppSafety({
      supabase,
      clienteId: conversa.cliente_id,
      conversaId,
      texto: payload.texto,
      categoria: payload.categoria || 'REACTIVE',
      origem: payload.remetente || 'ia',
    })

    if (!safety.permitido) {
      console.warn(`[Evolution Send Safety Gate] Envio bloqueado: ${safety.motivo} (cliente: ${conversa.cliente_id})`)
      return {
        sucesso: false,
        whatsappMensagemId: null,
        safetyBlocked: true,
        motivo: safety.motivo,
        error: `Bloqueado pelo Safety Gate: ${safety.motivo}`,
      }
    }
  }

  let whatsappMensagemId = ''
  let conteudoFinal = payload.texto || null

  if (payload.templateName) {
    const paramsStr = payload.templateParams && payload.templateParams.length > 0
      ? ` - ${payload.templateParams.join(', ')}`
      : ''
    conteudoFinal = `[Template: ${payload.templateName}]${paramsStr}`
  }

  if (mockMode) {
    if (!allowsIntegrationMock()) {
      return {
        sucesso: false,
        whatsappMensagemId: null,
        error: 'Evolution API não configurada para este ambiente.',
      }
    }

    const mockIdSuffix = Math.random().toString(36).substring(2).toUpperCase()
    whatsappMensagemId = `evolution-${mockIdSuffix}`
    console.warn(`[Evolution Send Utility] Rodando em modo MOCK. Mensagem simulada com ID: ${whatsappMensagemId}`)
  } else {
    // Modo Real: Enviar HTTP Request para a Evolution API com reintentos seguros controlados
    const cleanUrl = apiUrl!.replace(/\/$/, '')
    let url = ''
    let bodyData: any = {}

    if (payload.anexoPath) {
      // Obter URL assinada
      const { data: signedData, error: signError } = await supabase
        .storage
        .from('chat-midias')
        .createSignedUrl(payload.anexoPath, 3600)

      if (signError || !signedData) {
        throw new Error(`Erro ao gerar URL assinada para o anexo: ${signError?.message || 'Sem URL'}`)
      }

      const tipoMidia = inferirTipoMidia(payload.anexoPath)
      const filename = payload.anexoPath.split('/').pop() || 'arquivo'

      url = `${cleanUrl}/message/sendMedia/${instanceName}`
      bodyData = {
        number: telefone,
        caption: payload.texto || '',
        mediaMessage: {
          mediatype: tipoMidia,
          media: signedData.signedUrl,
          fileName: filename
        }
      }
    } else {
      // Mensagem de Texto (ou Template formatado como texto)
      const typingDelayMs = payload.typingDelayMs ?? calcularDelayDigitacao(conteudoFinal)
      url = `${cleanUrl}/message/sendText/${instanceName}`
      bodyData = {
        number: telefone,
        ...(payload.salvarNoBanco === false ? {} : { delay: typingDelayMs }),
        text: conteudoFinal || '',
      }
    }

    const response = await whatsappCircuitBreaker.executar(async () => {
      return withSafeRetry(async () => {
        const res = await fetch(url, {
          method: 'POST',
          headers: evolutionHeaders(apiKey!),
          body: JSON.stringify(bodyData)
        })

        if (!res.ok) {
          await res.text().catch(() => '')
          throw new Error(`HTTP ${res.status} Erro na Evolution API (${res.statusText})`)
        }

        return res
      }, { maxRetries: evolutionMaxRetries(payload), baseDelayMs: 1000 })
    })

    const responseData = await response.json()
    whatsappMensagemId = responseData.key?.id

    if (!whatsappMensagemId) {
      throw new Error('ID da mensagem não retornado pela Evolution API.')
    }
  }

  // 4. Salvar no banco, exceto quando uma intenção durável já possui a mensagem.
  let novaMensagem = null
  if (shouldPersistOutbound(payload)) {
    const remetente = payload.remetente || 'ia'
    const { data, error: insertError } = await supabase.from('mensagens').insert({
      conversa_id: conversaId, remetente, conteudo: conteudoFinal,
      url_anexo: payload.anexoPath || null, whatsapp_mensagem_id: whatsappMensagemId
    }).select().single()
    if (insertError) throw new Error(`Erro ao salvar mensagem no banco de dados: ${insertError.message}`)
    novaMensagem = data
  }

  // 5. Atualizar timestamp de envio na governança de contatos
  if (conversa?.cliente_id) {
    try {
      await supabase.rpc('atualizar_interacao_cliente', {
        p_cliente_id: conversa.cliente_id,
        p_direcao: payload.categoria === 'CARDAPIO' ? 'cardapio' : 'outbound',
      })
    } catch (err: any) {
      console.warn('[Evolution Send] Erro ao atualizar interação do cliente:', err?.message || err)
    }
  }

  return {
    sucesso: true,
    whatsappMensagemId,
    mensagem: novaMensagem
  }
}

export async function startEvolutionPresence(
  conversaId: string,
  observe?: (event: EvolutionPresenceEvent) => void | Promise<void>,
): Promise<{ stop: () => void }> {
  const apiUrl = await obterConfiguracaoSistema('EVOLUTION_API_URL')
  const apiKey = await obterConfiguracaoSistema('EVOLUTION_API_KEY')
  const instanceName = await obterConfiguracaoSistema('EVOLUTION_INSTANCE_NAME')
  if (isEvolutionMockMode(apiUrl, apiKey, instanceName)) return { stop: () => undefined }
  const { telefone } = await validarJanelaEnvio(conversaId, { texto: '', templateName: 'presence' })
  const cleanUrl = apiUrl!.replace(/\/$/, '')
  return createEvolutionPresence({
    observe,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    send: async () => {
      const response = await fetch(`${cleanUrl}/chat/sendPresence/${instanceName}`, {
        method: 'POST', headers: evolutionHeaders(apiKey!),
        body: JSON.stringify({ number: telefone, presence: 'composing', delay: 4000 }),
      })
      if (!response.ok) return false
      const body: unknown = await response.json().catch(() => null)
      return !!body && typeof body === 'object' && (body as { presence?: unknown }).presence === 'composing'
    },
  })
}

export class EvolutionProvider implements ProvedorWhatsApp {
  async enviarMensagem(conversaId: string, payload: EnviarMensagemPayload): Promise<ResultadoEnvio> {
    return enviarMensagemEvolution(conversaId, payload)
  }

  async iniciarPresenca(
    conversaId: string,
    observe?: (event: EvolutionPresenceEvent) => void
  ): Promise<{ stop: () => void }> {
    return startEvolutionPresence(conversaId, observe)
  }
}

/**
 * Envia um código OTP diretamente para um número de telefone de destino via Evolution API
 * Não exige conversaId prévia nem vinculação de janela de atendimento.
 */
export async function sendOtpEvolution(
  destination: string,
  code: string
): Promise<{ sucesso: boolean; whatsappMensagemId?: string | null; error?: string }> {
  try {
    const apiUrl = await obterConfiguracaoSistema('EVOLUTION_API_URL')
    const apiKey = await obterConfiguracaoSistema('EVOLUTION_API_KEY')
    const instanceName = await obterConfiguracaoSistema('EVOLUTION_INSTANCE_NAME')

    const mockMode = isEvolutionMockMode(apiUrl, apiKey, instanceName)

    if (mockMode) {
      if (!allowsIntegrationMock()) {
        return {
          sucesso: false,
          whatsappMensagemId: null,
          error: 'Evolution API não configurada para este ambiente.',
        }
      }
      const mockId = `evo-otp-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`
      return { sucesso: true, whatsappMensagemId: mockId }
    }

    const url = `${apiUrl}/message/sendText/${instanceName}`
    const text = `🔐 *Código de Verificação — CRM Sofia Manager*\n\nSeu código é: *${code}*\n\n⏳ Válido por *10 minutos*. Se você não solicitou, desconsidere.`

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'apikey': apiKey!,
        'Content-Type': 'application/json',
        'Origin': process.env.NEXT_PUBLIC_APP_URL || 'https://crmsofiamanager.duckdns.org'
      },
      body: JSON.stringify({
        number: destination,
        options: { delay: 500, presence: 'composing' },
        text
      })
    })

    if (!response.ok) {
      await response.text().catch(() => '')
      return {
        sucesso: false,
        error: `Erro na Evolution API (${response.statusText}): `
      }
    }

    const responseData = await response.json()
    const msgId = responseData.key?.id || `evo-${Date.now()}`
    return { sucesso: true, whatsappMensagemId: msgId }
  } catch (err: any) {
    return { sucesso: false, error: err.message || 'Erro inesperado na Evolution API' }
  }
}
