// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  allowsIntegrationMock: vi.fn(),
  createAdminClient: vi.fn(),
  obterConfiguracaoSistema: vi.fn(),
  insert: vi.fn(),
  whatsappSend: vi.fn(),
  telegramSend: vi.fn(),
  sofiaEligible: vi.fn(),
}))

vi.mock('@/lib/runtime/environment', () => ({
  allowsIntegrationMock: mocks.allowsIntegrationMock,
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: mocks.createAdminClient,
}))

vi.mock('@/lib/config/sistema', () => ({
  obterConfiguracaoSistema: mocks.obterConfiguracaoSistema,
}))

vi.mock('@/lib/whatsapp/send', () => ({
  enviarMensagemWhatsapp: mocks.whatsappSend,
}))

vi.mock('@/lib/telegram/send', () => ({
  enviarMensagemTelegram: mocks.telegramSend,
}))

vi.mock('@/lib/whatsapp/sofia-control', () => ({
  isWhatsAppInboundEligibleForSofia: mocks.sofiaEligible,
}))

import * as deepseek from '@/lib/ai/deepseek'
import {
  agendarPedidoNoCalendario,
  atualizarPedidoNoCalendarioComoPago,
} from '@/lib/calendar/google'
import {
  isSofiaAiGenerationEnabled,
  processarRagBatchPipeline,
  processarRagPipeline,
} from '@/lib/ai/openrouter'

function createPipelineSupabase() {
  return {
    from: vi.fn((table: string) => {
      if (table === 'conversas') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({
                data: {
                  id: 'conversa-1',
                  cliente_id: 'cliente-1',
                  ia_ativa: true,
                  clientes: { telefone: '5541999998888', nome: 'Cliente', telegram_chat_id: 'telegram-999' },
                },
                error: null,
              }),
            })),
          })),
        }
      }

      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            order: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue({ data: [], error: null }),
            })),
          })),
        })),
        insert: mocks.insert,
      }
    }),
    rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
  }
}

const originalEnv = process.env

