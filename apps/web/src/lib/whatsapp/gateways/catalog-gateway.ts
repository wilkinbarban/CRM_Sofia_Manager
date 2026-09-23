import { obterConfiguracaoSistema } from '@/lib/config/sistema'
import { getBusinessProfile, resolveBusinessProfileSync } from '@/lib/config/business-profile'
import { evolutionHeaders } from '@/lib/whatsapp/evolution-headers'

export interface ProdutoCardapioItem {
  id: string
  nome: string
  descricao?: string | null
  precoCentavos: number
  urlImagem?: string | null
}

export interface EnviarCardapioInput {
  telefone: string
  produtos: ProdutoCardapioItem[]
}

export interface EnviarCardapioResult {
  success: boolean
  modoUtilizado: 'CAROUSEL_NATIVO' | 'BUTTONS_FALLBACK' | 'LIST_FALLBACK' | 'TEXT_FALLBACK'
  error?: string
}

export interface CatalogDeliveryResult {
  success: boolean
  messageId?: string
  sent?: number
  error?: 'config_unavailable' | 'provider_rejected' | 'provider_unavailable' | 'no_viable_products'
}

function safeCatalogError(response: Response): CatalogDeliveryResult['error'] {
  return response.status >= 500 ? 'provider_unavailable' : 'provider_rejected'
}

async function getEvolutionConfig() {
  const [url, apiKey, instance] = await Promise.all([
    obterConfiguracaoSistema('EVOLUTION_API_URL'),
    obterConfiguracaoSistema('EVOLUTION_API_KEY'),
    obterConfiguracaoSistema('EVOLUTION_INSTANCE_NAME'),
  ])
  return url && apiKey && instance ? { url: url.replace(/\/$/, ''), apiKey, instance } : null
}

async function postCatalogMessage(path: string, config: { url: string; apiKey: string; instance: string }, payload: unknown) {
  let response: Response
  try {
    response = await fetch(`${config.url}${path}/${encodeURIComponent(config.instance)}`, {
      method: 'POST',
      headers: evolutionHeaders(config.apiKey),
      body: JSON.stringify(payload),
    })
  } catch {
    return { ok: false as const, error: 'provider_unavailable' as const }
  }
  if (response.status < 200 || response.status >= 300) return { ok: false as const, error: safeCatalogError(response) }
  let body: any
  try { body = await response.json() } catch { body = null }
  const messageId = body?.key?.id || body?.message?.key?.id || body?.id
  return typeof messageId === 'string' && messageId ? { ok: true as const, messageId } : { ok: false as const, error: 'provider_rejected' as const }
}

export function formatarPromptCatalogoTexto(profile = resolveBusinessProfileSync()): string {
  return [
    '🔥 *Catálogo de Produtos*',
    '',
    'Gostaria de ver os nossos combos oficiais com fotos e valores?',
    'Responda *1* para eu te enviar as fotos! 📸',
    '',
    `_${profile.pickupAddress}_`,
  ].join('\n')
}

export async function enviarPromptCatalogoWhatsApp(telefone: string): Promise<CatalogDeliveryResult> {
  const config = await getEvolutionConfig()
  if (!config) return { success: false, error: 'config_unavailable' }
  const profile = await getBusinessProfile()
  const text = formatarPromptCatalogoTexto(profile)
  const result = await postCatalogMessage('/message/sendText', config, {
    number: telefone,
    text,
  })
  return result.ok ? { success: true, messageId: result.messageId } : { success: false, error: result.error }
}

export async function enviarCatalogoCombosWhatsApp(
  telefone: string,
  produtos: ProdutoCardapioItem[],
): Promise<CatalogDeliveryResult> {
  const config = await getEvolutionConfig()
  if (!config) return { success: false, error: 'config_unavailable' }
  let sent = 0
  for (const produto of produtos.slice(0, 4)) {
    if (!produto.urlImagem || !produto.nome || !produto.descricao || !Number.isFinite(produto.precoCentavos)) continue
    const result = await postCatalogMessage('/message/sendMedia', config, {
      number: telefone,
      mediatype: 'image',
      media: produto.urlImagem,
      caption: `🔥 *${produto.nome}*\n${produto.descricao}\n\n💰 *${formatarMoeda(produto.precoCentavos)}*`,
    })
    if (!result.ok) return { success: false, sent, error: result.error }
    sent += 1
  }
  return sent ? { success: true, sent } : { success: false, sent: 0, error: 'no_viable_products' }
}

