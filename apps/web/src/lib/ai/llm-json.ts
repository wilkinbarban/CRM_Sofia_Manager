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
 * registrar. O `timeoutMs` do chamador passa por `resolverTimeoutMs` antes de
 * chegar ao provedor, de modo que a requisicao sempre tem um limite positivo.
 */

import {
  chamarDeepSeekChat,
  DEEPSEEK_CHAT_TIMEOUT_MS,
  isUsableDeepSeekApiKey,
  resolverChaveDeepSeek,
  resolverModeloDeepSeek,
} from '@/lib/ai/deepseek'

export interface ModeloEconomicoJsonParams {
  system: string
  user: string
  maxTokens: number
  timeoutMs: number
}

/**
 * Normaliza o timeout do chamador para o inteiro positivo que
 * `AbortSignal.timeout` exige. Zero, negativo, fracionario ou nao-finito cai no
 * default do modulo: esses valores abortariam a requisicao na hora, fariam a
 * fabrica de signal lancar ou removeriam o limite por completo.
 */
function resolverTimeoutMs(timeoutMs: number): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEEPSEEK_CHAT_TIMEOUT_MS
  }
  return Math.max(1, Math.floor(timeoutMs))
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
      timeoutMs: resolverTimeoutMs(params.timeoutMs),
      jsonResponse: true,
    })

    return resultado.success ? resultado.content : null
  } catch {
    return null
  }
}