describe('integration fail-closed policy', () => {
  beforeEach(() => {
    // The credential resolver reads the environment as a fallback, so every test
    // controls the credential exclusively through the configuration store and the
    // machine's own DEEPSEEK_API_KEY can never leak into an assertion.
    process.env = { ...originalEnv }
    delete process.env.DEEPSEEK_API_KEY
    mocks.allowsIntegrationMock.mockReturnValue(false)
    mocks.obterConfiguracaoSistema.mockResolvedValue(null)
    mocks.sofiaEligible.mockResolvedValue({ eligible: true, sleeping: false, iaAtiva: true })
    mocks.insert.mockReturnValue({ select: () => ({ single: async () => ({ data: { id: 'msg-1' }, error: null }) }) })
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('does not create a calendar event when credentials are missing outside mock mode', async () => {
    const result = await agendarPedidoNoCalendario('pedido-1')

    expect(result).toBeNull()
  })

  it('does not mark a calendar event as paid when credentials are missing outside mock mode', async () => {
    const result = await atualizarPedidoNoCalendarioComoPago('pedido-1', 'event-1')

    expect(result).toBe(false)
  })

  it('logs PROVEDOR_NAO_CONFIGURADO and stays fail-closed when the DeepSeek key is unconfigured', async () => {
    mocks.createAdminClient.mockReturnValue(createPipelineSupabase())
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await processarRagPipeline('conversa-1', 'Olá')

    expect(result).toEqual({ sucesso: false, error: 'IA_INDISPONIVEL' })
    expect(fetchMock).not.toHaveBeenCalled()

    const linha = warn.mock.calls.map((args) => args.map(String).join(' ')).join('\n')
    expect(linha).toContain('PROVEDOR_NAO_CONFIGURADO')
  })

  it('fails closed on every channel without contacting the provider when the generation switch is disabled', async () => {
    mocks.createAdminClient.mockReturnValue(createPipelineSupabase())
    mocks.obterConfiguracaoSistema.mockImplementation(async (key: string) => (key === 'DEEPSEEK_API_KEY' ? 'sk-configured-key' : null))
    process.env.SOFIA_AI_GENERATION_ENABLED = 'false'
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const web = await processarRagPipeline('conversa-1', 'Olá', 'web')
    const whatsapp = await processarRagPipeline('conversa-1', 'Olá', 'whatsapp')
    const telegram = await processarRagPipeline('conversa-1', 'Olá', 'telegram')
    await expect(processarRagBatchPipeline('conversa-1', 'Olá', 'web')).rejects.toThrow('SOFIA_BATCH_GENERATION_FAILED')

    for (const resultado of [web, whatsapp, telegram]) {
      expect(resultado).toEqual({ sucesso: false, error: 'IA_INDISPONIVEL' })
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.insert).not.toHaveBeenCalled()
    expect([mocks.whatsappSend, mocks.telegramSend].map((m) => m.mock.calls.length)).toEqual([0, 0])

    const linha = warn.mock.calls.map((args) => args.map(String).join(' ')).join('\n')
    expect(linha).toContain('GERACAO_DESABILITADA')
    expect(linha).toContain('SOFIA_AI_GENERATION_ENABLED')
    expect(linha).not.toContain('sk-configured-key')
  })

  it('enables generation unless the switch is exactly false', () => {
    delete process.env.SOFIA_AI_GENERATION_ENABLED
    expect(isSofiaAiGenerationEnabled()).toBe(true)

    for (const valor of ['true', 'True', '1', '0', 'FALSE', 'falsey', '']) {
      process.env.SOFIA_AI_GENERATION_ENABLED = valor
      expect(isSofiaAiGenerationEnabled()).toBe(true)
    }

    process.env.SOFIA_AI_GENERATION_ENABLED = 'false'
    expect(isSofiaAiGenerationEnabled()).toBe(false)
  })

  it('fails closed instead of dispatching an empty answer when generation produced no content', async () => {
    mocks.createAdminClient.mockReturnValue(createPipelineSupabase())
    mocks.obterConfiguracaoSistema.mockImplementation(async (key: string) => (key === 'DEEPSEEK_API_KEY' ? 'sk-configured-key' : null))
    const chat = vi.spyOn(deepseek, 'chamarDeepSeekChat').mockResolvedValue({ success: true, content: '' })

    const result = await processarRagPipeline('conversa-1', 'Olá', 'web')

    expect(result).toEqual({ sucesso: false, error: 'IA_INDISPONIVEL' })
    expect(chat).toHaveBeenCalledTimes(1)
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it('fails the batch pipeline closed with SOFIA_BATCH_GENERATION_FAILED when the provider is unconfigured', async () => {
    mocks.createAdminClient.mockReturnValue(createPipelineSupabase())
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(processarRagBatchPipeline('conversa-1', 'Olá', 'web')).rejects.toThrow('SOFIA_BATCH_GENERATION_FAILED')

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns unavailable instead of generating a mock answer when DeepSeek is unconfigured outside mock mode', async () => {
    mocks.createAdminClient.mockReturnValue(createPipelineSupabase())

    const result = await processarRagPipeline('conversa-1', 'Olá')

    expect(result).toEqual({ sucesso: false, error: 'IA_INDISPONIVEL' })
  })

  it('logs the provider failure with its code and attempt count, and stays fail-closed', async () => {
    mocks.createAdminClient.mockReturnValue(createPipelineSupabase())
    mocks.obterConfiguracaoSistema.mockImplementation(async (key: string) => (
      key === 'DEEPSEEK_API_KEY' ? 'sk-configured-key' : null
    ))
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await processarRagPipeline('conversa-1', 'Olá')

    expect(result).toEqual({ sucesso: false, error: 'IA_INDISPONIVEL' })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const linha = warn.mock.calls.map((args) => args.map(String).join(' ')).join('\n')
    expect(linha).toContain('PROVEDOR_INDISPONIVEL')
    expect(linha).toContain('DEEPSEEK_HTTP_ERROR')
    expect(linha).toContain('tentativas=2')
    expect(linha).toContain('retentativa=true')
    expect(linha).toContain('NÃO foi gerada')
    expect(linha).not.toContain('sk-configured-key')
  })

  it('returns unavailable after a DeepSeek request failure outside mock mode', async () => {
    mocks.createAdminClient.mockReturnValue(createPipelineSupabase())
    mocks.obterConfiguracaoSistema.mockImplementation(async (key: string) => (
      key === 'DEEPSEEK_API_KEY' ? 'sk-configured-key' : null
    ))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('provider unavailable')))

    const result = await processarRagPipeline('conversa-1', 'Olá')

    expect(result).toEqual({ sucesso: false, error: 'IA_INDISPONIVEL' })
  })

  it('generates through the DeepSeek endpoint with the configured model and never the OpenRouter endpoint', async () => {
    mocks.createAdminClient.mockReturnValue(createPipelineSupabase())
    mocks.obterConfiguracaoSistema.mockImplementation(async (key: string) => {
      if (key === 'DEEPSEEK_API_KEY') return 'sk-deepseek-configured-key'
      if (key === 'DEEPSEEK_MODEL') return 'deepseek-v4-pro'
      return null
    })
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'Costela Premium' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await processarRagPipeline('conversa-1', 'Olá', undefined, true)

    expect(result).toEqual({ sucesso: true, canal: undefined, respostaIa: 'Costela Premium' })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    expect(String(init.body)).toContain('deepseek-v4-pro')
    expect(String(init.body)).not.toContain('openrouter')
  })

  function mockChatCompletion(content = 'Costela Premium') {
    return vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  }

  it('falls through to the environment credential when the stored value is an unusable placeholder', async () => {
    mocks.createAdminClient.mockReturnValue(createPipelineSupabase())
    mocks.obterConfiguracaoSistema.mockImplementation(async (key: string) => (
      key === 'DEEPSEEK_API_KEY' ? 'sk-your-api-key-placeholder' : null
    ))
    process.env.DEEPSEEK_API_KEY = 'sk-deepseek-environment-key'
    const fetchMock = mockChatCompletion()
    vi.stubGlobal('fetch', fetchMock)

    const result = await processarRagPipeline('conversa-1', 'Olá', undefined, true)

    expect(result).toEqual({ sucesso: true, canal: undefined, respostaIa: 'Costela Premium' })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-deepseek-environment-key' })
  })

  it('takes the contingency path and fails closed when the stored value is a placeholder and the environment is empty', async () => {
    mocks.createAdminClient.mockReturnValue(createPipelineSupabase())
    mocks.obterConfiguracaoSistema.mockImplementation(async (key: string) => (
      key === 'DEEPSEEK_API_KEY' ? 'sk-your-api-key-placeholder' : null
    ))
    delete process.env.DEEPSEEK_API_KEY
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await processarRagPipeline('conversa-1', 'Olá')

    expect(result).toEqual({ sucesso: false, error: 'IA_INDISPONIVEL' })
    expect(fetchMock).not.toHaveBeenCalled()

    const linha = warn.mock.calls.map((args) => args.map(String).join(' ')).join('\n')
    expect(linha).toContain('PROVEDOR_NAO_CONFIGURADO')
  })

  it('prefers a usable stored credential over a usable environment credential', async () => {
    mocks.createAdminClient.mockReturnValue(createPipelineSupabase())
    mocks.obterConfiguracaoSistema.mockImplementation(async (key: string) => (
      key === 'DEEPSEEK_API_KEY' ? 'sk-deepseek-stored-key' : null
    ))
    process.env.DEEPSEEK_API_KEY = 'sk-deepseek-environment-key'
    const fetchMock = mockChatCompletion()
    vi.stubGlobal('fetch', fetchMock)

    const result = await processarRagPipeline('conversa-1', 'Olá', undefined, true)

    expect(result).toEqual({ sucesso: true, canal: undefined, respostaIa: 'Costela Premium' })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-deepseek-stored-key' })
    expect(JSON.stringify(init.headers)).not.toContain('sk-deepseek-environment-key')
  })

  it('treats a whitespace-padded stored credential as usable after trimming', async () => {
    mocks.createAdminClient.mockReturnValue(createPipelineSupabase())
    mocks.obterConfiguracaoSistema.mockImplementation(async (key: string) => (
      key === 'DEEPSEEK_API_KEY' ? '   sk-deepseek-padded-key   ' : null
    ))
    delete process.env.DEEPSEEK_API_KEY
    const fetchMock = mockChatCompletion()
    vi.stubGlobal('fetch', fetchMock)

    const result = await processarRagPipeline('conversa-1', 'Olá', undefined, true)

    expect(result).toEqual({ sucesso: true, canal: undefined, respostaIa: 'Costela Premium' })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-deepseek-padded-key' })
  })

  it('treats a whitespace-only stored credential as unusable and falls through to the environment', async () => {
    mocks.createAdminClient.mockReturnValue(createPipelineSupabase())
    mocks.obterConfiguracaoSistema.mockImplementation(async (key: string) => (
      key === 'DEEPSEEK_API_KEY' ? '   ' : null
    ))
    process.env.DEEPSEEK_API_KEY = 'sk-deepseek-environment-key'
    const fetchMock = mockChatCompletion()
    vi.stubGlobal('fetch', fetchMock)

    const result = await processarRagPipeline('conversa-1', 'Olá', undefined, true)

    expect(result).toEqual({ sucesso: true, canal: undefined, respostaIa: 'Costela Premium' })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-deepseek-environment-key' })
  })
})
