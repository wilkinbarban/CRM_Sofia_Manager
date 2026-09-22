/**
 * Chamada JSON ao modelo economico — usado pela extracao de memoria de cliente.
 *
 * Resolve a chave e o modelo DeepSeek pela mesma precedência única usada no
 * resto do servidor (`configuracoes_sistema` primeiro, `process.env` depois,
 * modelo padrão `deepseek-flash`) através de `resolverChaveDeepSeek` e
 * `resolverModeloDeepSeek`, e delega a chamada de provedor a
 * `chamarDeepSeekChat`, o único ponto de contato com a DeepSeek. O JSON e pedido
 * por `response_format` e pelo prompt, de modo que o parser e a unica autoridade
 * de schema.
 *
 * Nunca lanca: qualquer falha (chave ausente, HTTP, timeout, corpo invalido,
 * resposta vazia ou grande demais) devolve `null`, e quem chama decide o que
 * registrar.
 */

import { chamarDeepSeekChat, isUsableDeepSeekApiKey, resolverChaveDeepSeek, resolverModeloDeepSeek } from '@/lib/ai/deepseek'

export interface ModeloEconomicoJsonParams {
  system: string
  user: string
  maxTokens: number
  timeoutMs: number
}

/**
 * Resolve a chave DeepSeek pela regra única do restante do servidor: um valor
 * armazenado utilizável primeiro, um valor de ambiente utilizável depois, vazio
 * por último. Um valor armazenado inutilizável (vazio, só espaços ou placeholder
 * conhecido) é tratado como ausente e cede a vez ao ambiente.
 */
export async function chamarModeloEconomicoJson(
  params: ModeloEconomicoJsonParams,
): Promise<string | null> {
  try {
    const apiKey = await resolverChaveDeepSeek()
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
