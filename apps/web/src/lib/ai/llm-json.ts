/**
 * Chamada JSON ao modelo economico — usado pela extracao de memoria de cliente.
 *
 * Resolve a chave e o modelo DeepSeek pela mesma precedencia usada no resto do
 * servidor (`configuracoes_sistema` primeiro, `process.env` depois, modelo
 * padrao `deepseek-flash`) e delega a chamada de provedor a
 * `chamarDeepSeekChat`, o unico ponto de contato com a DeepSeek. O JSON e pedido
 * por `response_format` e pelo prompt, de modo que o parser e a unica autoridade
 * de schema.
 *
 * Nunca lanca: qualquer falha (chave ausente, HTTP, timeout, corpo invalido,
 * resposta vazia ou grande demais) devolve `null`, e quem chama decide o que
 * registrar.
 */

import { chamarDeepSeekChat, isUsableDeepSeekApiKey, resolverModeloDeepSeek } from '@/lib/ai/deepseek'
import { obterConfiguracaoSistema } from '@/lib/config/sistema'

export interface ModeloEconomicoJsonParams {
  system: string
  user: string
  maxTokens: number
  timeoutMs: number
}

/** Resolve a chave DeepSeek com a mesma precedencia do restante do servidor. */
async function obterChaveDeepSeek(): Promise<string> {
  const configurada = await obterConfiguracaoSistema('DEEPSEEK_API_KEY')
  return configurada || process.env.DEEPSEEK_API_KEY || ''
}

export async function chamarModeloEconomicoJson(
  params: ModeloEconomicoJsonParams,
): Promise<string | null> {
  try {
    const apiKey = await obterChaveDeepSeek()
    if (!isUsableDeepSeekApiKey(apiKey)) return null

    const resultado = await chamarDeepSeekChat({
      apiKey,
      model: await resolverModeloDeepSeek(),
      messages: [
        { role: 'system', content: params.system },
        { role: 'user', content: params.user },
      ],
      temperature: 0,
      maxTokens: params.maxTokens,
      timeoutMs: params.timeoutMs,
      jsonResponse: true,
    })

    return resultado.success ? resultado.content : null
  } catch {
    return null
  }
}
