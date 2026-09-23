import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  createClient: vi.fn(),
  enviarMensagemWhatsapp: vi.fn(),
  enviarMensagemTelegram: vi.fn(),
  verificarHorarioAtendimento: vi.fn(),
}))

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: mocks.createAdminClient }))
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }))
vi.mock('@/lib/whatsapp/send', () => ({ enviarMensagemWhatsapp: mocks.enviarMensagemWhatsapp }))
vi.mock('@/lib/telegram/send', () => ({ enviarMensagemTelegram: mocks.enviarMensagemTelegram }))
vi.mock('@/lib/horarios/verificar', () => ({
  verificarHorarioAtendimento: mocks.verificarHorarioAtendimento,
}))
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import {
  obterOuCriarCarrinhoAtivo,
  adicionarItemAoCarrinho,
  atualizarQuantidadeItemCarrinho,
  converterCarrinhoEmPedido,
} from '@/lib/carrinho/service'
import {
  actionListarPedidos,
  actionAtualizarStatusPedido,
  actionAtualizarStatusPagamento,
  confirmarPedidoOperador,
} from '@/app/actions/pedidos'
import { processarAcaoInterativaWhatsApp } from '@/lib/whatsapp/action-router'
import { enviarCardapioWhatsApp } from '@/lib/whatsapp/gateways/catalog-gateway'
import { formatarCardapioResumido } from '@/lib/cardapio/formatar'
import { POST as handleTelegramWebhook } from '@/app/api/webhooks/telegram/route'

const systemConfigs: Record<string, string> = {
  EVOLUTION_API_URL: 'http://127.0.0.1:8086',
  EVOLUTION_API_KEY: 'test-evo-api-key',
  EVOLUTION_INSTANCE_NAME: 'asados-sofia',
  EVOLUTION_WEBHOOK_SECRET: 'test-evo-secret',
  SOFIA_GLOBAL_WHATSAPP_ENABLED: 'true',
  SOFIA_GLOBAL_TELEGRAM_ENABLED: 'true',
  WHATSAPP_INTERACTIVE_CAROUSEL_ENABLED: 'true',
  WHATSAPP_PROVIDER: 'evolution',
  TELEGRAM_BOT_TOKEN: '123456:ABC-DEF-GHI-TEST-TOKEN',
}

