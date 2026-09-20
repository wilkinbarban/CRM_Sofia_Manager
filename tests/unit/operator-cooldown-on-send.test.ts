import { describe, expect, it, vi, beforeEach } from 'vitest'
import { enviarMensagemOperador } from '@/app/actions/atendimento'
import * as serverSupabaseModule from '@/lib/supabase/server'
import * as adminSupabaseModule from '@/lib/supabase/admin'

describe('Operator Actions: Auto-Cooldown de Sofia ao Enviar Mensagem', () => {
  let mockServerSupabase: any
  let mockAdminSupabase: any

  beforeEach(() => {
    mockServerSupabase = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: 'operador-id-1', email: 'vendedor@crmsofiamanager.com.br' } },
          error: null,
        }),
      },
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn(),
    }

    mockAdminSupabase = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn(),
      rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
    }

    vi.spyOn(serverSupabaseModule, 'createClient').mockResolvedValue(mockServerSupabase as any)
    vi.spyOn(adminSupabaseModule, 'createAdminClient').mockReturnValue(mockAdminSupabase as any)
  })

  it('triggers silenciar_sofia_cliente RPC with 30 minutes cooldown when operator replies on Web', async () => {
    // 1. Perfil do operador
    mockServerSupabase.single
      .mockResolvedValueOnce({
        data: { funcao: 'vendedor', ativo: true },
        error: null,
      })
      // 2. Conversa
      .mockResolvedValueOnce({
        data: {
          id: 'conversa-1',
          status: 'ia_atendendo',
          cliente_id: 'cliente-1',
          clientes: { telefone: null, telegram_chat_id: null },
        },
        error: null,
      })
      // 3. Insert de mensagem
      .mockResolvedValueOnce({
        data: { id: 'msg-operador-1', remetente: 'operador', conteudo: 'Olá! Sou o atendente humano.' },
        error: null,
      })

    const res = await enviarMensagemOperador('conversa-1', 'Olá! Sou o atendente humano.')

    expect(res.success).toBe(true)
    expect(mockAdminSupabase.rpc).toHaveBeenCalledWith('silenciar_sofia_cliente', {
      p_cliente_id: 'cliente-1',
      p_minutos: 30,
      p_motivo: 'cooldown_operador',
      p_usuario_id: 'operador-id-1',
    })
    expect(mockServerSupabase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        ia_ativa: false,
        status: 'aberta',
      })
    )
  })
})
