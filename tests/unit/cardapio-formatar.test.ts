import { describe, expect, it } from 'vitest'
import {
  formatarCardapioResumido,
  calcularRecomendacaoCardapio,
  ProdutoCardapio,
} from '@/lib/cardapio/formatar'

describe('Cardápio Formatter: Formatação Visual e Consultiva para WhatsApp e Telegram', () => {
  const produtosExemplo: ProdutoCardapio[] = [
    {
      id: '1',
      nome: 'Costela Premium 1kg',
      descricao: 'Assada lentamente no bafo por 8 horas.',
      preco_centavos: 8990,
      quantidade_estoque: 25,
    },
    {
      id: '2',
      nome: 'Picanha Especial na Brasa 800g',
      descricao: 'Corte nobre macio e suculento com sal grosso.',
      preco_centavos: 11990,
      quantidade_estoque: 15,
    },
    {
      id: '3',
      nome: 'Alcatra Completa com Queijo 1kg',
      descricao: 'Acompanha queijo provolone derretido.',
      preco_centavos: 9500,
      quantidade_estoque: 10,
    },
    {
      id: '4',
      nome: 'Kit Churrasco Família (Serve 4)',
      descricao: 'Costela 1kg + Picanha 800g + Maionese + Farofa da Casa.',
      preco_centavos: 19990,
      quantidade_estoque: 8,
    },
    {
      id: '5',
      nome: 'Linguiça Artesanal de Pernil 500g',
      descricao: 'Feita na casa com ervas finas.',
      preco_centavos: 3490,
      quantidade_estoque: 40,
    },
  ]

  it('formats full structured menu with categories, prices in BRL, and consultative footer', () => {
    const cardapio = formatarCardapioResumido(produtosExemplo)

    expect(cardapio).toContain('CRM SOFIA MANAGER')
    expect(cardapio).toContain('Costela Premium 1kg')
    expect(cardapio).toContain('R$ 89,90')
    expect(cardapio).toContain('Picanha Especial na Brasa 800g')
    expect(cardapio).toContain('R$ 119,90')
    expect(cardapio.toUpperCase()).toContain('KIT CHURRASCO FAMÍLIA (SERVE 4)')
    expect(cardapio).toContain('R$ 199,90')
    expect(cardapio.toLowerCase()).toContain('quantas pessoas')
  })

  it('calculates smart recommendation based on party size', () => {
    // Para 4 pessoas, deve recomendar o Kit Família ou combinação equivalente
    const rec4 = calcularRecomendacaoCardapio({
      pessoas: 4,
      produtos: produtosExemplo,
    })

    expect(rec4).toBeDefined()
    expect(rec4.itens.length).toBeGreaterThan(0)
    expect(rec4.totalCentavos).toBeGreaterThan(0)
    expect(rec4.textoExplicativo).toContain('4 pessoas')
  })

  it('calculates smart recommendation respecting budget constraints', () => {
    const recBudget = calcularRecomendacaoCardapio({
      pessoas: 2,
      orcamentoMaximoCentavos: 10000, // R$ 100,00
      produtos: produtosExemplo,
    })

    expect(recBudget.totalCentavos).toBeLessThanOrEqual(10000)
    expect(recBudget.itens.some((i) => i.produto.nome.includes('Costela'))).toBe(true)
  })
})
