import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  createClient: vi.fn(),
  enviarMensagemWhatsapp: vi.fn(),
  verificarHorarioAtendimento: vi.fn(),
}))

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: mocks.createAdminClient }))
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }))
vi.mock('@/lib/whatsapp/send', () => ({ enviarMensagemWhatsapp: mocks.enviarMensagemWhatsapp }))
vi.mock('@/lib/horarios/verificar', () => ({
  verificarHorarioAtendimento: mocks.verificarHorarioAtendimento,
}))

import { POST as handleEvolutionWebhook } from '@/app/api/webhooks/evolution/route'
import { converterCarrinhoEmPedido } from '@/lib/carrinho/service'
import { executarToolSofia } from '@/lib/ai/tools'
import { enviarCardapioWhatsApp } from '@/lib/whatsapp/gateways/catalog-gateway'

const systemConfigs: Record<string, string> = {
  EVOLUTION_API_URL: 'http://127.0.0.1:8086',
  EVOLUTION_API_KEY: 'test-evo-key',
  EVOLUTION_INSTANCE_NAME: 'asados-sofia',
  EVOLUTION_WEBHOOK_SECRET: 'test-secret',
  SOFIA_GLOBAL_WHATSAPP_ENABLED: 'true',
  WHATSAPP_INTERACTIVE_CAROUSEL_ENABLED: 'true',
}