describe('E2E Lifecycle Test: Ciclo Completo de Pedidos (Sem e Com Intervenção da Sofia)', () => {
  const mockCliente = {
    id: 'cli-e2e-100',
    nome: 'Dra. Márcia Fagundes',
    telefone: '5541991234567',
    email: 'marcia.curitiba@gmail.com',
  }

  const mockOperador = {
    id: 'op-user-1',
    nome: 'Carlos Atendente',
    funcao: 'vendedor',
    ativo: true,
  }

  const mockProdutos = [
    {
      id: 'prod-combo-1',
      nome: 'Combo 1 - O Clássico Brasa & Sabor',
      descricao: 'Frango assado recheado + maionese artesanal 500g + risoto curitibano',
      preco_centavos: 6990,
      precoCentavos: 6990,
      url_imagem: 'https://asados.com.br/images/combo1.jpg',
      urlImagem: 'https://asados.com.br/images/combo1.jpg',
      ativo: true,
    },
    {
      id: 'prod-costela-1',
      nome: 'Costela Fogo de Chão (Kg)',
      descricao: 'Costela bovina premium assada lentamente por 8 horas',
      preco_centavos: 7990,
      precoCentavos: 7990,
      url_imagem: 'https://asados.com.br/images/costela.jpg',
      urlImagem: 'https://asados.com.br/images/costela.jpg',
      ativo: true,
    },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.verificarHorarioAtendimento.mockResolvedValue({ dentro: true })
    mocks.enviarMensagemWhatsapp.mockResolvedValue({ sucesso: true, whatsappMensagemId: 'wa-msg-e2e-1' })
    mocks.enviarMensagemTelegram.mockResolvedValue({ sucesso: true, mensagem: { id: 'tg-msg-e2e-1' } })

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'SUCCESS', messageId: 'wa-card-123' }),
      text: async () => JSON.stringify({ status: 'SUCCESS' }),
    }) as any
  })

  // ═════════════════════════════════════════════════════════════════════════
  // PARTE 1: CICLO COMPLETO SEM A INTERVENÇÃO DA SOFIA (MANUAL / OPERADOR)
  // ═════════════════════════════════════════════════════════════════════════
  describe('PARTE 1: Fluxo Completo Sem Intervenção da Sofia (Cliente Web + Operador)', () => {
    let mockCartState: any = null
    let mockPedidoState: any = null

    it('1.1 Cliente cria carrinho e seleciona produtos via Web App', async () => {
      mockCartState = {
        id: 'cart-manual-1',
        cliente_id: mockCliente.id,
        canal: 'web',
        status: 'aberto',
        tipo_entrega: 'retirada',
        horario_retirada: '12:00',
        subtotal_centavos: 0,
        taxa_entrega_centavos: 0,
        desconto_centavos: 0,
        total_centavos: 0,
        itens_carrinho: [],
      }

      const mockSupabaseAdmin = {
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'carrinhos') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockImplementation((col: string) => {
                  if (col === 'id') {
                    return {
                      single: vi.fn().mockResolvedValue({ data: mockCartState, error: null }),
                    }
                  }
                  return {
                    eq: vi.fn().mockReturnValue({
                      maybeSingle: vi.fn().mockResolvedValue({ data: mockCartState, error: null }),
                    }),
                  }
                }),
              }),
              update: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({ data: null, error: null }),
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
              insert: vi.fn().mockImplementation((item) => {
                mockCartState.itens_carrinho.push({
                  id: 'item-cart-1',
                  carrinho_id: mockCartState.id,
                  produto_id: item.produto_id,
                  quantidade: item.quantidade,
                  preco_unitario_centavos: item.preco_unitario_centavos,
                  preco_total_centavos: item.preco_unitario_centavos * item.quantidade,
                  produtos: mockProdutos[0],
                })
                mockCartState.subtotal_centavos = 6990
                mockCartState.total_centavos = 6990
                return { error: null }
              }),
            }
          }
          if (table === 'produtos') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: mockProdutos[0], error: null }),
                  single: vi.fn().mockResolvedValue({ data: mockProdutos[0], error: null }),
                }),
              }),
            }
          }
          return {}
        }),
      }

      mocks.createAdminClient.mockReturnValue(mockSupabaseAdmin)

      // Obter ou criar carrinho
      const cartRes = await obterOuCriarCarrinhoAtivo(mockCliente.id, { canal: 'web' })
      expect(cartRes.success).toBe(true)
      expect(cartRes.carrinho?.id).toBe('cart-manual-1')
      expect(cartRes.carrinho?.status).toBe('aberto')

      // Adicionar Combo 1
      const addRes = await adicionarItemAoCarrinho({
        clienteId: mockCliente.id,
        produtoId: mockProdutos[0].id,
        quantidade: 1,
        canal: 'web',
      })
      expect(addRes.success).toBe(true)
      expect(addRes.carrinho?.itens_carrinho).toHaveLength(1)
      expect(addRes.carrinho?.total_centavos).toBe(6990)
    })

    it('1.2 Atendente visualiza e edita o carrinho do cliente no painel de atendimento', async () => {
      const mockSupabaseAdmin = {
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'carrinhos') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockImplementation((col: string) => {
                  if (col === 'id') {
                    return {
                      single: vi.fn().mockResolvedValue({ data: mockCartState, error: null }),
                    }
                  }
                  return {
                    eq: vi.fn().mockReturnValue({
                      maybeSingle: vi.fn().mockResolvedValue({ data: mockCartState, error: null }),
                    }),
                  }
                }),
              }),
              update: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }
          }
          if (table === 'itens_carrinho') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({
                      data: mockCartState.itens_carrinho[0],
                      error: null,
                    }),
                  }),
                }),
              }),
              update: vi.fn().mockImplementation((payload) => {
                mockCartState.itens_carrinho[0].quantidade = payload.quantidade
                mockCartState.itens_carrinho[0].preco_total_centavos = mockCartState.itens_carrinho[0].preco_unitario_centavos * payload.quantidade
                mockCartState.subtotal_centavos = mockCartState.itens_carrinho[0].preco_total_centavos
                mockCartState.total_centavos = mockCartState.subtotal_centavos
                return {
                  eq: vi.fn().mockResolvedValue({ data: null, error: null }),
                }
              }),
            }
          }
          return {}
        }),
      }

      mocks.createAdminClient.mockReturnValue(mockSupabaseAdmin)

      // Atendente aumenta a quantidade para 2 unidades
      const updateRes = await atualizarQuantidadeItemCarrinho({
        clienteId: mockCliente.id,
        produtoId: mockProdutos[0].id,
        quantidade: 2,
      })
      expect(updateRes.success).toBe(true)
      expect(updateRes.carrinho?.itens_carrinho[0].quantidade).toBe(2)
      expect(updateRes.carrinho?.total_centavos).toBe(13980)
    })

    it('1.3 Operador converte o carrinho em Pedido Oficial com reserva atômica de estoque', async () => {
      mockPedidoState = {
        id: 'ped-oficial-100',
        cliente_id: mockCliente.id,
        status: 'confirmado',
        tipo_entrega: 'retirada',
        taxa_entrega_centavos: 0,
        total_produtos_centavos: 13980,
        total_pedido_centavos: 13980,
        status_pagamento: 'pendente',
        meio_pagamento: 'pix',
        estoque_estado: 'aplicado',
        data_criacao: '2026-08-17T12:30:00Z',
      }

      const mockSupabaseAdmin = {
        rpc: vi.fn().mockResolvedValue({
          data: {
            pedido_id: mockPedidoState.id,
            total_centavos: mockPedidoState.total_pedido_centavos,
          },
          error: null,
        }),
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'carrinhos') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({
                      data: { ...mockCartState, status: 'aberto', itens_carrinho: [] },
                      error: null,
                    }),
                  }),
                }),
              }),
            }
          }
          return {}
        }),
      }

      mocks.createAdminClient.mockReturnValue(mockSupabaseAdmin)

      const conversao = await converterCarrinhoEmPedido({
        carrinhoId: mockCartState.id,
        meioPagamento: 'pix',
        horarioRetirada: '12:00 (Balcão Umbará)',
      })
      expect(conversao.success).toBe(true)
      expect(conversao.pedidoId).toBe('ped-oficial-100')
      expect(conversao.totalCentavos).toBe(13980)
      expect(mockSupabaseAdmin.rpc).toHaveBeenCalledWith('converter_carrinho_em_pedido', {
        p_carrinho_id: mockCartState.id,
        p_meio_pagamento: 'pix',
        p_horario_retirada: '12:00 (Balcão Umbará)',
      })
    })

    it('1.4 Confirmação pelo operador e aprovação do pagamento', async () => {
      const mockSupabaseServer = {
        auth: {
          getUser: vi.fn().mockResolvedValue({ data: { user: { id: mockOperador.id } }, error: null }),
        },
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'perfis') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: mockOperador, error: null }),
                }),
              }),
            }
          }
          if (table === 'pedidos') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: mockPedidoState, error: null }),
                }),
              }),
            }
          }
          return {}
        }),
        rpc: vi.fn().mockReturnValue({
          single: vi.fn().mockImplementation(() => {
            mockPedidoState.status_pagamento = 'aprovado'
            return Promise.resolve({ data: mockPedidoState, error: null })
          }),
        }),
      }

      mocks.createClient.mockResolvedValue(mockSupabaseServer as any)

      // Confirmar o pedido no fluxo de lifecycle
      const confRes = await confirmarPedidoOperador(mockPedidoState.id)
      expect(confRes.success).toBe(true)

      // Aprovar pagamento (PIX conferido)
      const payRes = await actionAtualizarStatusPagamento({
        pedidoId: mockPedidoState.id,
        statusPagamento: 'aprovado',
        reason: 'PIX conferido pelo operador',
      })
      expect(payRes.success).toBe(true)
      expect((payRes.data as any)?.status_pagamento).toBe('aprovado')
    })

    it('1.5 Finalização do pedido: marcação de status como Entregue no balcão Umbará', async () => {
      const directStatusUpdate = vi.fn()
      const transitionRpc = vi.fn().mockImplementation(
        (name: string, params: {
          p_pedido_id: string
          p_novo_status: string
          p_idempotency_key: string
          p_reason: string | null
        }) => ({
          single: vi.fn().mockImplementation(() => {
            expect(name).toBe('transicionar_pedido')
            mockPedidoState.status = params.p_novo_status
            return Promise.resolve({
              data: {
                pedido_id: params.p_pedido_id,
                status: mockPedidoState.status,
                valid_next_actions: [],
                idempotent: false,
              },
              error: null,
            })
          }),
        }),
      )
      const mockSupabaseServer = {
        auth: {
          getUser: vi.fn().mockResolvedValue({ data: { user: { id: mockOperador.id } }, error: null }),
        },
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'perfis') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: mockOperador, error: null }),
                }),
              }),
            }
          }
          if (table === 'pedidos') {
            return {
              update: directStatusUpdate,
            }
          }
          return {}
        }),
        rpc: transitionRpc,
      }

      mocks.createClient.mockResolvedValue(mockSupabaseServer as any)

      const statusRes = await actionAtualizarStatusPedido({
        pedidoId: mockPedidoState.id,
        novoStatus: 'entregue',
        idempotencyKey: 'lifecycle-manual-delivery-1',
        reason: 'Pedido retirado no balcão Umbará',
      })

      expect(statusRes.success).toBe(true)
      expect((statusRes.data as any)?.status).toBe('entregue')
      expect(transitionRpc).toHaveBeenCalledWith('transicionar_pedido', {
        p_pedido_id: mockPedidoState.id,
        p_novo_status: 'entregue',
        p_idempotency_key: 'lifecycle-manual-delivery-1',
        p_reason: 'Pedido retirado no balcão Umbará',
      })
      expect(directStatusUpdate).not.toHaveBeenCalled()
    })
  })

  // ═════════════════════════════════════════════════════════════════════════
  // PARTE 2: CICLO COMPLETO COM A INTERVENÇÃO DA SOFIA (IA EM 3 CANAIS)
  // ═════════════════════════════════════════════════════════════════════════
  describe('PARTE 2: Fluxo Completo Com Intervenção da Sofia (WhatsApp, Telegram e Web)', () => {
    // -------------------------------------------------------------
    // 2.1 WhatsApp (Evolution API / Baileys) com Formato de Tarjetas
    // -------------------------------------------------------------
    describe('2.1 Sofia no WhatsApp (Evolution API & Tarjetas Interativas)', () => {
      it('entrega o cardápio em formato de carrossel/tarjetas com fotos, preços BRL e botões interativos', async () => {
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
            return {}
          }),
        }

        mocks.createAdminClient.mockReturnValue(mockSupabaseAdmin)

        // Enviar cardápio interativo para o WhatsApp
        const result = await enviarCardapioWhatsApp({
          telefone: mockCliente.telefone,
          produtos: mockProdutos as any,
        })

        expect(result.success).toBe(true)
        expect(result.modoUtilizado).toBe('CAROUSEL_NATIVO')

        // Validar payload HTTP enviado para Evolution API
        expect(global.fetch).toHaveBeenCalledWith(
          'http://127.0.0.1:8086/message/sendCarousel/asados-sofia',
          expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({
              apikey: 'test-evo-api-key',
              'Content-Type': 'application/json',
            }),
            body: expect.stringContaining('Combo 1 - O Clássico Brasa & Sabor'),
          })
        )

        // Validar botões e IDs de ação interativa no corpo da requisição
        const fetchBody = JSON.parse((global.fetch as any).mock.calls[0][1].body)
        expect(fetchBody.number).toBe(mockCliente.telefone)
        expect(fetchBody.cards).toHaveLength(2)
        expect(fetchBody.cards[0].imageUrl).toBe(mockProdutos[0].url_imagem)
        expect(fetchBody.cards[0].body).toContain('69,90')
        expect(fetchBody.cards[0].buttons[0].id).toBe(`cart:add:${mockProdutos[0].id}`)
      })

      it('processa o clique do cliente no botão de adicionar ao pedido e atualiza o carrinho', async () => {
        const mockCartWa = {
          id: 'cart-wa-100',
          cliente_id: mockCliente.id,
          canal: 'whatsapp',
          status: 'aberto',
          subtotal_centavos: 6990,
          total_centavos: 6990,
          itens_carrinho: [
            {
              id: 'item-wa-1',
              produto_id: mockProdutos[0].id,
              quantidade: 1,
              preco_unitario_centavos: 6990,
              preco_total_centavos: 6990,
              produtos: mockProdutos[0],
            },
          ],
        }

        const mockSupabaseAdmin = {
          from: vi.fn().mockImplementation((table: string) => {
            if (table === 'produtos') {
              return {
                select: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({ data: mockProdutos[0], error: null }),
                  }),
                }),
              }
            }
            if (table === 'carrinhos') {
              return {
                select: vi.fn().mockReturnValue({
                  eq: vi.fn().mockImplementation((col: string) => {
                    if (col === 'id') {
                      return {
                        single: vi.fn().mockResolvedValue({ data: mockCartWa, error: null }),
                      }
                    }
                    return {
                      eq: vi.fn().mockReturnValue({
                        maybeSingle: vi.fn().mockResolvedValue({
                          data: mockCartWa,
                          error: null,
                        }),
                      }),
                    }
                  }),
                }),
                update: vi.fn().mockReturnValue({
                  eq: vi.fn().mockResolvedValue({ data: null, error: null }),
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
                insert: vi.fn().mockReturnValue({ error: null }),
              }
            }
            return {}
          }),
        }

        mocks.createAdminClient.mockReturnValue(mockSupabaseAdmin)

        const actionResult = await processarAcaoInterativaWhatsApp({
          clienteId: mockCliente.id,
          telefone: mockCliente.telefone,
          interactiveId: `cart:add:${mockProdutos[0].id}`,
        })

        expect(actionResult.handled).toBe(true)
        expect(actionResult.respostaTexto).toContain('Combo 1 - O Clássico Brasa & Sabor')
        expect(actionResult.respostaTexto).toContain('adicionado ao seu pedido')
      })
    })

    // -------------------------------------------------------------
    // 2.2 Telegram Bot com Formato de Cartões e Botões Inline
    // -------------------------------------------------------------
    describe('2.2 Sofia no Telegram (Cartões com Foto & Inline Keyboards)', () => {
      it('formata e entrega cardápio com descrições, preços e fotos para Telegram e Web', () => {
        const textoCardapioTg = formatarCardapioResumido(mockProdutos as any)

        expect(textoCardapioTg).toContain('CRM SOFIA MANAGER')
        expect(textoCardapioTg.toUpperCase()).toContain('COMBO 1 - O CLÁSSICO BRASA & SABOR')
        expect(textoCardapioTg).toContain('R$ 69,90')
        expect(textoCardapioTg.toUpperCase()).toContain('COSTELA FOGO DE CHÃO (KG)')
        expect(textoCardapioTg).toContain('R$ 79,90')
        expect(textoCardapioTg).toContain('produtos e combos especiais')
      })

      it('processa mensagem do cliente no webhook do Telegram e responde com Sofia', async () => {
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
            if (table === 'clientes') {
              return {
                select: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({
                      data: { id: mockCliente.id, nome: mockCliente.nome, telefone: mockCliente.telefone },
                      error: null,
                    }),
                  }),
                }),
              }
            }
            if (table === 'conversas') {
              return {
                select: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    neq: vi.fn().mockReturnValue({
                      order: vi.fn().mockReturnValue({
                        limit: vi.fn().mockReturnValue({
                          maybeSingle: vi.fn().mockResolvedValue({
                            data: { id: 'conv-tg-100', cliente_id: mockCliente.id, ia_ativa: true, canal: 'telegram' },
                            error: null,
                          }),
                        }),
                      }),
                    }),
                  }),
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
                      data: { id: 'msg-tg-inbound-1', conversa_id: 'conv-tg-100', conteudo: 'Quero ver o cardápio' },
                      error: null,
                    }),
                  }),
                }),
              }
            }
            return {}
          }),
        }

        mocks.createAdminClient.mockReturnValue(mockSupabaseAdmin)

        const fakeTgRequest = new Request('http://localhost:3000/api/webhooks/telegram', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            update_id: 998877,
            message: {
              message_id: 101,
              from: { id: 12345678, first_name: 'Márcia', username: 'marcia_curitiba' },
              chat: { id: 12345678, type: 'private' },
              date: 1723900000,
              text: 'Olá Sofia, o que vocês têm de bom hoje?',
            },
          }),
        })

        const tgResponse = await handleTelegramWebhook(fakeTgRequest)
        expect(tgResponse.status).toBe(200)
        const tgBody = await tgResponse.json()
        expect(tgBody.ok).toBe(true)
      })
    })

    // -------------------------------------------------------------
    // 2.3 Web App Chat: Interação e Fechamento no Atendimento
    // -------------------------------------------------------------
    describe('2.3 Sofia no Web Chat e Fechamento Unificado no Atendimento', () => {
      it('consolida pedidos da Sofia no painel de atendimento e confirma com sucesso', async () => {
        const mockPedidosGlobal = [
          {
            id: 'ped-sofia-200',
            status: 'confirmado',
            tipo_entrega: 'retirada',
            total_produtos_centavos: 6990,
            total_pedido_centavos: 6990,
            status_pagamento: 'aprovado',
            meio_pagamento: 'pix',
            data_criacao: '2026-08-17T13:00:00Z',
            cliente_id: mockCliente.id,
            clientes: mockCliente,
            itens: [
              {
                id: 'item-sofia-1',
                quantidade: 1,
                preco_unitario_centavos: 6990,
                preco_total_centavos: 6990,
                produtos: mockProdutos[0],
              },
            ],
          },
        ]

        const directStatusUpdate = vi.fn()
        const transitionRpc = vi.fn().mockImplementation(
          (name: string, params: {
            p_pedido_id: string
            p_novo_status: string
            p_idempotency_key: string
            p_reason: string | null
          }) => ({
            single: vi.fn().mockImplementation(() => {
              expect(name).toBe('transicionar_pedido')
              mockPedidosGlobal[0].status = params.p_novo_status
              return Promise.resolve({
                data: {
                  pedido_id: params.p_pedido_id,
                  status: mockPedidosGlobal[0].status,
                  valid_next_actions: [],
                  idempotent: false,
                },
                error: null,
              })
            }),
          }),
        )
        const mockSupabaseServer = {
          auth: {
            getUser: vi.fn().mockResolvedValue({ data: { user: { id: mockOperador.id } }, error: null }),
          },
          from: vi.fn().mockImplementation((table: string) => {
            if (table === 'perfis') {
              return {
                select: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    single: vi.fn().mockResolvedValue({ data: mockOperador, error: null }),
                  }),
                }),
              }
            }
            if (table === 'pedidos') {
              return {
                select: vi.fn().mockReturnValue({
                  order: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue({ data: mockPedidosGlobal, error: null }),
                  }),
                }),
                update: directStatusUpdate,
              }
            }
            return {}
          }),
          rpc: transitionRpc,
        }

        mocks.createClient.mockResolvedValue(mockSupabaseServer as any)

        // 1. Listar pedidos gerados com assistência da Sofia
        const pedidosListRes = await actionListarPedidos({ limite: 50 })
        expect(pedidosListRes.success).toBe(true)
        expect(pedidosListRes.data).toHaveLength(1)
        expect(pedidosListRes.data?.[0].id).toBe('ped-sofia-200')
        expect(pedidosListRes.data?.[0].itens?.[0].preco_total_centavos).toBe(6990)

        // 2. Operador finaliza a comanda
        const finalizacaoRes = await actionAtualizarStatusPedido({
          pedidoId: 'ped-sofia-200',
          novoStatus: 'entregue',
          idempotencyKey: 'lifecycle-sofia-delivery-1',
          reason: 'Pedido da Sofia retirado no balcão',
        })
        expect(finalizacaoRes.success).toBe(true)
        expect((finalizacaoRes.data as any)?.status).toBe('entregue')
        expect(transitionRpc).toHaveBeenCalledWith('transicionar_pedido', {
          p_pedido_id: 'ped-sofia-200',
          p_novo_status: 'entregue',
          p_idempotency_key: 'lifecycle-sofia-delivery-1',
          p_reason: 'Pedido da Sofia retirado no balcão',
        })
        expect(directStatusUpdate).not.toHaveBeenCalled()
      })
    })
  })
})
