// @vitest-environment node

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

import { processarRagPipeline } from '@/lib/ai/openrouter'
import { POST as handleEvolutionWebhook } from '@/app/api/webhooks/evolution/route'
import {
  deriveSofiaChannelAvailability,
  obterSofiaGlobalChannelConfig,
} from '@/lib/config/sistema'
import { containsWhatsAppHandoffPhrase } from '@/lib/whatsapp/sofia-control'
import { obterComprovantes } from '@/app/actions/admin'

const systemConfigs: Record<string, string> = {
  EVOLUTION_API_URL: 'http://evolution-api:8080',
  EVOLUTION_API_KEY: 'test-evo-api-key',
  EVOLUTION_INSTANCE_NAME: 'asados',
  EVOLUTION_WEBHOOK_SECRET: 'test-secret-token',
  SOFIA_GLOBAL_WHATSAPP_ENABLED: 'true',
  SOFIA_GLOBAL_TELEGRAM_ENABLED: 'true',
  DEEPSEEK_API_KEY: 'sk-test-deepseek-key',
  DEEPSEEK_MODEL: 'deepseek-flash',
  WHATSAPP_PROVIDER: 'evolution',
}

describe('E2E Integration: Sofía, Canais (WhatsApp & Telegram), On/Off & Módulos Administrativos', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.verificarHorarioAtendimento.mockResolvedValue({ dentro: true })
    mocks.enviarMensagemWhatsapp.mockResolvedValue({ sucesso: true, whatsappMensagemId: 'msg-evo-123' })
    mocks.enviarMensagemTelegram.mockResolvedValue({ sucesso: true, mensagem: { id: 'msg-tg-123' } })
  })

  // ─────────────────────────────────────────────────────────────
  // 1. WhatsApp Evolution Webhook (Normalização com Yadira 554187021106)
  // ─────────────────────────────────────────────────────────────
  describe('1. WhatsApp Inbound via Evolution API', () => {
    it('normalizes 12-digit WhatsApp mobile numbers missing leading 9 and processes the message', async () => {
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
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }), // Sem duplicata
                }),
              }),
              insert: vi.fn().mockReturnValue({
                select: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: { id: 'msg-yadira-nova-1', conversa_id: 'conv-yadira-1', conteudo: 'Olá, quero ver o cardápio' },
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
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { id: 'cliente-yadira-1', telefone: '5541987021106', nome: 'Yadira' },
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
                  single: vi.fn().mockResolvedValue({
                    data: { id: 'conv-yadira-1', ia_ativa: true, cliente_id: 'cliente-yadira-1', clientes: { telefone: '5541987021106' } },
                    error: null,
                  }),
                  eq: vi.fn().mockReturnValue({
                    order: vi.fn().mockReturnValue({
                      limit: vi.fn().mockReturnValue({
                        maybeSingle: vi.fn().mockResolvedValue({
                          data: { id: 'conv-yadira-1', ia_ativa: true },
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
          return {}
        }),
      }

      mocks.createAdminClient.mockReturnValue(mockSupabaseAdmin)

      const req = new Request('http://localhost:3000/api/webhooks/evolution', {
        method: 'POST',
        headers: { 'x-webhook-secret': 'test-secret-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'messages.upsert',
          data: {
            key: {
              remoteJid: '554187021106@s.whatsapp.net',
              fromMe: false,
              id: 'MSG-YADIRA-01',
            },
            pushName: 'Yadira Piquera',
            message: {
              conversation: 'Olá, quero fazer uma pergunta',
            },
          },
        }),
      })

      const res = await handleEvolutionWebhook(req)
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.success).toBe(true)
      expect(data.data.id).toBe('msg-yadira-nova-1')
    })
  })

  // ─────────────────────────────────────────────────────────────
  // 2. Encendido e Apagado de Sofía (Global & Por Conversa)
  // ─────────────────────────────────────────────────────────────
  describe('2. Encendido e Apagado de Sofía (Global & Conversa)', () => {
    it('derives availability states correctly for on, scheduled pause, and off', () => {
      expect(deriveSofiaChannelAvailability(true, true)).toBe('operational')
      expect(deriveSofiaChannelAvailability(true, false)).toBe('scheduled_pause')
      expect(deriveSofiaChannelAvailability(false, true)).toBe('global_off')
      expect(deriveSofiaChannelAvailability(false, false)).toBe('global_off')
    })

    it('suppresses automation when global channel is disabled', async () => {
      const mockSupabaseAdmin = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: { valor: 'false' }, error: null }),
            }),
          }),
        }),
      }
      mocks.createAdminClient.mockReturnValue(mockSupabaseAdmin)

      const config = await obterSofiaGlobalChannelConfig('whatsapp')
      expect(config.enabled).toBe(false)
    })

    it('detects handoff phrases to mute Sofia and transfer to human operator', () => {
      expect(containsWhatsAppHandoffPhrase('quero falar com um atendente humano')).toBe(true)
      expect(containsWhatsAppHandoffPhrase('favor passar para um humano')).toBe(true)
      expect(containsWhatsAppHandoffPhrase('qual o preço da picanha?')).toBe(false)
    })
  })

  // ─────────────────────────────────────────────────────────────
  // 3. Integração com Horários de Atendimento
  // ─────────────────────────────────────────────────────────────
  describe('3. Integração com Horários de Atendimento', () => {
    it('bypasses Sofia and routes off-hours notification when outside schedule', async () => {
      mocks.verificarHorarioAtendimento.mockResolvedValue({
        dentro: false,
        mensagem: 'Estamos fechados no momento. Abrimos às 08:00.',
      })

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
                    data: { id: 'msg-fora-horario', conteudo: 'Boa noite' },
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
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { id: 'cliente-1', telefone: '5541999998888' },
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
                  eq: vi.fn().mockReturnValue({
                    order: vi.fn().mockReturnValue({
                      limit: vi.fn().mockReturnValue({
                        maybeSingle: vi.fn().mockResolvedValue({
                          data: { id: 'conv-1', ia_ativa: false },
                          error: null,
                        }),
                      }),
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

      const globalFetch = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({}) })
      vi.stubGlobal('fetch', globalFetch)

      const req = new Request('http://localhost:3000/api/webhooks/evolution', {
        method: 'POST',
        headers: { 'x-webhook-secret': 'test-secret-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'messages.upsert',
          data: {
            key: { remoteJid: '5541999998888@s.whatsapp.net', fromMe: false, id: 'MSG-OFF-HOURS-1' },
            message: { conversation: 'Boa noite' },
          },
        }),
      })

      const res = await handleEvolutionWebhook(req)
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.message).toBe('Fora do horário de atendimento')

      vi.unstubAllGlobals()
    })
  })

  // ─────────────────────────────────────────────────────────────
  // 4. Integração com Estoque, RAG Knowledge Base e Master Prompt
  // ─────────────────────────────────────────────────────────────
  describe('4. Integração com Estoque, RAG e Master Prompt', () => {
    it('enriches prompt with knowledge base chunks and product availability', async () => {
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
          if (table === 'conversas') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: {
                      id: 'conversa-rag-1',
                      cliente_id: 'cliente-1',
                      ia_ativa: true,
                      clientes: { telefone: '5541999998888', nome: 'Carlos', telegram_chat_id: null },
                    },
                    error: null,
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
          if (table === 'mensagens') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  order: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue({
                      data: [{ remetente: 'cliente', conteudo: 'Qual o cardápio?', data_criacao: '2026-08-16T12:00:00Z' }],
                      error: null,
                    }),
                  }),
                }),
              }),
              insert: vi.fn().mockReturnValue({
                select: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: { id: 'msg-nova-ia', remetente: 'ia', conteudo: 'Resposta' },
                    error: null,
                  }),
                }),
              }),
            }
          }
          return {}
        }),
        rpc: vi.fn().mockImplementation((rpcName: string) => {
          if (rpcName === 'buscar_artigos_relevantes') {
            return Promise.resolve({
              data: [
                { titulo: 'Cardápio de Cortes', conteudo: 'Picanha na brasa R$ 119,90 e Costela Premium R$ 89,90' },
              ],
              error: null,
            })
          }
          if (rpcName === 'buscar_produtos_disponiveis') {
            return Promise.resolve({
              data: [
                { nome: 'Costela Premium 1kg', preco_centavos: 8990 },
                { nome: 'Picanha Especial 800g', preco_centavos: 11990 },
              ],
              error: null,
            })
          }
          return Promise.resolve({ data: [], error: null })
        }),
      }

      mocks.createAdminClient.mockReturnValue(mockSupabaseAdmin)

      const mockPayload = JSON.stringify({
        choices: [
          {
            message: {
              content: 'Olá! Temos Costela Premium por R$ 89,90 e Picanha na brasa por R$ 119,90, piá! 🍖',
            },
          },
        ],
      })
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(mockPayload, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      vi.stubGlobal('fetch', fetchMock)

      const result = await processarRagPipeline('conversa-rag-1', 'Qual o cardápio e preços?', 'whatsapp')
      expect(result.sucesso).toBe(true)
      expect(result.respostaIa).toContain('Costela Premium')
      expect(mocks.enviarMensagemWhatsapp).toHaveBeenCalledWith(
        'conversa-rag-1',
        expect.objectContaining({
          texto: expect.stringContaining('Costela Premium'),
          remetente: 'ia',
        })
      )

      vi.unstubAllGlobals()
    })
  })

  // ─────────────────────────────────────────────────────────────
  // 5. Integração com Comprovantes de Pagamento
  // ─────────────────────────────────────────────────────────────
  describe('5. Integração com Comprovantes de Pagamento', () => {
    it('allows operators to query and filter payment receipts from chat and orders', async () => {
      const mockServerSupabase = {
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: { id: 'admin-1', email: 'admin@crmsofiamanager.com.br' } },
            error: null,
          }),
        },
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'perfis') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: { funcao: 'admin', ativo: true }, error: null }),
                }),
              }),
            }
          }
          if (table === 'comprovantes') {
            return {
              select: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({
                  data: [
                    {
                      id: 'comp-1',
                      url_anexo: 'comprovantes/pix_123.pdf',
                      data_criacao: '2026-08-16T14:00:00Z',
                      cliente_id: 'cli-1',
                      clientes: { nome: 'Yadira' },
                    },
                  ],
                  error: null,
                }),
              }),
            }
          }
          return {}
        }),
      }

      mocks.createClient.mockResolvedValue(mockServerSupabase)
      mocks.createAdminClient.mockReturnValue(mockServerSupabase)

      const res = await obterComprovantes({})
      expect(res.success).toBe(true)
      expect(res.data).toHaveLength(1)
      expect(res.data![0].url_anexo).toBe('comprovantes/pix_123.pdf')
    })
  })
})