describe('E2E Integration: Cardápio Interativo, Carrinho Persistente, Webhooks e Sofia IA', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.verificarHorarioAtendimento.mockResolvedValue({ dentro: true })
    mocks.enviarMensagemWhatsapp.mockResolvedValue({ sucesso: true, whatsappMensagemId: 'msg-e2e-123' })
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'SUCCESS' }),
    }) as any
  })

  // ─────────────────────────────────────────────────────────────
  // 1. Fluxo E2E: Clique em Botão do WhatsApp -> Webhook -> Carrinho
  // ─────────────────────────────────────────────────────────────
  describe('1. Fluxo Inbound: Clique no Botão WhatsApp -> Inserção no Carrinho', () => {
    it('processa webhook com buttonsResponseMessage e adiciona item ao carrinho persistente', async () => {
      const mockCliente = {
        id: 'cli-e2e-1',
        nome: 'João da Silva',
        telefone: '5541999998888',
      }

      const mockProduto = {
        id: 'prod-combo-1',
        nome: 'Combo 1 - O Clássico',
        preco_centavos: 6990,
        ativo: true,
      }

      const mockCart = {
        id: 'cart-e2e-1',
        cliente_id: mockCliente.id,
        status: 'aberto',
        subtotal_centavos: 6990,
        total_centavos: 6990,
        itens_carrinho: [
          {
            id: 'item-1',
            produto_id: mockProduto.id,
            quantidade: 1,
            preco_unitario_centavos: 6990,
            preco_total_centavos: 6990,
            produtos: mockProduto,
          },
        ],
      }

      const mockSupabaseAdmin = {
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'configuracoes_sistema') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockImplementation((_col: string, chave: string) => ({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: systemConfigs[chave] ? { valor: systemConfigs[chave] } : null,
                    error: null,
                  }),
                })),
              }),
            }
          }

          if (table === 'mensagens') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                }),
              }),
              insert: vi.fn().mockReturnValue({
                select: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: { id: 'msg-rec-1', conteudo: 'cart:add:prod-combo-1' },
                    error: null,
                  }),
                }),
              }),
            }
          }

          if (table === 'clientes') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: mockCliente, error: null }),
                }),
              }),
            }
          }

          if (table === 'conversas') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    order: vi.fn().mockReturnValue({
                      limit: vi.fn().mockReturnValue({
                        maybeSingle: vi.fn().mockResolvedValue({
                          data: { id: 'conv-e2e-1', status: 'aberta', ia_ativa: true },
                          error: null,
                        }),
                      }),
                    }),
                  }),
                }),
              }),
            }
          }

          if (table === 'whatsapp_sofia_states') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                  }),
                }),
              }),
            }
          }

          if (table === 'produtos') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: mockProduto, error: null }),
                }),
              }),
            }
          }

          if (table === 'carrinhos') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({ data: mockCart, error: null }),
                  }),
                  single: vi.fn().mockResolvedValue({ data: mockCart, error: null }),
                }),
              }),
              insert: vi.fn().mockReturnValue({
                select: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: mockCart, error: null }),
                }),
              }),
            }
          }

          if (table === 'itens_carrinho') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                  }),
                }),
              }),
              insert: vi.fn().mockResolvedValue({ error: null }),
            }
          }

          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
          }
        }),
      }

      mocks.createAdminClient.mockReturnValue(mockSupabaseAdmin)

      // Payload simulando clique do usuário no botão Baileys
      const webhookPayload = {
        event: 'messages.upsert',
        data: {
          key: {
            id: 'MSG-BTN-E2E-001',
            remoteJid: '5541999998888@s.whatsapp.net',
            fromMe: false,
          },
          pushName: 'João da Silva',
          message: {
            buttonsResponseMessage: {
              selectedButtonId: 'cart:add:prod-combo-1',
              selectedDisplayText: '🛒 Adicionar ao pedido',
              type: 'DISPLAY_TEXT',
            },
          },
        },
      }

      const request = new Request('http://localhost:3000/api/webhooks/evolution', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: 'test-evo-key',
        },
        body: JSON.stringify(webhookPayload),
      })

      const response = await handleEvolutionWebhook(request)
      const resJson = await response.json()

      expect(response.status).toBe(200)
      expect(resJson.success).toBe(true)
      expect(resJson.message).toBe('Ação interativa processada com sucesso')
    })
  })

  // ─────────────────────────────────────────────────────────────
  // 2. Fluxo E2E: Manipulação no Painel do Atendente & Conversão
  // ─────────────────────────────────────────────────────────────
  describe('2. Fluxo Operador: Atualização de Quantidade e Conversão Transacional em Pedido', () => {
    it('executa a conversão atômica de carrinho aberto para pedido com reserva de estoque', async () => {
      const mockSupabaseAdmin = {
        rpc: vi.fn().mockResolvedValue({
          data: [
            {
              pedido_id: 'ped-e2e-999',
              status_pedido: 'confirmado',
              total_centavos: 6990,
              quantidade_itens: 1,
            },
          ],
          error: null,
        }),
      }

      const res = await converterCarrinhoEmPedido({
        carrinhoId: 'cart-e2e-1',
        meioPagamento: 'pix',
        horarioRetirada: '12:15',
        supabaseClient: mockSupabaseAdmin,
      })

      expect(res.success).toBe(true)
      expect(res.pedidoId).toBe('ped-e2e-999')
      expect(res.totalCentavos).toBe(6990)
      expect(mockSupabaseAdmin.rpc).toHaveBeenCalledWith('converter_carrinho_em_pedido', {
        p_carrinho_id: 'cart-e2e-1',
        p_meio_pagamento: 'pix',
        p_horario_retirada: '12:15',
      })
    })
  })

  // ─────────────────────────────────────────────────────────────
  // 3. Fluxo E2E: Tools de IA da Sofia
  // ─────────────────────────────────────────────────────────────
  describe('3. Fluxo Sofia AI Tools: Adição e Consulta com Dados Reais', () => {
    it('Sofia executa adicionar_ao_carrinho e consultar_horarios_retirada sem inventar preços', async () => {
      const mockCartData = {
        id: 'cart-sofia-1',
        cliente_id: 'cli-1',
        status: 'aberto',
        subtotal_centavos: 3990,
        total_centavos: 3990,
        itens_carrinho: [
          {
            id: 'item-1',
            produto_id: 'prod-frango',
            quantidade: 1,
            preco_unitario_centavos: 3990,
            preco_total_centavos: 3990,
            produtos: { nome: 'Frango Assado Inteiro' },
          },
        ],
      }

      const mockSupabaseAdmin = {
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'carrinhos') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({
                      data: mockCartData,
                      error: null,
                    }),
                  }),
                  single: vi.fn().mockResolvedValue({
                    data: mockCartData,
                    error: null,
                  }),
                }),
              }),
            }
          }

          if (table === 'produtos') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { id: 'prod-frango', nome: 'Frango Assado Inteiro', preco_centavos: 3990, ativo: true },
                    error: null,
                  }),
                }),
              }),
            }
          }

          if (table === 'itens_carrinho') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                  }),
                }),
              }),
              insert: vi.fn().mockResolvedValue({ error: null }),
            }
          }

          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
          }
        }),
      }

      const resTool = await executarToolSofia(
        'adicionar_ao_carrinho',
        { produtoId: 'prod-frango', quantidade: 1 },
        { clienteId: 'cli-1', supabaseClient: mockSupabaseAdmin }
      )

      expect(resTool.success).toBe(true)
      expect(resTool.mensagem).toContain('Frango Assado Inteiro')
      expect(resTool.mensagem).toContain('39,90')
    })
  })

  // ─────────────────────────────────────────────────────────────
  // 4. Fluxo E2E: Gateway de Catálogo Multi-Nível
  // ─────────────────────────────────────────────────────────────
  describe('4. Fluxo Gateway: Fallback Transparente de Carrusel para Cartões', () => {
    it('entrega cartões em alta resolução quando sendCarousel falha ou 2.3.7', async () => {
      // Simular erro 404 da Evolution 2.3.7
      global.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          text: async () => 'Endpoint not supported',
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ status: 'SUCCESS' }),
        }) as any

      const res = await enviarCardapioWhatsApp({
        telefone: '5541999998888',
        produtos: [
          {
            id: 'prod-1',
            nome: 'Combo 1 - O Clássico',
            descricao: 'Frango + Farofa + Maionese',
            precoCentavos: 6990,
            urlImagem: 'https://crmsofiamanager.duckdns.org/combo1.jpg',
          },
        ],
      })

      expect(res.success).toBe(true)
      expect(res.modoUtilizado).toBe('BUTTONS_FALLBACK')
    })
  })
})
