import { describe, expect, it, vi, beforeEach } from 'vitest'
import { processarRagPipeline } from '@/lib/ai/openrouter'
import * as adminSupabaseModule from '@/lib/supabase/admin'
import * as configModule from '@/lib/config/sistema'

describe('Cardápio RAG Integration: Entrega Consultiva no OpenRouter Pipeline', () => {
  let mockSupabase: any

  beforeEach(() => {
    mockSupabase = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single: vi.fn(),
      maybeSingle: vi.fn(),
      rpc: vi.fn(),
    }

    vi.spyOn(adminSupabaseModule, 'createAdminClient').mockReturnValue(mockSupabase as any)
    vi.spyOn(configModule, 'obterConfiguracaoSistema').mockImplementation(async (key: string) => {
      if (key === 'OPENROUTER_API_KEY') return 'placeholder'
      if (key === 'SOFIA_SYSTEM_PROMPT') return 'Você é a Sofia, atendente deste CRM.'
      return null
    })
  })

  it('delivers cardápio in mock mode with Curitibana conversational warmth and meat cuts', async () => {
    mockSupabase.single.mockResolvedValue({
      data: {
        id: 'conversa-1',
        cliente_id: 'cliente-1',
        ia_ativa: true,
        clientes: {
          telefone: '5541999998888',
          nome: 'Cliente Curitiba',
          telegram_chat_id: null,
        },
      },
      error: null,
    })

    mockSupabase.rpc.mockImplementation((rpcName: string) => {
      if (rpcName === 'buscar_artigos_relevantes') {
        return Promise.resolve({
          data: [{ titulo: 'Cardápio e Cortes', conteudo: 'Costela 1kg e Picanha 800g assadas no bafo.' }],
          error: null,
        })
      }
      if (rpcName === 'buscar_produtos_disponiveis') {
        return Promise.resolve({
          data: [
            { id: '1', nome: 'Costela Premium 1kg', preco_centavos: 8990, quantidade_estoque: 20 },
            { id: '2', nome: 'Picanha Especial 800g', preco_centavos: 11990, quantidade_estoque: 15 },
          ],
          error: null,
        })
      }
      return Promise.resolve({ data: null, error: null })
    })

    mockSupabase.limit.mockImplementation(() => {
      return Promise.resolve({
        data: [
          { remetente: 'cliente', conteudo: 'Olá', data_criacao: new Date().toISOString() }
        ],
        error: null,
      })
    })

    mockSupabase.order.mockImplementation(() => {
      return {
        ...mockSupabase,
        then: (onfulfilled: any) => Promise.resolve({
          data: [{ dia_semana: 0, hora_abertura: '11:30:00', hora_fechamento: '15:00:00', ativo: true }],
          error: null,
        }).then(onfulfilled),
        limit: () => Promise.resolve({
          data: [
            { remetente: 'cliente', conteudo: 'Olá', data_criacao: new Date().toISOString() }
          ],
          error: null,
        }),
      }
    })

    const result = await processarRagPipeline('conversa-1', 'Gostaria de ver o cardápio de vocês', 'web')

    expect(result.sucesso).toBe(true)
    expect(result.respostaIa).toBeDefined()
    expect(result.respostaIa?.toLowerCase()).toContain('cardápio')
    expect(result.respostaIa?.toLowerCase()).toContain('costela')
  })
})
