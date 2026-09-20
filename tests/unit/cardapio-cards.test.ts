import { describe, it, expect } from 'vitest'
import {
  obterCartaoCombo,
  gerarCatalogoTextoCompleto,
} from '@/lib/cardapio/cards'

describe('Motor de Cartões Digitais para WhatsApp & Telegram', () => {
  it('gera cartão visual estruturado com markdown e CTA amigável para o Combo 1', () => {
    const cartao1 = obterCartaoCombo('Combo 1')
    expect(cartao1).toBeDefined()
    expect(cartao1?.textoMarkdownCartao).toContain('🍗 *COMBO 1 — O CLÁSSICO*')
    expect(cartao1?.textoMarkdownCartao).toContain('`R$ 69,90`')
    expect(cartao1?.textoMarkdownCartao).toContain('Serve 3 a 4 pessoas')
    expect(cartao1?.textoMarkdownCartao).toContain('piá')
  })

  it('gera cartão visual estruturado para o Combo 2 com destaque de especialidade', () => {
    const cartao2 = obterCartaoCombo(2)
    expect(cartao2).toBeDefined()
    expect(cartao2?.textoMarkdownCartao).toContain('🥩 *COMBO 2 — COSTELA SUPREMA NO BAFO*')
    expect(cartao2?.textoMarkdownCartao).toContain('`R$ 119,90`')
    expect(cartao2?.textoMarkdownCartao).toContain('6 horas')
  })

  it('gera catálogo completo contendo os 4 combos e instruções de pré-venda', () => {
    const catalogo = gerarCatalogoTextoCompleto()
    expect(catalogo).toContain('CARDÁPIO DE COMBOS — AMBIENTE DE DEMONSTRAÇÃO')
    expect(catalogo).toContain('COMBO 1')
    expect(catalogo).toContain('COMBO 2')
    expect(catalogo).toContain('COMBO 3')
    expect(catalogo).toContain('COMBO 4')
    expect(catalogo).toContain('Ambiente de demonstração com dados de teste')
    expect(catalogo).toContain('janelas de 15 min')
  })
})
