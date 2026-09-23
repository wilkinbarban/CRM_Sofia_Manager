import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  enviarCardapioWhatsApp,
      enviarPromptCatalogoWhatsApp,
      enviarCatalogoCombosWhatsApp,
  montarPayloadCarrossel,
  montarPayloadCardsFallback,
  type ProdutoCardapioItem,
} from '@/lib/whatsapp/gateways/catalog-gateway'
import * as configSistema from '@/lib/config/sistema'

// Mock de fetch global
const mockFetch = vi.fn()
global.fetch = mockFetch

vi.mock('@/lib/config/sistema', () => ({
  obterConfiguracaoSistema: vi.fn(),
}))

describe('WhatsApp Catalog Gateway & Multi-Level Fallback (TDD)', () => {
  const mockProdutos: ProdutoCardapioItem[] = [
    {
      id: 'prod-1',
      nome: 'Combo 1 - O Clássico Brasa & Sabor',
      descricao: 'Frango Assado + Farofa + Maionese Especial',
      precoCentavos: 6990,
      urlImagem: 'https://crmsofiamanager.duckdns.org/combo1.jpg',
    },
    {
      id: 'prod-2',
      nome: 'Combo 2 - Costela Suprema',
      descricao: '1kg de Costela macia no bafo + Farofa da Casa',
      precoCentavos: 11990,
      urlImagem: 'https://crmsofiamanager.duckdns.org/combo2.jpg',
    },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
        mockFetch.mockReset()
    vi.mocked(configSistema.obterConfiguracaoSistema).mockImplementation(async (key: string) => {
      if (key === 'EVOLUTION_API_URL') return 'http://127.0.0.1:8086'
      if (key === 'EVOLUTION_API_KEY') return 'test-api-key'
      if (key === 'EVOLUTION_INSTANCE_NAME') return 'asados-bot'
      if (key === 'WHATSAPP_INTERACTIVE_CAROUSEL_ENABLED') return 'true'
      return null
    })
  })

  it('montarPayloadCarrossel gera estrutura correta para o endpoint sendCarousel da Evolution 2.4.x', () => {
    const payload = montarPayloadCarrossel({
      telefone: '5541999998888',
      produtos: mockProdutos,
    })

    expect(payload.number).toBe('5541999998888')
    expect(payload.body).toContain('O que você deseja hoje')
    expect(payload.cards).toHaveLength(2)
    expect(payload.cards[0].title).toBe('🍗 Combo 1 - O Clássico Brasa & Sabor')
    expect(payload.cards[0].imageUrl).toBe('https://crmsofiamanager.duckdns.org/combo1.jpg')
    expect(payload.cards[0].buttons[0].id).toBe('cart:add:prod-1')
    expect(payload.cards[0].buttons[0].displayText).toContain('Adicionar')
  })

  it('montarPayloadCardsFallback formata cartões da Figura 4 com links e opções numeradas', () => {
    const cards = montarPayloadCardsFallback({
      telefone: '5541999998888',
      produtos: mockProdutos,
    })

    expect(cards).toHaveLength(2)
    expect(cards[0].imageUrl).toBe('https://crmsofiamanager.duckdns.org/combo1.jpg')
    expect(cards[0].caption).toContain('COMBO 1 - O CLÁSSICO BRASA & SABOR')
    expect(cards[0].caption).toContain('69,90')
    expect(cards[0].caption).toContain('1️⃣ Adicionar ao pedido')
  })

  it('enviarPromptCatalogoWhatsApp sends official catalog prompt via sendText', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ key: { id: 'ack-1' } }) })
    const resultado = await enviarPromptCatalogoWhatsApp('5541999998888')
    expect(resultado).toEqual({ success: true, messageId: 'ack-1' })
    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8086/message/sendText/asados-bot',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Origin: 'https://crmsofiamanager.duckdns.org' }),
        body: expect.stringContaining('Catálogo de Produtos'),
      }),
    )
  })

    it('enviarCatalogoCombosWhatsApp sends at most four individual image messages', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ key: { id: 'ack' } }) })
      const produtos = Array.from({ length: 5 }, (_, index) => ({
        id: `a${index + 1}`, nome: `Combo ${index + 1}`, descricao: `Descrição ${index + 1}`,
        precoCentavos: 1000 + index, urlImagem: `https://example.test/${index + 1}.jpg`,
      }))
      const resultado = await enviarCatalogoCombosWhatsApp('5541999998888', produtos)
      expect(resultado).toEqual({ success: true, sent: 4 })
      expect(mockFetch).toHaveBeenCalledTimes(4)
      for (const [url, init] of mockFetch.mock.calls) {
        expect(url).toBe('http://127.0.0.1:8086/message/sendMedia/asados-bot')
        expect(init).toEqual(expect.objectContaining({
          headers: expect.objectContaining({ apikey: 'test-api-key', Origin: 'https://crmsofiamanager.duckdns.org' }),
        }))
      }
    })

    it('skips invalid image cards and reports no viable products honestly', async () => {
          const resultado = await enviarCatalogoCombosWhatsApp('5541999998888', [{ ...mockProdutos[0], urlImagem: null }])
          expect(resultado).toEqual({ success: false, sent: 0, error: 'no_viable_products' })
          expect(mockFetch).not.toHaveBeenCalled()
        })

        it('stops after the first sequential acknowledgement failure', async () => {
          mockFetch.mockResolvedValueOnce({ status: 201, json: async () => ({ key: { id: 'ack-1' } }) }).mockResolvedValueOnce({ status: 503, json: async () => ({}) }).mockResolvedValueOnce({ status: 201, json: async () => ({ key: { id: 'ack-3' } }) })
          const resultado = await enviarCatalogoCombosWhatsApp('5541999998888', [...mockProdutos, { id: 'prod-3', nome: 'Combo 3', descricao: 'Descrição', precoCentavos: 1000, urlImagem: 'https://example.test/3.jpg' }])
          expect(resultado).toEqual({ success: false, sent: 1, error: 'provider_unavailable' })
          expect(mockFetch).toHaveBeenCalledTimes(2)
        })

        it('URL-encodes the configured Evolution instance', async () => {
          vi.mocked(configSistema.obterConfiguracaoSistema).mockImplementation(async (key: string) => key === 'EVOLUTION_API_URL' ? 'http://127.0.0.1:8086' : key === 'EVOLUTION_API_KEY' ? 'key' : key === 'EVOLUTION_API_INSTANCE_NAME' ? 'asados/bot' : key === 'EVOLUTION_INSTANCE_NAME' ? 'asados/bot' : key === 'WHATSAPP_INTERACTIVE_CAROUSEL_ENABLED' ? 'true' : null)
          mockFetch.mockResolvedValueOnce({ status: 200, json: async () => ({ key: { id: 'ack-1' } }) })
          await enviarPromptCatalogoWhatsApp('5541999998888')
          expect(mockFetch.mock.calls[0][0]).toBe('http://127.0.0.1:8086/message/sendText/asados%2Fbot')
        })

        it('enviarCardapioWhatsApp envia carrossel nativo quando feature flag está ativa e API responde 200', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
          text: async () => '',
      json: async () => ({ status: 'SUCCESS' }),
    })

    const resultado = await enviarCardapioWhatsApp({
      telefone: '5541999998888',
      produtos: mockProdutos,
    })

    expect(resultado.success).toBe(true)
    expect(resultado.modoUtilizado).toBe('CAROUSEL_NATIVO')
    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8086/message/sendCarousel/asados-bot',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          apikey: 'test-api-key',
        }),
      })
    )
  })

  it('enviarCardapioWhatsApp executa fallback para botões se o carrossel falhar', async () => {
    // 1. Falha no envio do carrossel (ex: Evolution 2.3.7 retorna 404 para sendCarousel)
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => 'Endpoint sendCarousel not found on 2.3.7',
    })

    mockFetch.mockResolvedValueOnce({ ok: true, status: 201 })

    const resultado = await enviarCardapioWhatsApp({
      telefone: '5541999998888',
      produtos: mockProdutos,
    })

    expect(resultado.success).toBe(true)
    expect(resultado.modoUtilizado).toBe('BUTTONS_FALLBACK')
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('continua para lista quando o fallback de botões é rejeitado', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'carousel unavailable' })
      .mockResolvedValueOnce({ ok: false, status: 422, text: async () => 'buttons unavailable' })
      .mockResolvedValueOnce({ ok: true, status: 201 })

    const resultado = await enviarCardapioWhatsApp({
      telefone: '5541999998888',
      produtos: mockProdutos,
    })

    expect(resultado).toEqual({
      success: true,
      modoUtilizado: 'LIST_FALLBACK',
    })
    expect(mockFetch).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8086/message/sendList/asados-bot',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('executa a cascata carousel → cards → text e retorna falha se nenhuma entrega funcionar', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'carousel unavailable' })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'buttons unavailable' })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'list unavailable' })
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'text unavailable' })

    const resultado = await enviarCardapioWhatsApp({
      telefone: '5541999998888',
      produtos: mockProdutos,
    })

    expect(resultado.success).toBe(false)
    expect(resultado.modoUtilizado).toBe('TEXT_FALLBACK')
    expect(resultado.error).toContain('Evolution API rejeitou sendText com status 503')
    expect(mockFetch).toHaveBeenCalledTimes(4)
  })
})
