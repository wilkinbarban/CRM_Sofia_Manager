export interface ProdutoCardapio {
  id: string
  nome: string
  descricao?: string | null
  preco_centavos: number
  quantidade_estoque?: number | null
  url_imagem?: string | null
  categoria?: string | null
}

export interface RecomendacaoCardapioInput {
  pessoas: number
  orcamentoMaximoCentavos?: number
  produtos: ProdutoCardapio[]
}

export interface ItemRecomendado {
  produto: ProdutoCardapio
  quantidade: number
  subtotalCentavos: number
}

export interface RecomendacaoCardapioOutput {
  itens: ItemRecomendado[]
  totalCentavos: number
  totalFormatado: string
  textoExplicativo: string
}

export function formatarPrecoBrl(precoCentavos: number): string {
  return `R$ ${(precoCentavos / 100).toFixed(2).replace('.', ',')}`
}

function categorizarProduto(nome: string): 'kits' | 'cortes' | 'acompanhamentos' | 'bebidas' | 'outros' {
  const n = nome.toLowerCase()
  if (n.includes('kit') || n.includes('família') || n.includes('familia') || n.includes('combo')) {
    return 'kits'
  }
  if (
    n.includes('costela') ||
    n.includes('picanha') ||
    n.includes('alcatra') ||
    n.includes('cupim') ||
    n.includes('maminha') ||
    n.includes('fraldinha') ||
    n.includes('bife') ||
    n.includes('corte')
  ) {
    return 'cortes'
  }
  if (
    n.includes('linguiça') ||
    n.includes('linguica') ||
    n.includes('maionese') ||
    n.includes('farofa') ||
    n.includes('pão') ||
    n.includes('pao') ||
    n.includes('mandioca') ||
    n.includes('arroz') ||
    n.includes('salada')
  ) {
    return 'acompanhamentos'
  }
  if (n.includes('refrigerante') || n.includes('coca') || n.includes('suco') || n.includes('cerveja') || n.includes('água') || n.includes('agua')) {
    return 'bebidas'
  }
  return 'outros'
}

/**
 * Formata o cardápio estruturado em Cartões Digitais (Cards) com miniaturas para WhatsApp, Telegram e Web (Figura 4)
 */
export function formatarCardapioResumido(produtos: ProdutoCardapio[], baseUrl = 'https://crmsofiamanager.duckdns.org'): string {
  if (!produtos || produtos.length === 0) {
    return 'No momento nosso cardápio está sendo atualizado pelo mestre assador. Por favor, pergunte a um atendente!'
  }

  const cleanBaseUrl = (baseUrl || 'https://crmsofiamanager.duckdns.org').replace(/\/$/, '')

  const grupos: Record<'cortes' | 'kits' | 'acompanhamentos' | 'bebidas' | 'outros', ProdutoCardapio[]> = {
    cortes: [],
    kits: [],
    acompanhamentos: [],
    bebidas: [],
    outros: [],
  }

  for (const prod of produtos) {
    const cat = categorizarProduto(prod.nome)
    grupos[cat].push(prod)
  }

  const linhas: string[] = [
    '🔥 *CARDÁPIO — O que vai querer hoje?*',
    '_Confira os itens e combos disponíveis neste ambiente de demonstração com dados de teste:_',
    '',
  ]

  if (grupos.kits.length > 0) {
    for (const item of grupos.kits) {
      const isCombo1 = item.nome.includes('1')
      const isCombo2 = item.nome.includes('2')
      const isCombo3 = item.nome.includes('3')
      const isCombo4 = item.nome.includes('4')

      const icone = isCombo1 ? '🍗' : isCombo2 ? '🥩' : isCombo3 ? '✨' : '👑'
      const rendimento = isCombo4 ? '5 a 6 pessoas' : isCombo2 ? '4 pessoas' : '3 a 4 pessoas'
      const botaoTexto = isCombo4 || isCombo3 ? 'Quero esse combo' : 'Adicionar ao pedido'

      const imgPath = item.url_imagem || (isCombo1 ? '/cardapio/combo_1_classico_sofia_1.png' : isCombo2 ? '/cardapio/combo_2_costela_suprema_1.png' : isCombo3 ? '/cardapio/combo_3_dueto_sofia_1.png' : '/cardapio/combo_4_kit_familia_1.png')
      const imgUrl = imgPath.startsWith('http') ? imgPath : `${cleanBaseUrl}${imgPath}`

      const estoqueInfo = item.quantidade_estoque !== undefined && item.quantidade_estoque !== null && item.quantidade_estoque <= 10
        ? ` _(Restam ${item.quantidade_estoque} un)_`
        : ''

      linhas.push(`${icone} *${item.nome}*`)
      linhas.push(`🔖 product:${item.id}`)
      linhas.push(`📷 ${imgUrl}`)
      if (item.descricao) {
        // Se a descrição tiver itens separados por vírgula ou +, quebrar em bullets limpos
        const bullets = item.descricao
          .split(/,|\+|\n/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && !s.toLowerCase().startsWith('serve'))
        if (bullets.length > 1) {
          bullets.forEach((b) => linhas.push(`• ${b}`))
        } else {
          linhas.push(`${item.descricao}`)
        }
      }
      linhas.push(`👥 _Serve ${rendimento}_`)
      linhas.push(`💰 *${formatarPrecoBrl(item.preco_centavos)}*${estoqueInfo}`)
      linhas.push(`🛒 _[${botaoTexto}]_ • 👀 _[Ver detalhes]_`)
      linhas.push('')
    }
  }

  if (grupos.cortes.length > 0) {
    linhas.push('🥩 *CORTES AVULSOS NA BRASA*')
    for (const item of grupos.cortes) {
      const icone = item.nome.toLowerCase().includes('costela') ? '🥩' : '🍗'
      const estoqueInfo = item.quantidade_estoque !== undefined && item.quantidade_estoque !== null && item.quantidade_estoque <= 10
        ? ` _(Restam ${item.quantidade_estoque} un)_`
        : ''
      const imgPath = item.url_imagem ? `${item.url_imagem.startsWith('http') ? item.url_imagem : `${cleanBaseUrl}${item.url_imagem}`}` : ''

      linhas.push(`${icone} *${item.nome}*`)
      linhas.push(`🔖 product:${item.id}`)
      if (imgPath) {
        linhas.push(`📷 ${imgPath}`)
      }
      if (item.descricao) {
        linhas.push(`${item.descricao}`)
      }
      linhas.push(`💰 *${formatarPrecoBrl(item.preco_centavos)}*${estoqueInfo}`)
      linhas.push(`🛒 _[Adicionar ao pedido]_ • 👀 _[Ver detalhes]_`)
      linhas.push('')
    }
  }

  if (grupos.acompanhamentos.length > 0) {
    linhas.push('🥗 *ACOMPANHAMENTOS & PORÇÕES ARTESANAIS*')
    for (const item of grupos.acompanhamentos) {
      linhas.push(`• *${item.nome}* — ${formatarPrecoBrl(item.preco_centavos)}`)
    }
    linhas.push('')
  }

  if (grupos.bebidas.length > 0) {
    linhas.push('🥤 *BEBIDAS GELADAS*')
    for (const item of grupos.bebidas) {
      linhas.push(`• *${item.nome}* — ${formatarPrecoBrl(item.preco_centavos)}`)
    }
    linhas.push('')
  }

  linhas.push('💬 *Qual desses você quer garantir para o seu almoço de domingo, piá? Quantas pessoas vão comer hoje? Só me avisar por aqui ou clicar no botão!* 😊')

  return linhas.join('\n')
}

