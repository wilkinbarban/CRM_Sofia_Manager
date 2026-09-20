import { describe, it, expect } from 'vitest'
import { classifySofiaRequestTier } from '@/lib/ai/router'

describe('Sofia Business Router — Classificação em 3 Níveis', () => {
  describe('Nível ECONOMY (business-economy)', () => {
    it('classifica perguntas sobre horários de funcionamento como economy', () => {
      const res = classifySofiaRequestTier({
        mensagemCliente: 'Olá, que horas vocês abrem no domingo?',
      })
      expect(res.tier).toBe('economy')
      expect(res.modelAlias).toBe('business-economy')
    })

    it('classifica perguntas sobre localização e endereço como economy', () => {
      const res = classifySofiaRequestTier({
        mensagemCliente: 'Onde fica a loja de vocês?',
      })
      expect(res.tier).toBe('economy')
      expect(res.modelAlias).toBe('business-economy')
    })

    it('classifica solicitação geral de cardápio como economy', () => {
      const res = classifySofiaRequestTier({
        mensagemCliente: 'Boa tarde, pode me enviar o cardápio de assados?',
      })
      expect(res.tier).toBe('economy')
      expect(res.modelAlias).toBe('business-economy')
    })

    it('classifica pedido simples e direto como economy', () => {
      const res = classifySofiaRequestTier({
        mensagemCliente: 'Quero reservar um frango assado para retirada às 12h.',
      })
      expect(res.tier).toBe('economy')
      expect(res.modelAlias).toBe('business-economy')
    })

    it('classifica saudações e mensagens curtas como economy', () => {
      const res = classifySofiaRequestTier({
        mensagemCliente: 'Oi, tudo bem?',
      })
      expect(res.tier).toBe('economy')
      expect(res.modelAlias).toBe('business-economy')
    })
  })

  describe('Nível SMART (business-smart)', () => {
    it('classifica objeções de preço como smart', () => {
      const res = classifySofiaRequestTier({
        mensagemCliente: 'Achei que está caro, tem como fazer menos no combo 2?',
      })
      expect(res.tier).toBe('smart')
      expect(res.modelAlias).toBe('business-smart')
    })

    it('classifica menção de concorrente como smart', () => {
      const res = classifySofiaRequestTier({
        mensagemCliente: 'No concorrente ali perto o frango está mais barato, vocês dão desconto?',
      })
      expect(res.tier).toBe('smart')
      expect(res.modelAlias).toBe('business-smart')
    })

    it('classifica restrições alimentares (sem porco, celíacos) como smart', () => {
      const res1 = classifySofiaRequestTier({
        mensagemCliente: 'Tem alguma opção sem carne suína no cardápio?',
      })
      expect(res1.tier).toBe('smart')

      const res2 = classifySofiaRequestTier({
        mensagemCliente: 'Minha filha é celíaca, a farofa tem glúten?',
      })
      expect(res2.tier).toBe('smart')
    })

    it('classifica cálculo de carne por pessoa como smart', () => {
      const res = classifySofiaRequestTier({
        mensagemCliente: 'Quantos kg de carne você recomenda para 15 pessoas?',
      })
      expect(res.tier).toBe('smart')
      expect(res.modelAlias).toBe('business-smart')
    })

    it('classifica pedidos de recomendação gastronômica como smart', () => {
      const res = classifySofiaRequestTier({
        mensagemCliente: 'Qual é o assado mais saboroso e macio que você recomenda?',
      })
      expect(res.tier).toBe('smart')
      expect(res.modelAlias).toBe('business-smart')
    })

    it('classifica solicitação de adicionais e upsell como smart', () => {
      const res = classifySofiaRequestTier({
        mensagemCliente: 'Quero adicionar maionese extra e saber se vocês têm sobremesa.',
      })
      expect(res.tier).toBe('smart')
      expect(res.modelAlias).toBe('business-smart')
    })
  })

  describe('Nível FRONTIER (business-frontier)', () => {
    it('classifica grandes eventos (>30 pessoas) como frontier', () => {
      const res = classifySofiaRequestTier({
        mensagemCliente: 'Preciso de um orçamento de churrasco para 50 pessoas no domingo.',
      })
      expect(res.tier).toBe('frontier')
      expect(res.modelAlias).toBe('business-frontier')
    })

    it('classifica eventos corporativos e empresas como frontier', () => {
      const res = classifySofiaRequestTier({
        mensagemCliente: 'Estamos organizando uma confraternização da nossa empresa e precisamos de nota fiscal para PJ.',
      })
      expect(res.tier).toBe('frontier')
      expect(res.modelAlias).toBe('business-frontier')
    })

    it('classifica casamentos e aniversários grandes como frontier', () => {
      const res = classifySofiaRequestTier({
        mensagemCliente: 'Gostaria de cotar o buffet de assados para um casamento com 120 convidados.',
      })
      expect(res.tier).toBe('frontier')
      expect(res.modelAlias).toBe('business-frontier')
    })

    it('classifica automaticamente como frontier se o carrinho atual for superior a R$ 500,00', () => {
      const res = classifySofiaRequestTier({
        mensagemCliente: 'Pode confirmar meu pedido?',
        valorCarrinhoCentavos: 65000, // R$ 650,00
      })
      expect(res.tier).toBe('frontier')
      expect(res.modelAlias).toBe('business-frontier')
    })
  })
})
