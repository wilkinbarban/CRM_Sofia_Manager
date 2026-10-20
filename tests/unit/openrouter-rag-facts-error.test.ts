// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as deepseek from '@/lib/ai/deepseek'
import { processarRagPipeline } from '@/lib/ai/openrouter'

// Issue #196 / slice 1: `buscar_fatos_para_prompt` returns PostgREST failures as
// `{ data: null, error }` instead of throwing. Before this slice the fetch read
// only `data`, so a permission or RPC failure degraded the prompt silently.
const ERRO_RPC = '[RAG Pipeline] Erro RPC ao buscar fatos do cliente'
const CABECALHO = 'FATOS REGISTRADOS DO CLIENTE'

const conversaFalsa = {
  id: 'conversa-1',
  cliente_id: 'cliente-1',
  ia_ativa: true,
  clientes: { telefone: '5541999998888', nome: 'Cliente', telegram_chat_id: null },
}

const h = vi.hoisted(() => ({
  fatos: { data: [] as unknown, error: null as unknown },
  fatosRejeita: null as unknown,
  chamadas: 0,
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: (nome: string) => {
      if (nome === 'buscar_fatos_para_prompt') {
        h.chamadas += 1
        return h.fatosRejeita ? Promise.reject(h.fatosRejeita) : Promise.resolve(h.fatos)
      }
      return Promise.resolve({ data: [], error: null })
    },
    from: (tabela: string) => {
      const resultado = Promise.resolve({ data: [], error: null })
      const consulta: any = {}
      for (const metodo of ['select', 'eq', 'order', 'limit', 'in', 'update', 'insert']) consulta[metodo] = () => consulta
      consulta.then = (ok: any, erro: any) => resultado.then(ok, erro)
      consulta.single = () => Promise.resolve({ data: tabela === 'conversas' ? { ...conversaFalsa } : null, error: null })
      consulta.maybeSingle = () => Promise.resolve({ data: null, error: null })
      return consulta
    },
  }),
}))

vi.mock('@/lib/config/sistema', () => ({ obterConfiguracaoSistema: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/whatsapp/send', () => ({ enviarMensagemWhatsapp: vi.fn().mockResolvedValue({ sucesso: true }) }))
vi.mock('@/lib/telegram/send', () => ({ enviarMensagemTelegram: vi.fn().mockResolvedValue({ sucesso: true }) }))

/** Runs the pipeline and returns the assembled system prompt plus every log line. */
async function executar(): Promise<{ prompt: string; logs: string[] }> {
  const logs: string[] = []
  for (const nivel of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, nivel).mockImplementation((...args: unknown[]) => {
      logs.push(
        `${nivel}: ${args
          .map(a => (typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a)))
          .join(' ')}`,
      )
    })
  }
  vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test-deepseek-fatos-key')
  const spy = vi.spyOn(deepseek, 'chamarDeepSeekChat').mockResolvedValue({ success: true, content: 'ok' })
  await processarRagPipeline('conversa-1', 'Olá', 'web', true)
  const conteudo = spy.mock.calls[0][0].messages[0].content
  if (typeof conteudo !== 'string') throw new Error('SOFIA_SYSTEM_PROMPT_NOT_TEXT')
  return { prompt: conteudo, logs }
}

const linhasDoErro = (logs: string[]) => logs.filter(l => l.includes(ERRO_RPC))

beforeEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv('SOFIA_CUSTOMER_MEMORY_ENABLED', 'true')
  h.fatos = { data: [], error: null }
  h.fatosRejeita = null
  h.chamadas = 0
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('buscar_fatos_para_prompt — PostgREST error surface', () => {
  it('logs the RPC failure with its PostgREST details and degrades to an empty block', async () => {
    const erro = { code: '42501', message: 'SOFIA_FATO_SERVICE_ROLE_REQUIRED', details: 'permission denied', hint: null }
    h.fatos = { data: null, error: erro }

    const { prompt, logs } = await executar()

    expect(h.chamadas).toBe(1)
    const linhas = linhasDoErro(logs)
    expect(linhas).toHaveLength(1)
    expect(linhas[0]).toContain('42501')
    expect(linhas[0]).toContain('SOFIA_FATO_SERVICE_ROLE_REQUIRED')
    expect(prompt).not.toContain(CABECALHO)
    expect(prompt).toContain('CONTEXTO DE SUPORTE:')
  })

  it('never logs the marker on a healthy fetch', async () => {
    h.fatos = { data: [{ tipo: 'endereco', chave: 'principal', valor: 'Rua das Flores, 123' }], error: null }

    const { prompt, logs } = await executar()

    expect(h.chamadas).toBe(1)
    expect(linhasDoErro(logs)).toHaveLength(0)
    expect(prompt).toContain(CABECALHO)
    expect(prompt).toContain('- endereco/principal: Rua das Flores, 123')
  })

  it('reports and discards a partial row set that arrives together with an error', async () => {
    h.fatos = {
      data: [{ tipo: 'endereco', chave: 'principal', valor: 'Rua das Flores, 123' }],
      error: { code: '08006', message: 'connection_failure' },
    }

    const { prompt, logs } = await executar()

    expect(linhasDoErro(logs)).toHaveLength(1)
    expect(prompt).not.toContain(CABECALHO)
    expect(prompt).not.toContain('Rua das Flores, 123')
  })

  it('keeps the thrown-rejection branch separate from the PostgREST error branch', async () => {
    h.fatosRejeita = Object.assign(new Error('rpc unavailable'), { code: '08006' })

    const { prompt, logs } = await executar()

    expect(linhasDoErro(logs)).toHaveLength(0)
    expect(logs.some(l => l.includes('[RAG Pipeline] Erro ao buscar fatos do cliente:'))).toBe(true)
    expect(prompt).not.toContain(CABECALHO)
  })
})
