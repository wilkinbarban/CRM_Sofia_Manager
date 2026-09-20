import { beforeEach, describe, expect, it, vi } from 'vitest'

const config = vi.hoisted(() => ({ obterConfiguracaoSistema: vi.fn() }))
const admin = vi.hoisted(() => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/config/sistema', () => config)
vi.mock('@/lib/supabase/admin', () => admin)
vi.mock('@/lib/whatsapp/safety', () => ({ validarEnvioWhatsAppSafety: vi.fn().mockResolvedValue({ permitido: true }) }))
vi.mock('@/lib/whatsapp/circuit-breaker', () => ({ whatsappCircuitBreaker: { executar: (fn: () => unknown) => fn() } }))

import { enviarMensagemEvolution, startEvolutionPresence, EvolutionProvider } from '@/lib/whatsapp/evolution'

function query(data: unknown) {
  const builder: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const method of ['select', 'eq', 'order', 'limit']) builder[method] = vi.fn(() => builder)
  builder.insert = vi.fn(() => builder)
  builder.single = vi.fn().mockResolvedValue({ data, error: null })
  builder.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
  builder.insert.mockReturnValue({ select: vi.fn(() => ({ single: vi.fn().mockResolvedValue({ data: null, error: null }) })) })
  return builder
}
function setup() {
  config.obterConfiguracaoSistema.mockImplementation(async (key: string) => ({
    EVOLUTION_API_URL: 'https://evolution.example', EVOLUTION_API_KEY: 'test-key', EVOLUTION_INSTANCE_NAME: 'instance',
  }[key]))
  const conversation = query({ id: 'c', cliente_id: null, clientes: { telefone: '5511999999999', ultima_interacao_recebida_em: new Date().toISOString() } })
  const messages = query(null)
  admin.createAdminClient.mockReturnValue({ from: vi.fn((table: string) => table === 'conversas' ? conversation : messages) })
  return { conversation, messages }
}

beforeEach(() => { vi.clearAllMocks(); setup(); vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://test.example') })

describe('Evolution transport contract', () => {
  it('sends durable messages with top-level delay and no vendor options', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ key: { id: 'm' } }), { status: 200 })))
    await enviarMensagemEvolution('c', { texto: 'hello', typingDelayMs: 237 })
    const request = vi.mocked(fetch).mock.calls[0]![1] as RequestInit
    expect(JSON.parse(String(request.body))).toEqual({ number: '5511999999999', delay: 237, text: 'hello' })
  })
  it('omits delay for durable-worker sends and preserves retry zero', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ key: { id: 'm' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await enviarMensagemEvolution('c', { texto: 'hello', typingDelayMs: 237, salvarNoBanco: false })
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ number: '5511999999999', text: 'hello' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('sanitizes non-2xx provider bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('SECRET_BODY', { status: 400, statusText: 'Bad Request' })))
    await expect(enviarMensagemEvolution('c', { texto: 'hello' })).rejects.toThrow('HTTP 400 Erro na Evolution API (Bad Request)')
    await expect(enviarMensagemEvolution('c', { texto: 'hello' })).rejects.not.toThrow('SECRET_BODY')
  })
  it('sends presence with the configured Origin and API key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ presence: 'composing' }), { status: 200 })))
    const handle = await startEvolutionPresence('c')
    expect(fetch).toHaveBeenCalledWith('https://evolution.example/chat/sendPresence/instance', expect.objectContaining({
      headers: expect.objectContaining({ apikey: 'test-key', Origin: 'https://test.example' }),
    }))
    handle.stop()
  })
  it('uses the fallback Origin when the public app URL is empty', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ presence: 'composing' }), { status: 200 })))
    const handle = await startEvolutionPresence('c')
    expect(fetch).toHaveBeenCalledWith('https://evolution.example/chat/sendPresence/instance', expect.objectContaining({
      headers: expect.objectContaining({ Origin: 'https://crmsofiamanager.duckdns.org' }),
    }))
    handle.stop()
  })
  it.each([null, {}, { presence: 'paused' }])('sanitizes malformed or wrong presence responses', async body => {
    const events: unknown[] = []
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body === null ? 'not-json' : JSON.stringify(body), { status: 200 })))
    const handle = await startEvolutionPresence('c', event => { events.push(event) })
    await vi.waitFor(() => expect(events).toContainEqual({ tag: 'evolution_presence', event: 'unavailable', reason: 'provider_rejected' }))
    handle.stop()
    expect(fetch).toHaveBeenCalledWith('https://evolution.example/chat/sendPresence/instance', expect.objectContaining({ body: JSON.stringify({ number: '5511999999999', presence: 'composing', delay: 4000 }) }))
    expect(JSON.stringify(events)).not.toContain('paused')
  })
  it('returns a no-op in mock configuration without touching Meta', async () => {
    config.obterConfiguracaoSistema.mockResolvedValue(null)
    const handle = await startEvolutionPresence('c')
    expect(handle.stop()).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })
  it('implements iniciarPresenca on EvolutionProvider and delegates to startEvolutionPresence', async () => {
    const provider = new EvolutionProvider()
    expect(typeof provider.iniciarPresenca).toBe('function')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ presence: 'composing' }), { status: 200 })))
    const handle = await provider.iniciarPresenca!('c')
    expect(handle).toBeDefined()
    expect(typeof handle.stop).toBe('function')
    expect(fetch).toHaveBeenCalledWith('https://evolution.example/chat/sendPresence/instance', expect.objectContaining({
      headers: expect.objectContaining({ apikey: 'test-key', Origin: 'https://test.example' }),
      body: JSON.stringify({ number: '5511999999999', presence: 'composing', delay: 4000 }),
    }))
    handle.stop()
  })
})
