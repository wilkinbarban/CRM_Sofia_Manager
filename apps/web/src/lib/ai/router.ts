/**
 * Sofia Business Router — Heurística de Classificação de Negócio em 3 Níveis
 * CRM Sofia Manager
 */

export type SofiaTier = 'economy' | 'smart' | 'frontier'

export interface SofiaClassificationParams {
  mensagemCliente: string
  valorCarrinhoCentavos?: number
  itensCarrinhoCount?: number
  historicoMensagensCount?: number
}

export interface SofiaClassificationResult {
  tier: SofiaTier
  modelAlias: string
  motivo: string
}

const TIER_MODEL_MAP: Record<SofiaTier, string> = {
  economy: 'business-economy',
  smart: 'business-smart',
  frontier: 'business-frontier',
}

// Padrões de Detecção para NÍVEL FRONTIER (Eventos, Empresas, Negociações Grandes)
const FRONTIER_PATTERNS = [
  /corporativ/i,
  /empresa/i,
  /confraterniza/i,
  /evento/i,
  /casamento/i,
  /anivers[aá]rio/i,
  /buffet/i,
  /\b([3-9]\d|\d{3,})\s*(pessoas|convidados|clientes|comensais)\b/i, // 30+ pessoas
  /nota\s*fiscal\s*(para\s*empresa|pj|cnpj)/i,
  /or[cç]amento\s*especial/i,
  /encomenda\s*grande/i,
  /festa/i,
]

// Padrões de Detecção para NÍVEL SMART (Objeções, Restrições, Cálculo por Pessoa, Upsell)
const SMART_PATTERNS = [
  /est[aá]\s*caro/i,
  /desconto/i,
  /mais\s*barato/i,
  /concorrente/i,
  /tem\s*como\s*fazer\s*menos/i,
  /sem\s*porco/i,
  /sem\s*carne\s*su[ií]na/i,
  /n[aã]o\s*como\s*porco/i,
  /n[aã]o\s*como\s*carne\s*vermelha/i,
  /cel[ií]ac/i,
  /gl[uú]ten/i,
  /lactose/i,
  /vegetar/i,
  /vegano/i,
  /dieta/i,
  /quant(os|as)\s*(kg|quilos|gramas|g)\s*(de\s*carne)?\s*por\s*pessoa/i,
  /quant(os|as)\s*pessoas\s*comem/i,
  /quant(os|as)\s*pessoas\s*serve/i,
  /diferen[cç]a\s*entre/i,
  /o\s*que\s*voc[eê]\s*recomenda/i,
  /qual\s*(o\s*melhor|o\s*mais\s*saboroso|voc[eê]\s*indica)/i,
  /acompanhamento\s*extra/i,
  /maionese\s*(adicional|extra)/i,
  /farofa\s*(adicional|extra)/i,
  /bebida/i,
  /refrigerante/i,
  /sobremesa/i,
  /\b(1[0-9]|2[0-9])\s*(pessoas|convidados)\b/i, // 10 a 29 pessoas
]

/**
 * Classifica a mensagem do cliente em um dos 3 níveis de inteligência
 * com latência zero (sem invocar LLM para classificar LLM).
 */
export function classifySofiaRequestTier(
  params: SofiaClassificationParams
): SofiaClassificationResult {
  const texto = (params.mensagemCliente || '').trim().toLowerCase()
  const valorCarrinho = params.valorCarrinhoCentavos || 0

  // 1. Regra de Alto Ticket (> R$ 500,00) -> FRONTIER
  if (valorCarrinho >= 50000) {
    return {
      tier: 'frontier',
      modelAlias: TIER_MODEL_MAP.frontier,
      motivo: `Carrinho de alto ticket (R$ ${(valorCarrinho / 100).toFixed(2)})`,
    }
  }

  // 2. Regra por Padrões Regex de FRONTIER (Eventos, Empresas, 30+ pessoas)
  for (const pattern of FRONTIER_PATTERNS) {
    if (pattern.test(texto)) {
      return {
        tier: 'frontier',
        modelAlias: TIER_MODEL_MAP.frontier,
        motivo: `Padrão de grande evento / corporativo identificado: ${pattern.source}`,
      }
    }
  }

  // 3. Regra por Padrões Regex de SMART (Objeções, Restrições, Recomendação, 10-29 pessoas)
  for (const pattern of SMART_PATTERNS) {
    if (pattern.test(texto)) {
      return {
        tier: 'smart',
        modelAlias: TIER_MODEL_MAP.smart,
        motivo: `Padrão consultivo / objeção / restrição alimentar identificado: ${pattern.source}`,
      }
    }
  }

  // 4. Default: ECONOMY (FAQs, Horários, Endereço, Cardápio Rápido, Pedido Simples)
  return {
    tier: 'economy',
    modelAlias: TIER_MODEL_MAP.economy,
    motivo: 'Consulta padrão / FAQ / Cardápio geral ou pedido direto sem objeções',
  }
}
