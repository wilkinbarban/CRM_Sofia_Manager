import { extrairAcaoInterativa } from './inbound-normalizer'
import { obterCartoesCombosOficiais } from '@/lib/cardapio/cards'
import { enviarCatalogoCombosWhatsApp, type CatalogDeliveryResult } from './gateways/catalog-gateway'
import {
  adicionarItemAoCarrinho,
  obterOuCriarCarrinhoAtivo,
  limparCarrinho,
  type CarrinhoCompleto,
} from '@/lib/carrinho/service'

export interface ProcessarAcaoInput {
  clienteId: string
  telefone: string
  interactiveId?: string | null
  supabaseClient?: any
}

/**
 * Sanitized failure code. Closed by construction so it is always safe to log:
 * the customer-facing detail lives only in `respostaTexto`.
 */
export type ProcessarAcaoError =
  | 'cart_unavailable'
  | 'query_unavailable'
  | 'empty'
  | NonNullable<CatalogDeliveryResult['error']>

export interface ProcessarAcaoOutput {
  handled: boolean
  respostaTexto?: string
  carrinho?: CarrinhoCompleto
  error?: ProcessarAcaoError
  catalog?: { sent?: number; error?: NonNullable<CatalogDeliveryResult['error']> }
}

function formatarMoeda(centavos: number): string {
  return (centavos / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })
}

function formatarResumoCarrinho(carrinho: CarrinhoCompleto): string {
  const itens = carrinho.itens_carrinho || []
  if (itens.length === 0) {
    return `🛒 *Seu carrinho está vazio.*\n\nQue tal dar uma olhadinha no nosso catálogo de produtos?`
  }

  const linhas = itens.map((item) => {
    const nome = item.produtos?.nome || 'Item'
    const total = formatarMoeda(item.preco_total_centavos)
    return `• *${item.quantidade}x ${nome}* — ${total}`
  })

  const totalFormatado = formatarMoeda(carrinho.total_centavos)

  return [
    `🛒 *Seu Carrinho de Pedido:*`,
    ``,
    linhas.join('\n'),
    ``,
    `💰 *Total:* ${totalFormatado}`,
    `⏰ *Retirada:* Consulte o ponto informado no pedido`,
    ``,
    `Para confirmar ou adicionar mais itens, pode me chamar por aqui! 😊`,
  ].join('\n')
}

/**
 * Roteia e executa a ação interativa disparada pelo cliente no WhatsApp.
 */
export async function processarAcaoInterativaWhatsApp(
  input: ProcessarAcaoInput
): Promise<ProcessarAcaoOutput> {
  const acao = extrairAcaoInterativa(input.interactiveId)
  if (!acao) {
    return { handled: false }
  }

  const { scope, action, entityId } = acao

  if (scope === 'catalog' && action === 'view') {
    const officialCards = obterCartoesCombosOficiais()
    const query = input.supabaseClient?.from?.('produtos')
    if (!query) return { handled: true, error: 'query_unavailable', respostaTexto: 'Não consegui carregar o catálogo agora. Tente novamente em instantes.' }
    const { data, error } = await query.select('id, nome, descricao, preco_centavos, url_imagem').eq('ativo', true)
    if (error) return { handled: true, error: 'query_unavailable', respostaTexto: 'Não consegui carregar o catálogo agora. Tente novamente em instantes.' }
    const productsById = new Map<string, any>((data || []).map((product: any) => [product.id, product]))
    const products = officialCards.map((official) => {
      const product = productsById.get(official.id)
      if (!product) return null
      return {
        id: product.id,
        nome: product.nome,
        descricao: product.descricao,
        precoCentavos: product.preco_centavos,
        urlImagem: product.url_imagem,
      }
    }).filter(Boolean).slice(0, 4) as any[]
    if (!products.length) return { handled: true, error: 'empty', respostaTexto: 'O catálogo está indisponível no momento. Tente novamente em instantes.' }
    const delivery = await enviarCatalogoCombosWhatsApp(input.telefone, products)
    return { handled: true, catalog: delivery, error: delivery.error, respostaTexto: delivery.success ? undefined : 'Não consegui carregar o catálogo agora. Tente novamente em instantes.' }
  }

  // 1. Escopo de Carrinho
  if (scope === 'cart') {
    if (action === 'add' && entityId) {
      const res = await adicionarItemAoCarrinho({
        clienteId: input.clienteId,
        produtoId: entityId,
        quantidade: 1,
        canal: 'whatsapp',
        supabaseClient: input.supabaseClient,
      })

      if (!res.success || !res.carrinho) {
        return {
          handled: true,
          error: 'cart_unavailable',
          respostaTexto: `⚠️ Não consegui adicionar o item ao seu carrinho: ${res.error || 'Produto indisponível.'}`,
        }
      }

      const itemAdicionado = res.carrinho.itens_carrinho.find((i) => i.produto_id === entityId)
      const nomeItem = itemAdicionado?.produtos?.nome || 'Produto'
      const valorItem = formatarMoeda(itemAdicionado?.preco_unitario_centavos || 0)
      const totalGeral = formatarMoeda(res.carrinho.total_centavos)

      const resposta = [
        `✅ *${nomeItem}* adicionado ao seu pedido! (${valorItem})`,
        ``,
        `🛒 *Resumo do Pedido:*`,
        ...res.carrinho.itens_carrinho.map(
          (i) => `• ${i.quantidade}x ${i.produtos?.nome || 'Item'} (${formatarMoeda(i.preco_total_centavos)})`
        ),
        ``,
        `💰 *Subtotal Atual:* ${totalGeral}`,
        ``,
        `Deseja adicionar mais algum item ou já quer escolher o horário de retirada?`,
      ].join('\n')

      return {
        handled: true,
        carrinho: res.carrinho,
        respostaTexto: resposta,
      }
    }

    if (action === 'view') {
      const res = await obterOuCriarCarrinhoAtivo(input.clienteId, {
        canal: 'whatsapp',
        supabaseClient: input.supabaseClient,
      })

      if (!res.success || !res.carrinho) {
        return {
          handled: true,
          error: 'cart_unavailable',
          respostaTexto: `⚠️ Não foi possível carregar seu carrinho no momento.`,
        }
      }

      return {
        handled: true,
        carrinho: res.carrinho,
        respostaTexto: formatarResumoCarrinho(res.carrinho),
      }
    }

    if (action === 'clear') {
      const res = await limparCarrinho({
        clienteId: input.clienteId,
        supabaseClient: input.supabaseClient,
      })

      return {
        handled: true,
        carrinho: res.carrinho,
        respostaTexto: `🗑️ Seu carrinho foi esvaziado com sucesso. Quando quiser pedir, é só me avisar!`,
      }
    }
  }

  // 2. Escopo de Informações de Produto
  if (scope === 'product' && action === 'details' && entityId) {
    return {
      handled: true,
      respostaTexto: `🍗 *Detalhes do Produto selecionado!*\nPara adicionar ao seu pedido, basta clicar no botão correspondente ou me dizer a quantidade.`,
    }
  }

  // 3. Escopo de Transferência Humana
  if (scope === 'human' && action === 'request') {
    return {
      handled: true,
      respostaTexto: `🙋‍♀️ Entendido! Já estou transferindo sua conversa para a nossa equipe de atendimento no balcão. Um momento, por favor!`,
    }
  }

  return { handled: false }
}