function formatarMoeda(centavos: number): string {
  return (centavos / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })
}

/**
 * Monta o payload JSON esperado pelo endpoint sendCarousel da Evolution API 2.4.x
 */
export function montarPayloadCarrossel(params: EnviarCardapioInput) {
  const cards = params.produtos.map((p) => {
    const valor = formatarMoeda(p.precoCentavos)
    const icone = p.nome.toLowerCase().includes('costela') ? '🥩' : '🍗'

    return {
      imageUrl: p.urlImagem || 'https://crmsofiamanager.duckdns.org/icon.png',
      title: `${icone} ${p.nome}`,
      body: `${p.descricao || 'Item do catálogo disponível para pedido'}\n\n*Valor:* ${valor}`,
      buttons: [
        {
          type: 'reply',
          displayText: '🛒 Adicionar ao pedido',
          id: `cart:add:${p.id}`,
        },
        {
          type: 'reply',
          displayText: 'ℹ️ Ver detalhes',
          id: `product:details:${p.id}`,
        },
      ],
    }
  })

  const profile = resolveBusinessProfileSync()
  return {
    number: params.telefone,
    body: `🔥 *Catálogo de Produtos — ${profile.name}*\n_${profile.pickupAddress} • O que você deseja hoje?_`,
    cards,
  }
}

export function montarPayloadBotoes(params: EnviarCardapioInput) {
  const profile = resolveBusinessProfileSync()
  return {
    number: params.telefone,
    title: '🔥 Catálogo de Produtos',
    description: 'Escolha um produto para adicionar ao pedido:',
    footer: profile.pickupAddress,
    buttons: params.produtos.slice(0, 3).map((produto) => ({
      type: 'reply',
      displayText: produto.nome.slice(0, 20),
      id: `cart:add:${produto.id}`,
    })),
  }
}

export function montarPayloadLista(params: EnviarCardapioInput) {
  const profile = resolveBusinessProfileSync()
  return {
    number: params.telefone,
    title: '🔥 Catálogo de Produtos',
    description: 'Veja os produtos disponíveis e escolha o seu.',
    footerText: profile.pickupAddress,
    buttonText: 'Ver cardápio',
    sections: [{
      title: 'Produtos',
      rows: params.produtos.map((produto) => ({
        title: produto.nome.slice(0, 24),
        description: formatarMoeda(produto.precoCentavos),
        rowId: `cart:add:${produto.id}`,
      })),
    }],
  }
}

export function montarPayloadTexto(params: EnviarCardapioInput) {
  const profile = resolveBusinessProfileSync()
  const itens = params.produtos.map((produto, index) => [
    `${index + 1}. *${produto.nome}* — ${formatarMoeda(produto.precoCentavos)}`,
    produto.descricao ? `   ${produto.descricao}` : null,
  ].filter(Boolean).join('\n'))

  return {
    number: params.telefone,
    text: [
      `🔥 *Catálogo de Produtos — ${profile.name}*`,
      '',
      ...itens,
      '',
      'Responda *Quero o item N* para adicionar ao pedido.',
    ].join('\n'),
  }
}

async function postEvolution(
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  mode: string,
): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })

  if (response.ok === false || (typeof response.status === 'number' && (response.status < 200 || response.status >= 300))) {
    const detail = typeof response.text === 'function' ? await response.text().catch(() => '') : ''
    throw new Error(
      `Evolution API rejeitou ${mode} com status ${response.status}${detail ? `: ${detail}` : ''}`,
    )
  }
}

/**
 * Monta os cartões de fallback com foto e texto formatado (estilo Figura 4)
 */
