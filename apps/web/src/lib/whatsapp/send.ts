import { obterConfiguracaoSistema } from '@/lib/config/sistema'
import { allowsIntegrationMock } from '@/lib/runtime/environment'
import { ProvedorWhatsApp, EnviarMensagemPayload, ResultadoEnvio, obterProvedorAtivo, validarJanelaEnvio, inferirTipoMidia, shouldPersistOutbound } from './provider'
import { validarEnvioWhatsAppSafety } from './safety'

export type { EnviarMensagemPayload }

function isMockMode(token: string | null, phoneId: string | null): boolean {
  if (!token || !phoneId) return true

  const placeholders = [
    'placeholder',
    'your_whatsapp_access_token',
    'your_whatsapp_phone_number_id',
    'your_access_token',
    'your_phone_number_id',
    'insert_here',
    'your-',
    '123456789'
  ]

  const lowerToken = token.toLowerCase()
  const lowerPhoneId = phoneId.toLowerCase()

  return placeholders.some(p => lowerToken.includes(p) || lowerPhoneId.includes(p))
}

/**
 * Envia uma mensagem utilizando a API Cloud da Meta
 */
export async function enviarMensagemMeta(
  conversaId: string,
  payload: EnviarMensagemPayload
): Promise<ResultadoEnvio> {
  const { telefone, supabase } = await validarJanelaEnvio(conversaId, payload)

  // Safety Gate: Validar permissão prévia do envio
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
      console.warn(`[Meta Send Safety Gate] Envio bloqueado: ${safety.motivo} (cliente: ${conversa.cliente_id})`)
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

  const token = await obterConfiguracaoSistema('WHATSAPP_ACCESS_TOKEN')
  const phoneId = await obterConfiguracaoSistema('WHATSAPP_PHONE_NUMBER_ID')
  const mockMode = isMockMode(token, phoneId)

  if (mockMode) {
    if (!allowsIntegrationMock()) {
      return {
        sucesso: false,
        whatsappMensagemId: null,
        error: 'WhatsApp Cloud API não configurada para este ambiente.',
      }
    }

    // Modo Mock: Simular a chamada da Meta Cloud API
    const mockIdSuffix = Math.random().toString(36).substring(2).toUpperCase()
    whatsappMensagemId = `wamid.HBgMNDUxOTk5OTk5OTk5FQIAERg${mockIdSuffix}`
    console.warn(`[WhatsApp Send Utility] Rodando em modo MOCK. Mensagem simulada com ID: ${whatsappMensagemId}`)
  } else {
    // Chamada real para a Meta Cloud API
    const url = `https://graph.facebook.com/v18.0/${phoneId}/messages`

    const bodyData: any = {
      messaging_product: 'whatsapp',
      to: telefone,
      recipient_type: 'individual'
    }

    if (payload.templateName) {
      bodyData.type = 'template'
      bodyData.template = {
        name: payload.templateName,
        language: {
          code: 'pt_BR'
        }
      }
      if (payload.templateParams && payload.templateParams.length > 0) {
        bodyData.template.components = [
          {
            type: 'body',
            parameters: payload.templateParams.map(param => ({
              type: 'text',
              text: String(param)
            }))
          }
        ]
      }
    } else if (payload.anexoPath) {
      // Gerar a URL assinada temporária para o bucket chat-midias
      const { data: signedData, error: signError } = await supabase
        .storage
        .from('chat-midias')
        .createSignedUrl(payload.anexoPath, 3600) // 1 hora de expiração

      if (signError || !signedData) {
        throw new Error(`Erro ao gerar URL assinada para o anexo: ${signError?.message || 'Sem URL'}`)
      }

      const tipoMidia = inferirTipoMidia(payload.anexoPath)
      bodyData.type = tipoMidia
      bodyData[tipoMidia] = {
        link: signedData.signedUrl
      }
    } else if (payload.texto) {
      bodyData.type = 'text'
      bodyData.text = {
        body: payload.texto
      }
    } else {
      throw new Error('Conteúdo inválido: forneça texto, anexoPath ou templateName para o envio.')
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(bodyData)
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(`Erro na API da Meta: ${response.statusText}. Detalhes: ${JSON.stringify(errorData)}`)
    }

    const responseData = await response.json()
    whatsappMensagemId = responseData.messages?.[0]?.id

    if (!whatsappMensagemId) {
      throw new Error('ID da mensagem não retornado pela API da Meta.')
    }
  }

  // 5. Salvar a mensagem enviada no banco de dados, exceto para intenção já persistida.
  let novaMensagem = null
  if (shouldPersistOutbound(payload)) {
    const remetente = payload.remetente || 'ia'
    const { data, error: insertError } = await supabase.from('mensagens').insert({
      conversa_id: conversaId, remetente,
      conteudo: payload.templateName ? `[Template: ${payload.templateName}]${payload.texto ? ` - ${payload.texto}` : ''}` : payload.texto || null,
      url_anexo: payload.anexoPath || null, whatsapp_mensagem_id: whatsappMensagemId
    }).select().single()
    if (insertError) throw new Error(`Erro ao salvar mensagem no banco de dados: ${insertError.message}`)
    novaMensagem = data
  }

  return {
    sucesso: true,
    whatsappMensagemId,
    mensagem: novaMensagem
  }
}

export class MetaProvider implements ProvedorWhatsApp {
  async enviarMensagem(conversaId: string, payload: EnviarMensagemPayload): Promise<ResultadoEnvio> {
    return enviarMensagemMeta(conversaId, payload)
  }
}

/**
 * Função principal para envio de mensagens do WhatsApp, roteando via provedor ativo
 */
export async function enviarMensagemWhatsapp(
  conversaId: string,
  payload: EnviarMensagemPayload
): Promise<ResultadoEnvio> {
  const provedor = await obterProvedorAtivo()
  return provedor.enviarMensagem(conversaId, payload)
}

/**
 * Envia um código OTP diretamente para um número de telefone de destino via Meta Cloud API
 * Não exige conversaId prévia nem vinculação de janela de atendimento.
 */
export async function sendOtpMeta(
  destination: string,
  code: string
): Promise<{ sucesso: boolean; whatsappMensagemId?: string | null; error?: string }> {
  try {
    const token = await obterConfiguracaoSistema('WHATSAPP_ACCESS_TOKEN')
    const phoneId = await obterConfiguracaoSistema('WHATSAPP_PHONE_NUMBER_ID')
    const mockMode = isMockMode(token, phoneId)

    if (mockMode) {
      if (!allowsIntegrationMock()) {
        return {
          sucesso: false,
          whatsappMensagemId: null,
          error: 'WhatsApp Cloud API não configurada para este ambiente.',
        }
      }
      const mockId = `wamid.HBgM${Date.now()}${Math.random().toString(36).substring(2, 7)}`
      return { sucesso: true, whatsappMensagemId: mockId }
    }

    const url = `https://graph.facebook.com/v18.0/${phoneId}/messages`
    const bodyData = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: destination,
      type: 'text',
      text: {
        preview_url: false,
        body: `🔐 Código de Verificação — CRM Sofia Manager\n\nSeu código é: ${code}\n\n⏳ Válido por 10 minutos.`
      }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(bodyData),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      return {
        sucesso: false,
        error: `Erro na API da Meta (${response.statusText}): ${JSON.stringify(errorData)}`
      }
    }

    const responseData = await response.json()
    const msgId = responseData.messages?.[0]?.id || `wamid.${Date.now()}`
    return { sucesso: true, whatsappMensagemId: msgId }
  } catch (err: any) {
    return { sucesso: false, error: err.message || 'Erro inesperado na API da Meta' }
  }
}

