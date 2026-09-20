/**
 * Chamada JSON ao modelo economico — usado pela extracao de memoria de cliente.
 *
 * Resolve o provedor do mesmo modo que `openrouter.ts`: OmniRoute quando
 * `AI_ROUTING_V2_ENABLED === 'true'`, senao o caminho legado OpenRouter/DeepSeek
 * com a mesma deteccao de `sk-or-` e `OPENROUTER_MODEL` de
 * `obterConfiguracaoSistema`. O JSON e pedido pelo prompt nos dois caminhos, de
 * modo que o parser e a unica autoridade de schema.
 *
 * Nunca lanca: qualquer falha (provedor indisponivel, HTTP, timeout, corpo
 * invalido) devolve `null`, e quem chama decide o que registrar.
 */

import { chamarOmniRouteGateway, isOmniRouteEnabled } from '@/lib/ai/omniroute'
import { obterConfiguracaoSistema } from '@/lib/config/sistema'

export interface ModeloEconomicoJsonParams {
  system: string
  user: string
  maxTokens: number
  timeoutMs: number
}

async function chamarLegadoJson(params: ModeloEconomicoJsonParams): Promise<string | null> {
  const apiKey = await obterConfiguracaoSistema('OPENROUTER_API_KEY')
  if (!apiKey) return null

  const isDeepSeek = !apiKey.includes('sk-or-') && apiKey.startsWith('sk-')

  const apiUrl = isDeepSeek
    ? 'https://api.deepseek.com/chat/completions'
    : 'https://openrouter.ai/api/v1/chat/completions'

  const model = isDeepSeek
    ? 'deepseek-chat'
    : (await obterConfiguracaoSistema('OPENROUTER_MODEL')) || 'google/gemini-2.5-flash'

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }

  if (!isDeepSeek) {
    headers['HTTP-Referer'] = 'https://github.com/wilkin/proyectos/Asados'
    headers['X-Title'] = 'CRM Sofia Manager'
  }

  const response = await fetch(apiUrl, {
    method: 'POST',
    signal: AbortSignal.timeout(params.timeoutMs),
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: params.system },
        { role: 'user', content: params.user },
      ],
      temperature: 0,
      max_tokens: params.maxTokens,
    }),
  })

  if (!response.ok) return null

  const data = await response.json()
  const content = data?.choices?.[0]?.message?.content
  return typeof content === 'string' && content.trim() !== '' ? content.trim() : null
}

export async function chamarModeloEconomicoJson(
  params: ModeloEconomicoJsonParams,
): Promise<string | null> {
  try {
    if (isOmniRouteEnabled()) {
      const resultado = await chamarOmniRouteGateway({
        model: 'business-economy',
        messages: [
          { role: 'system', content: params.system },
          { role: 'user', content: params.user },
        ],
        temperature: 0,
        maxTokens: params.maxTokens,
      })
      return resultado.success && resultado.content ? resultado.content : null
    }

    return await chamarLegadoJson(params)
  } catch {
    return null
  }
}
