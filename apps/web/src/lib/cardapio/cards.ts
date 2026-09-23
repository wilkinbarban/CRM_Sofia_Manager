export interface CartaoCombo {
  id: string
  numeroCombo: number
  nome: string
  slogan: string
  rendimento: string
  precoCentavos: number
  precoFormatado: string
  cmvEstimado: string
  itensComposicao: string[]
  modoPreparo: string
  destaqueBadge: string
  urlImagemPrincipal: string
  urlImagemSecundaria: string
  textoMarkdownCartao: string
}

export const COMBOS_OFICIAIS: CartaoCombo[] = [
  {
    id: 'a1111111-1111-4111-8111-111111111111',
    numeroCombo: 1,
    nome: 'Combo 1 – O Clássico da Casa',
    slogan: 'O verdadeiro sabor do domingo na mesa da sua família!',
    rendimento: 'Serve 3 a 4 pessoas',
    precoCentavos: 6990,
    precoFormatado: 'R$ 69,90',
    cmvEstimado: 'R$ 26,50 (Margem 62,1%)',
    itensComposicao: [
      '1x Frango recheado inteiro assado dourado (~1,4kg)',
      'Farofa temperada artesanal na cavidade',
      '1x Maionese caseira tradicional de batata c/ cenoura (300g)',
      '1x Cumbuca de farofa artesanal crocante c/ bacon (250g)',
    ],
    modoPreparo: 'Marinado por 12 horas em infusão de ervas frescas e assado em máquina giratória a gás com fogo calibrado até a pele ficar dourada e crocante.',
    destaqueBadge: '⭐ MAIS PEDIDO DO DOMINGO',
    urlImagemPrincipal: '/cardapio/combo_1_classico_sofia_1.png',
    urlImagemSecundaria: '/cardapio/combo_1_classico_sofia_2.png',
    textoMarkdownCartao: `🍗 *COMBO 1 — O CLÁSSICO DA CASA* ⭐
_O verdadeiro sabor do domingo na mesa da sua família!_

📦 *COMPOSIÇÃO DO COMBO:*
• *1x Frango Recheado Inteiro Dourado* (~1,4kg assado)
• *1x Maionese Caseira Tradicional de Batata* (300g)
• *1x Farofa Artesanal Crocante com Bacon* (250g)

👥 *Rendimento:* Serve 3 a 4 pessoas com fartura!
💰 *Valor:* \`R$ 69,90\`
🔥 *Preparo:* Marinado 12h em ervas finas e assado até a pele dourar!
⏱️ *Retirada:* Agendamento em janelas de 15 min (sem filas!)

💬 *Quer reservar o Combo 1 pro seu almoço, piá?* Me diga o horário de retirada desejado! 😊`,
  },
  {
    id: 'a2222222-2222-4222-8222-222222222222',
    numeroCombo: 2,
    nome: 'Combo 2 – Costela Suprema no Bafo',
    slogan: 'Assada lentamente por 6 horas, derrete na boca!',
    rendimento: 'Serve 4 pessoas',
    precoCentavos: 11990,
    precoFormatado: 'R$ 119,90',
    cmvEstimado: 'R$ 48,00 (Margem 60,0%)',
    itensComposicao: [
      '1,0kg de Costela bovina premium janela com osso',
      'Mandioca amarela cozida na manteiga de garrafa (300g)',
      'Vinagrete fresco de tomate, cebola e cheiro-verde',
      'Farofa artesanal crocante da casa (250g)',
    ],
    modoPreparo: 'Assada lentamente no bafo por mais de 6 horas em fogo indireto de carvão e lenha selecionada, soltando do osso.',
    destaqueBadge: '🔥 ESPECIALIDADE DA CASA',
    urlImagemPrincipal: '/cardapio/combo_2_costela_suprema_1.png',
    urlImagemSecundaria: '/cardapio/combo_2_costela_suprema_2.png',
    textoMarkdownCartao: `🥩 *COMBO 2 — COSTELA SUPREMA NO BAFO* 🔥
_A verdadeira especialidade do churrasco curitibano!_

📦 *COMPOSIÇÃO DO COMBO:*
• *1,0kg de Costela Bovina Premium com Osso* (Derrete na boca!)
• *1x Mandioca Amarela na Manteiga de Garrafa* (300g)
• *1x Vinagrete Especial da Casa*
• *1x Farofa Artesanal Crocante* (250g)

👥 *Rendimento:* Serve 4 pessoas muito bem!
💰 *Valor:* \`R$ 119,90\`
🔥 *Preparo:* Assada no bafo por 6 horas em fogo indireto!
⏱️ *Retirada:* Agendamento em janelas de 15 min (sem filas!)

💬 *Quer garantir essa Costela Suprema no seu domingo, piá?* Me avisa que já anoto sua reserva! 🍖`,
  },
  {
    id: 'a3333333-3333-4333-8333-333333333333',
    numeroCombo: 3,
    nome: 'Combo 3 – Dueto Especial (Frango & Costelinha Suína)',
    slogan: 'O melhor de dois mundos para quem ama variedade!',
    rendimento: 'Serve 3 a 4 pessoas',
    precoCentavos: 9490,
    precoFormatado: 'R$ 94,90',
    cmvEstimado: 'R$ 36,00 (Margem 62,1%)',
    itensComposicao: [
      'Meio Frango assado dourado com ervas frescas',
      '500g de Costelinha suína macia marinada e glaceada',
      'Batatas rústicas douradas ao alecrim (300g)',
      'Farofa artesanal da casa (200g)',
    ],
    modoPreparo: 'Combinação gastronômica de frango crocante com costelinha suína marinada em ervas finas e finalizada na grelha.',
    destaqueBadge: '✨ DUETO PERFEITO',
    urlImagemPrincipal: '/cardapio/combo_3_dueto_sofia_1.png',
    urlImagemSecundaria: '/cardapio/combo_3_dueto_sofia_2.png',
    textoMarkdownCartao: `🍗🥩 *COMBO 3 — DUETO ESPECIAL* ✨
_A combinação perfeita de Frango Assado & Costelinha Suína!_

📦 *COMPOSIÇÃO DO COMBO:*
• *Meio Frango Assado Dourado e Crocante*
• *500g de Costelinha Suína Glaceada na Brasa*
• *1x Porção de Batatas Rústicas ao Alecrim* (300g)
• *1x Farofa Artesanal Crocante* (200g)

👥 *Rendimento:* Serve 3 a 4 pessoas!
💰 *Valor:* \`R$ 94,90\`
🔥 *Preparo:* Carnes selecionadas marinadas com ervas finas!
⏱️ *Retirada:* Agendamento em janelas de 15 min (sem filas!)

💬 *Prefere esse dueto saboroso pro almoço de hoje?* Me conta quantas pessoas são! 😊`,
  },
  {
    id: 'a4444444-4444-4444-8444-444444444444',
    numeroCombo: 4,
    nome: 'Combo 4 – Kit Churrasco Família',
    slogan: 'O grande banquete completo para toda a família!',
    rendimento: 'Serve 5 a 6 pessoas',
    precoCentavos: 16990,
    precoFormatado: 'R$ 169,90',
    cmvEstimado: 'R$ 68,00 (Margem 60,0%)',
    itensComposicao: [
      '1x Frango recheado inteiro assado dourado',
      '700g de Costela bovina premium assada no bafo',
      '4x Linguiças toscanas artesanais grelhadas',
      '4x Fatias de Pão de Alho especial na brasa',
      '1x Maionese caseira grande (500g)',
      '1x Farofa grande artesanal da casa (400g)',
    ],
    modoPreparo: 'Banquete completo reunindo frango recheado, costela ao bafo, linguiças toscanas na brasa e pão de alho.',
    destaqueBadge: '👑 O BANQUETE DA CASA (5-6 PESSOAS)',
    urlImagemPrincipal: '/cardapio/combo_4_kit_familia_1.png',
    urlImagemSecundaria: '/cardapio/combo_4_kit_familia_2.png',
    textoMarkdownCartao: `👑 *COMBO 4 — KIT CHURRASCO FAMÍLIA* 👑
_O grande banquete completo para reunir quem você mais ama!_

📦 *COMPOSIÇÃO DO BANQUETE:*
• *1x Frango Recheado Inteiro Dourado*
• *700g de Costela Bovina no Bafo* (Desmanchando!)
• *4x Linguiças Toscanas Artesanais na Brasa*
• *4x Fatias de Pão de Alho Especial Tostadas*
• *1x Maionese Caseira Grande de Batata* (500g)
• *1x Farofa Grande Artesanal com Bacon* (400g)

👥 *Rendimento:* Serve com muita fartura de 5 a 6 pessoas!
💰 *Valor:* \`R$ 169,90\` (Melhor custo-benefício por pessoa!)
🔥 *Preparo:* O verdadeiro festival de carnes na brasa de Curitiba!
⏱️ *Retirada:* Agendamento em janelas de 15 min (sem filas!)

💬 *Vai reunir a família hoje, piá?* Esse Kit Churrasco é a escolha perfeita! Quer que eu reserve o seu? 🍖🔥`,
  },
]

