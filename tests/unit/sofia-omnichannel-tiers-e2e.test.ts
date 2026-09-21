import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { processarRagPipeline } from '@/lib/ai/openrouter'
import * as deepseek from '@/lib/ai/deepseek'

const mocks = vi.hoisted(() => ({
  obterConfiguracaoSistema: vi.fn(),
}))

// Mocks do Supabase e integrações de canais
vi.mock('@/lib/supabase/admin', () => {
  return {
    createAdminClient: vi.fn(() => ({
      from: vi.fn((table: string) => {
        const createQueryBuilder = () => {
          const qb: any = {
            select: vi.fn(() => qb),
            eq: vi.fn(() => qb),
            order: vi.fn(() => qb),
            limit: vi.fn(() => qb),
            in: vi.fn(() => qb),
            insert: vi.fn(() => qb),
            single: vi.fn(),
            maybeSingle: vi.fn(),
          }

          if (table === 'conversas') {
            qb.single.mockResolvedValue({
              data: {
                id: 'conversa-123',
                cliente_id: 'cliente-123',
                ia_ativa: true,
                clientes: {
                  telefone: '5541999998888',
                  nome: 'Wilkin',
                  telegram_chat_id: 'telegram-999',
                },
              },
              error: null,
            })
          } else if (table === 'mensagens') {
            qb.single.mockResolvedValue({
              data: { id: 'msg-1', conteudo: 'Resposta da Sofia' },
              error: null,
            })
            qb.limit.mockResolvedValue({ data: [], error: null })
          } else if (table === 'horarios_atendimento') {
            qb.order.mockResolvedValue({ data: [], error: null })
          } else if (table === 'carrinhos') {
            qb.maybeSingle.mockResolvedValue({ data: null, error: null })
          } else if (table === 'whatsapp_sofia_state') {
            qb.maybeSingle.mockResolvedValue({
              data: { sofia_dormindo: false, canal: 'whatsapp' },
              error: null,
            })
          } else {
            qb.maybeSingle.mockResolvedValue({ data: null, error: null })
            qb.single.mockResolvedValue({ data: null, error: null })
          }

          return qb
        }

        return createQueryBuilder()
      }),
      rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
    })),
  }
})

vi.mock('@/lib/config/sistema', () => ({
  obterConfiguracaoSistema: mocks.obterConfiguracaoSistema,
}))

vi.mock('@/lib/whatsapp/send', () => ({
  enviarMensagemWhatsapp: vi.fn().mockResolvedValue({
    sucesso: true,
    mensagem: { id: 'wpp-msg-1' },
  }),
}))

vi.mock('@/lib/telegram/send', () => ({
  enviarMensagemTelegram: vi.fn().mockResolvedValue({
    sucesso: true,
    mensagem: { id: 'tg-msg-1' },
  }),
}))

const MENSAGENS = {
  faq: 'Que horas vocês abrem no domingo?',
  objecao: 'Achei um pouco caro em relação ao concorrente, tem desconto?',
  corporativo: 'Gostaria de um orçamento corporativo de churrasco para 60 pessoas na nossa empresa.',
} as const

describe('Sofia Omnichannel RAG Pipeline — geração via DeepSeek', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    vi.restoreAllMocks()
    mocks.obterConfiguracaoSistema.mockImplementation(async (key: string) => {
      if (key === 'DEEPSEEK_API_KEY') return 'sk-deepseek-omnichannel-key'
      if (key === 'DEEPSEEK_MODEL') return 'deepseek-v4-pro'
      return null
    })
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('uses the configured DeepSeek model for every channel and never a tier alias', async () => {
    const spy = vi
      .spyOn(deepseek, 'chamarDeepSeekChat')
      .mockResolvedValue({ success: true, content: 'Resposta do provedor' })

    const web = await processarRagPipeline('conversa-123', MENSAGENS.faq, 'web')
    const whatsapp = await processarRagPipeline('conversa-123', MENSAGENS.objecao, 'whatsapp')
    const telegram = await processarRagPipeline('conversa-123', MENSAGENS.corporativo, 'telegram')

    expect(web).toMatchObject({ sucesso: true, canal: 'web', respostaIa: 'Resposta do provedor' })
    expect(whatsapp).toMatchObject({ sucesso: true, canal: 'whatsapp' })
    expect(telegram).toMatchObject({ sucesso: true, canal: 'telegram' })

    const modelos = spy.mock.calls.map(([input]) => input.model)
    expect(modelos).toEqual(['deepseek-v4-pro', 'deepseek-v4-pro', 'deepseek-v4-pro'])
    for (const alias of ['business-economy', 'business-smart', 'business-frontier']) {
      expect(modelos).not.toContain(alias)
    }
  })

  it('keeps the tier classification in the telemetry log line only', async () => {
    const logs: string[] = []
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    })
    const spy = vi
      .spyOn(deepseek, 'chamarDeepSeekChat')
      .mockResolvedValue({ success: true, content: 'ok' })

    await processarRagPipeline('conversa-123', MENSAGENS.corporativo, 'web')

    expect(logs.some((linha) => linha.includes('business-frontier'))).toBe(true)
    expect(spy.mock.calls[0][0].model).toBe('deepseek-v4-pro')
    expect(spy.mock.calls[0][0].model).not.toBe('business-frontier')
  })

  it('falls back to the environment model and then to the literal default', async () => {
    mocks.obterConfiguracaoSistema.mockResolvedValue(null)
    process.env.DEEPSEEK_API_KEY = 'sk-deepseek-env-key'
    process.env.DEEPSEEK_MODEL = 'deepseek-v4-pro'
    const spy = vi
      .spyOn(deepseek, 'chamarDeepSeekChat')
      .mockResolvedValue({ success: true, content: 'ok' })

    await processarRagPipeline('conversa-123', MENSAGENS.faq, 'web')
    expect(spy.mock.calls[0][0].model).toBe('deepseek-v4-pro')

    delete process.env.DEEPSEEK_MODEL
    await processarRagPipeline('conversa-123', MENSAGENS.faq, 'web')
    expect(spy.mock.calls[1][0].model).toBe('deepseek-flash')
  })

  it('executa fallback suave para o Modo Mock quando o provedor falha', async () => {
    vi.spyOn(deepseek, 'chamarDeepSeekChat').mockResolvedValue({
      success: false,
      error: 'DEEPSEEK_TIMEOUT',
    })

    const res = await processarRagPipeline('conversa-123', 'Qual o cardápio?', 'web')

    expect(res.sucesso).toBe(true)
    expect(res.canal).toBe('web')
    expect(res.respostaIa).toBeDefined()
  })

  it('não chama o provedor quando a chave está ausente (Modo Mock)', async () => {
    mocks.obterConfiguracaoSistema.mockResolvedValue(null)
    delete process.env.DEEPSEEK_API_KEY
    const spy = vi.spyOn(deepseek, 'chamarDeepSeekChat')

    const res = await processarRagPipeline('conversa-123', 'Qual o cardápio?', 'web')

    expect(res.sucesso).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })
})