export function montarPayloadCardsFallback(params: EnviarCardapioInput) {
  return params.produtos.map((p, idx) => {
    const valor = formatarMoeda(p.precoCentavos)
    const icone = p.nome.toLowerCase().includes('costela') ? '🥩' : '🍗'

    const caption = [
      `━━━━━━━━━━━━━━━━━━━━━━━━`,
      `${icone} *${p.nome.toUpperCase()}*`,
      `━━━━━━━━━━━━━━━━━━━━━━━━`,
      `📝 ${p.descricao || 'Produto disponível para pedido.'}`,
      `💰 *Preço:* ${valor}`,
      `📍 *Retirada:* Consulte o ponto informado no pedido`,
      `━━━━━━━━━━━━━━━━━━━━━━━━`,
      `*Ações rápidas:*`,
      `1️⃣ Adicionar ao pedido (digite *"Quero o item ${idx + 1}"*)`,
      `2️⃣ Ver detalhes`,
      `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ].join('\n')

    return {
      imageUrl: p.urlImagem || 'https://crmsofiamanager.duckdns.org/icon.png',
      caption,
      produtoId: p.id,
    }
  })
}

/**
 * Envia o cardápio interativo com carrossel nativo e fallback automático em cascata.
 */
export async function enviarCardapioWhatsApp(
  input: EnviarCardapioInput
): Promise<EnviarCardapioResult> {
  const evolutionUrl = await obterConfiguracaoSistema('EVOLUTION_API_URL')
  const evolutionApiKey = await obterConfiguracaoSistema('EVOLUTION_API_KEY')
  const evolutionInstanceName = await obterConfiguracaoSistema('EVOLUTION_INSTANCE_NAME')
  const carouselEnabled = await obterConfiguracaoSistema('WHATSAPP_INTERACTIVE_CAROUSEL_ENABLED')

  if (!evolutionUrl || !evolutionApiKey || !evolutionInstanceName) {
    return {
      success: false,
      modoUtilizado: 'TEXT_FALLBACK',
      error: 'Configurações da Evolution API não encontradas no sistema.',
    }
  }

  const cleanUrl = evolutionUrl.replace(/\/$/, '')
  const headers = evolutionHeaders(evolutionApiKey)

  // Native carousel stays opt-in until the pinned Evolution image passes the compatibility matrix.
  if (carouselEnabled === 'true') {
    try {
      await postEvolution(
        `${cleanUrl}/message/sendCarousel/${evolutionInstanceName}`,
        headers,
        montarPayloadCarrossel(input),
        'sendCarousel',
      )
      return { success: true, modoUtilizado: 'CAROUSEL_NATIVO' }
    } catch (err: any) {
      console.warn(
        `[WhatsApp Gateway] ${err.message}. Ativando fallback para botões.`,
      )
    }
  }

  try {
    await postEvolution(
      `${cleanUrl}/message/sendButtons/${evolutionInstanceName}`,
      headers,
      montarPayloadBotoes(input),
      'sendButtons',
    )
    return { success: true, modoUtilizado: 'BUTTONS_FALLBACK' }
  } catch (err: any) {
    console.warn(`[WhatsApp Gateway] ${err.message}. Ativando fallback para lista.`)
  }

  try {
    await postEvolution(
      `${cleanUrl}/message/sendList/${evolutionInstanceName}`,
      headers,
      montarPayloadLista(input),
      'sendList',
    )
    return { success: true, modoUtilizado: 'LIST_FALLBACK' }
  } catch (err: any) {
    console.warn(`[WhatsApp Gateway] ${err.message}. Ativando fallback para texto.`)
  }

  try {
    await postEvolution(
      `${cleanUrl}/message/sendText/${evolutionInstanceName}`,
      headers,
      montarPayloadTexto(input),
      'sendText',
    )
    return { success: true, modoUtilizado: 'TEXT_FALLBACK' }
  } catch (err: any) {
    console.error('[WhatsApp Gateway] Nenhum modo conseguiu entregar o cardápio:', err)
    return {
      success: false,
      modoUtilizado: 'TEXT_FALLBACK',
      error: err.message || 'Falha ao entregar cardápio no WhatsApp',
    }
  }
}