/**
 * Retorna os cartões digitais dos 4 combos oficiais
 */
export function obterCartoesCombosOficiais(): CartaoCombo[] {
  return COMBOS_OFICIAIS
}

/**
 * Busca o cartão digital pelo número do combo (1 a 4) ou ID
 */
export function obterCartaoCombo(identificador: number | string): CartaoCombo | undefined {
  if (typeof identificador === 'number') {
    return COMBOS_OFICIAIS.find((c) => c.numeroCombo === identificador)
  }
  const idLower = identificador.toLowerCase()
  return COMBOS_OFICIAIS.find(
    (c) =>
      c.id === identificador ||
      c.nome.toLowerCase().includes(idLower) ||
      (idLower.includes('1') && c.numeroCombo === 1) ||
      (idLower.includes('2') && c.numeroCombo === 2) ||
      (idLower.includes('3') && c.numeroCombo === 3) ||
      (idLower.includes('4') && c.numeroCombo === 4)
  )
}

/**
 * Formata o catálogo com todos os cartões de combos em texto estruturado
 */
/* eslint-disable-next-line @typescript-eslint/no-unused-vars */
export function gerarCatalogoTextoCompleto(appUrl = 'https://crmsofiamanager.duckdns.org'): string {
  const cabecalho = [
    '📦 *CRM SOFIA MANAGER — CARDÁPIO DE COMBOS E PRODUTOS* ✨',
    '_Opções completas e especiais preparadas para a sua família!_',
    '📍 *Curitiba - PR* | Retirada no balcão & Delivery',
    '',
  ].join('\n')

  const corpoCombos = COMBOS_OFICIAIS.map((c) => c.textoMarkdownCartao).join('\n\n═══════════════════════════════════\n\n')

  const rodape = [
    '',
    '═══════════════════════════════════',
    '🛵 *Como funciona a nossa Pré-Venda?*',
    '1. Você escolhe o combo que mais combina com a sua família.',
    '2. Agenda o horário de retirada em janelas de 15 min (ex: 11h45, 12h00, 12h30).',
    '3. Ao chegar no balcão, seu assado sai da estufa quente direto pra sua mão em menos de 90 segundos!',
    '',
    '💬 *Qual dos nossos 4 combos vai fazer o seu domingo mais feliz, piá?*',
  ].join('\n')

  return `${cabecalho}\n${corpoCombos}\n${rodape}`
}

export const gerarCatalogoCardsCompleto = gerarCatalogoTextoCompleto

