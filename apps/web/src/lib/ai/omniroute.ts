/**
 * OmniRoute Gateway Client — CRM Sofia Manager
 * Comunicação com gateway local OpenAI-compatible em 127.0.0.1:20128
 */

export interface OmniRouteChatParams {
  model: string // 'business-economy' | 'business-smart' | 'business-frontier'
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  temperature?: number
  maxTokens?: number
}

export interface OmniRouteChatResult {
  success: boolean
  content?: string
  modelResoluvel?: string
  error?: string
  latenciaMs: number
}

export function isOmniRouteEnabled(): boolean {
  return process.env.AI_ROUTING_V2_ENABLED === 'true'
}

export function isLegacyFallbackEnabled(): boolean {
  return process.env.AI_ROUTING_LEGACY_FALLBACK_ENABLED !== 'false'
}

export async function chamarOmniRouteGateway(
  params: OmniRouteChatParams
): Promise<OmniRouteChatResult> {
  const inicio = Date.now()
  const baseUrl = (process.env.OMNIROUTE_BASE_URL || 'http://127.0.0.1:20128').replace(/\/$/, '')
  const apiKey = process.env.OMNIROUTE_API_KEY || ''

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5000)

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`
    }

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: params.model,
        messages: params.messages,
        temperature: params.temperature ?? 0.1,
        max_tokens: params.maxTokens,
      }),
      signal: controller.signal,
    })

    clearTimeout(timeoutId)
    const latenciaMs = Date.now() - inicio

    if (!response.ok) {
      const errBody = await response.text().catch(() => '')
      return {
        success: false,
        error: `HTTP_${response.status}: ${errBody || response.statusText}`,
        latenciaMs,
      }
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content?.trim() || ''

    if (!content) {
      return {
        success: false,
        error: 'RESPOSTA_VAZIA_OMNIROUTE',
        latenciaMs,
      }
    }

    return {
      success: true,
      content,
      modelResoluvel: data.model || params.model,
      latenciaMs,
    }
  } catch (err: any) {
    clearTimeout(timeoutId)
    const latenciaMs = Date.now() - inicio
    const isTimeout = err.name === 'AbortError' || err.message?.includes('aborted')

    return {
      success: false,
      error: isTimeout ? 'TIMEOUT_OMNIROUTE' : (err.message || 'ERRO_DESCONHECIDO'),
      latenciaMs,
    }
  }
}