/**
 * Calcula recomendação inteligente de corte e quantidade de pessoas
 */
export function calcularRecomendacaoCardapio(input: RecomendacaoCardapioInput): RecomendacaoCardapioOutput {
  const { pessoas, orcamentoMaximoCentavos, produtos } = input
  const itens: ItemRecomendado[] = []

  // 1. Se for 4 ou mais pessoas, priorizar Kit Família se disponível
  const kitFamilia = produtos.find((p) => p.nome.toLowerCase().includes('kit') || p.nome.toLowerCase().includes('família'))
  const costela = produtos.find((p) => p.nome.toLowerCase().includes('costela'))
  const picanha = produtos.find((p) => p.nome.toLowerCase().includes('picanha'))

  if (pessoas >= 4 && kitFamilia && (!orcamentoMaximoCentavos || kitFamilia.preco_centavos <= orcamentoMaximoCentavos)) {
    itens.push({
      produto: kitFamilia,
      quantidade: 1,
      subtotalCentavos: kitFamilia.preco_centavos,
    })
  } else if (costela && (!orcamentoMaximoCentavos || costela.preco_centavos <= orcamentoMaximoCentavos)) {
    itens.push({
      produto: costela,
      quantidade: 1,
      subtotalCentavos: costela.preco_centavos,
    })
  } else if (picanha && (!orcamentoMaximoCentavos || picanha.preco_centavos <= orcamentoMaximoCentavos)) {
    itens.push({
      produto: picanha,
      quantidade: 1,
      subtotalCentavos: picanha.preco_centavos,
    })
  } else if (produtos.length > 0) {
    const itemMaisBarato = [...produtos].sort((a, b) => a.preco_centavos - b.preco_centavos)[0]
    itens.push({
      produto: itemMaisBarato,
      quantidade: 1,
      subtotalCentavos: itemMaisBarato.preco_centavos,
    })
  }

  const totalCentavos = itens.reduce((sum, i) => sum + i.subtotalCentavos, 0)
  const totalFormatado = formatarPrecoBrl(totalCentavos)

  const nomesItens = itens.map((i) => `${i.quantidade}x ${i.produto.nome}`).join(' + ')
  const textoExplicativo = `Para ${pessoas} pessoas, a melhor opção recomendada é ${nomesItens}, ficando em ${totalFormatado}.`

  return {
    itens,
    totalCentavos,
    totalFormatado,
    textoExplicativo,
  }
}
