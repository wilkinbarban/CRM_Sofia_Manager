import { describe, it, expect } from 'vitest'
import { COMBOS_OFICIAIS, obterCartaoCombo, obterCartoesCombosOficiais } from '@/lib/cardapio/cards'

describe('Catálogo Oficial dos 4 Combos da Casa de Assados Sofia', () => {
  it('contém exatamente os 4 combos oficiais documentados no plano de negócios', () => {
    const combos = obterCartoesCombosOficiais()
    expect(combos).toHaveLength(4)

    const numeros = combos.map((c) => c.numeroCombo)
    expect(numeros).toEqual([1, 2, 3, 4])
  })

  it('Combo 1 tem preço de R$ 69,90 e atende de 3 a 4 pessoas', () => {
    const combo1 = obterCartaoCombo(1)
    expect(combo1).toBeDefined()
    expect(combo1?.nome).toContain('Combo 1 – O Clássico da Casa')
    expect(combo1?.precoCentavos).toBe(6990)
    expect(combo1?.precoFormatado).toBe('R$ 69,90')
    expect(combo1?.rendimento).toContain('3 a 4 pessoas')
    expect(combo1?.itensComposicao.some((i) => i.includes('Frango recheado'))).toBe(true)
    expect(combo1?.itensComposicao.some((i) => i.includes('Maionese'))).toBe(true)
    expect(combo1?.itensComposicao.some((i) => i.includes('Farofa'))).toBe(true)
  })

  it('Combo 2 tem preço de R$ 119,90 e serve 4 pessoas', () => {
    const combo2 = obterCartaoCombo(2)
    expect(combo2).toBeDefined()
    expect(combo2?.nome).toContain('Combo 2 – Costela Suprema no Bafo')
    expect(combo2?.precoCentavos).toBe(11990)
    expect(combo2?.precoFormatado).toBe('R$ 119,90')
    expect(combo2?.rendimento).toContain('4 pessoas')
    expect(combo2?.itensComposicao.some((i) => i.includes('Costela'))).toBe(true)
    expect(combo2?.itensComposicao.some((i) => i.includes('Mandioca'))).toBe(true)
  })

  it('Combo 3 tem preço de R$ 94,90 e serve 3 a 4 pessoas', () => {
    const combo3 = obterCartaoCombo(3)
    expect(combo3).toBeDefined()
    expect(combo3?.nome).toContain('Combo 3 – Dueto Especial')
    expect(combo3?.precoCentavos).toBe(9490)
    expect(combo3?.precoFormatado).toBe('R$ 94,90')
    expect(combo3?.itensComposicao.some((i) => i.includes('Frango'))).toBe(true)
    expect(combo3?.itensComposicao.some((i) => i.includes('Costelinha suína'))).toBe(true)
  })

  it('Combo 4 tem preço de R$ 169,90 e serve de 5 a 6 pessoas', () => {
    const combo4 = obterCartaoCombo(4)
    expect(combo4).toBeDefined()
    expect(combo4?.nome).toContain('Combo 4 – Kit Churrasco Família')
    expect(combo4?.precoCentavos).toBe(16990)
    expect(combo4?.precoFormatado).toBe('R$ 169,90')
    expect(combo4?.rendimento).toContain('5 a 6 pessoas')
    expect(combo4?.itensComposicao.some((i) => i.includes('Linguiças toscanas'))).toBe(true)
    expect(combo4?.itensComposicao.some((i) => i.includes('Pão de Alho'))).toBe(true)
  })

  it('cada combo possui 2 referências de imagens de apresentação', () => {
    for (const combo of COMBOS_OFICIAIS) {
      expect(combo.urlImagemPrincipal).toMatch(/^\/cardapio\/combo_\d_.*_1\.png$/)
      expect(combo.urlImagemSecundaria).toMatch(/^\/cardapio\/combo_\d_.*_2\.png$/)
    }
  })
})
