import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  validarEnvioWhatsAppSafety,
} from '@/lib/whatsapp/safety'

describe('WhatsApp Safety Gate: Governança, Limites e Bloqueio Proativo', () => {
  let mockSupabase: any

  beforeEach(() => {
    mockSupabase = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single: vi.fn(),
      maybeSingle: vi.fn(),
      rpc: vi.fn(),
    }
  })

  it('permite mensagem REACTIVE para cliente ativo dentro do rate limit', async () => {
    // 1. Cliente ativo
    mockSupabase.single.mockResolvedValueOnce({
      data: {
        id: 'cliente-1',
        telefone: '5541999998888',
        status_whatsapp: 'ativo',
        tipo_contato: 'cliente',
        inscricao_cardapio: 'desconhecido',
        automacao_permitida: true,
      },
      error: null,
    })

    // 2. Histórico recente de mensagens (apenas 1 consecutiva da IA)
    mockSupabase.limit.mockResolvedValueOnce({
      data: [{ remetente: 'cliente', data_criacao: '2026-08-16T12:00:00Z' }],
      error: null,
    })

    const result = await validarEnvioWhatsAppSafety({
      supabase: mockSupabase,
      clienteId: 'cliente-1',
      texto: 'Olá! Nosso horário é das 08:00 às 23:59.',
      categoria: 'REACTIVE',
    })

    expect(result.permitido).toBe(true)
    expect(result.motivo).toBe('ALLOWED')
  })

  it('bloqueia qualquer envio para cliente com status opted_out', async () => {
    mockSupabase.single.mockResolvedValueOnce({
      data: {
        id: 'cliente-opted-out',
        telefone: '5541999998888',
        status_whatsapp: 'opted_out',
        tipo_contato: 'cliente',
        inscricao_cardapio: 'cancelado',
        automacao_permitida: false,
      },
      error: null,
    })

    const result = await validarEnvioWhatsAppSafety({
      supabase: mockSupabase,
      clienteId: 'cliente-opted-out',
      texto: 'Confira nossas promoções de picanha hoje!',
      categoria: 'MARKETING',
    })

    expect(result.permitido).toBe(false)
    expect(result.motivo).toBe('CLIENTE_OPTED_OUT')
  })

  it('bloqueia envio de MARKETING ou CARDAPIO para candidato a emprego', async () => {
    mockSupabase.single.mockResolvedValueOnce({
      data: {
        id: 'cliente-candidato',
        telefone: '5541988887777',
        status_whatsapp: 'ativo',
        tipo_contato: 'candidato_emprego',
        inscricao_cardapio: 'cancelado',
        automacao_permitida: true,
      },
      error: null,
    })

    const result = await validarEnvioWhatsAppSafety({
      supabase: mockSupabase,
      clienteId: 'cliente-candidato',
      texto: 'Cardápio de Domingo: Costela e Picanha na brasa!',
      categoria: 'CARDAPIO',
    })

    expect(result.permitido).toBe(false)
    expect(result.motivo).toBe('CANDIDATO_EMPREGO_SEM_MARKETING')
  })

  it('bloqueia envio de CARDAPIO para cliente sem opt-in explícito', async () => {
    mockSupabase.single.mockResolvedValueOnce({
      data: {
        id: 'cliente-sem-optin',
        telefone: '5541977776666',
        status_whatsapp: 'ativo',
        tipo_contato: 'cliente',
        inscricao_cardapio: 'desconhecido',
        automacao_permitida: true,
      },
      error: null,
    })

    const result = await validarEnvioWhatsAppSafety({
      supabase: mockSupabase,
      clienteId: 'cliente-sem-optin',
      texto: 'Segue o cardápio do dia.',
      categoria: 'CARDAPIO',
    })

    expect(result.permitido).toBe(false)
    expect(result.motivo).toBe('SEM_OPT_IN_CARDAPIO')
  })

  it('bloqueia envio duplicado de CARDAPIO no mesmo dia para o mesmo cliente', async () => {
    // 1. Cliente inscrito
    mockSupabase.single.mockResolvedValueOnce({
      data: {
        id: 'cliente-inscrito',
        telefone: '5541966665555',
        status_whatsapp: 'ativo',
        tipo_contato: 'cliente',
        inscricao_cardapio: 'inscrito',
        automacao_permitida: true,
      },
      error: null,
    })

    // 2. Histórico recente ok
    mockSupabase.limit.mockResolvedValueOnce({
      data: [{ remetente: 'cliente' }],
      error: null,
    })

    // 3. Deduplicação RPC retorna false (chave já existe)
    mockSupabase.rpc.mockResolvedValueOnce({
      data: false,
      error: null,
    })

    const result = await validarEnvioWhatsAppSafety({
      supabase: mockSupabase,
      clienteId: 'cliente-inscrito',
      texto: 'Cardápio de Hoje: Costela 1kg R$ 89,90',
      categoria: 'CARDAPIO',
    })

    expect(result.permitido).toBe(false)
    expect(result.motivo).toBe('CARDAPIO_DUPLICADO_HOJE')
  })

  it('bloqueia quando o limite de mensagens consecutivas automatizadas (máx 2) sem resposta é excedido', async () => {
    // 1. Cliente ativo
    mockSupabase.single.mockResolvedValueOnce({
      data: {
        id: 'cliente-sem-resposta',
        telefone: '5541955554444',
        status_whatsapp: 'ativo',
        tipo_contato: 'cliente',
        inscricao_cardapio: 'desconhecido',
        automacao_permitida: true,
      },
      error: null,
    })

    // 2. Duas mensagens consecutivas da IA sem resposta do cliente
    mockSupabase.limit.mockResolvedValueOnce({
      data: [
        { remetente: 'ia', data_criacao: '2026-08-16T12:05:00Z' },
        { remetente: 'ia', data_criacao: '2026-08-16T12:00:00Z' },
      ],
      error: null,
    })

    const result = await validarEnvioWhatsAppSafety({
      supabase: mockSupabase,
      clienteId: 'cliente-sem-resposta',
      conversaId: 'conv-123',
      texto: 'Você ainda está aí?',
      categoria: 'SERVICE',
      origem: 'ia',
    })

    expect(result.permitido).toBe(false)
    expect(result.motivo).toBe('RATE_LIMIT_CONSECUTIVAS_EXCEDIDO')
  })

  it('permite envio de operador humano mesmo após 2 mensagens consecutivas da IA', async () => {
    mockSupabase.single.mockResolvedValueOnce({
      data: {
        id: 'cliente-humano',
        telefone: '5541955554444',
        status_whatsapp: 'ativo',
        tipo_contato: 'cliente',
        inscricao_cardapio: 'desconhecido',
        automacao_permitida: true,
      },
      error: null,
    })

    const result = await validarEnvioWhatsAppSafety({
      supabase: mockSupabase,
      clienteId: 'cliente-humano',
      texto: 'Olá, sou o atendente Carlos, em que posso ajudar?',
      categoria: 'SERVICE',
      origem: 'operador',
    })

    expect(result.permitido).toBe(true)
    expect(result.motivo).toBe('ALLOWED')
  })
})
