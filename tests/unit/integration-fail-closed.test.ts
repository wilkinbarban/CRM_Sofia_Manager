// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  allowsIntegrationMock: vi.fn(),
  createAdminClient: vi.fn(),
  obterConfiguracaoSistema: vi.fn(),
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

import {
  agendarPedidoNoCalendario,
  atualizarPedidoNoCalendarioComoPago,
} from '@/lib/calendar/google'
import { processarRagBatchPipeline, processarRagPipeline } from '@/lib/ai/openrouter'

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
                  clientes: { telefone: '', nome: 'Cliente', telegram_chat_id: '' },
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
      }
    }),
    rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
  }
}

describe('integration fail-closed policy', () => {
  beforeEach(() => {
    mocks.allowsIntegrationMock.mockReturnValue(false)
    mocks.obterConfiguracaoSistema.mockResolvedValue(null)
  })

  afterEach(() => {
    delete process.env.AI_ROUTING_LEGACY_FALLBACK_ENABLED
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

  it('logs GERACAO_DESABILITADA and fails closed without any provider request when the legacy fallback is disabled', async () => {
    mocks.createAdminClient.mockReturnValue(createPipelineSupabase())
    mocks.obterConfiguracaoSistema.mockImplementation(async (key: string) => (
      key === 'DEEPSEEK_API_KEY' ? 'sk-configured-key' : null
    ))
    process.env.AI_ROUTING_LEGACY_FALLBACK_ENABLED = 'false'
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(processarRagBatchPipeline('conversa-1', 'Olá', 'web')).rejects.toThrow('SOFIA_BATCH_GENERATION_FAILED')

    expect(fetchMock).not.toHaveBeenCalled()

    const linha = warn.mock.calls.map((args) => args.map(String).join(' ')).join('\n')
    expect(linha).toContain('GERACAO_DESABILITADA')
    expect(linha).not.toContain('sk-configured-key')
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
})
