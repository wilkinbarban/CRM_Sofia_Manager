import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }))

import { obterStatusSofiaAtendimento } from '@/app/actions/atendimento'
import { listarFatosCliente, revisarFatoCliente } from '@/app/actions/fatos-cliente'

const ATENDIMENTO = 'apps/web/src/app/actions/atendimento.ts'
const FATOS_CLIENTE = 'apps/web/src/app/actions/fatos-cliente.ts'
const OPERADOR = 'apps/web/src/lib/auth/operador.ts'

const fonte = (caminho: string) => readFileSync(resolve(process.cwd(), caminho), 'utf8')

const SESSION_ERRORS = [
  'ACESSO_NEGADO_NAO_AUTENTICADO',
  'PERFIL_NAO_ENCONTRADO',
  'PERFIL_INATIVO',
  'ACESSO_NEGADO_PERMISSAO_INSUFICIENTE',
]

const OPERADOR_AUTORIZADO = { user: { id: 'operator-1' }, perfil: { funcao: 'vendedor', ativo: true } }

type Sessao = {
  user?: { id: string } | null
  perfil?: { funcao: string; ativo: boolean } | null
  perfilError?: { message: string } | null
}

type RpcCall = { fn: string; args: Record<string, unknown> }

type RpcError = { code?: string; message: string; details?: string | null; hint?: string | null }

type RpcResult = { data: unknown; error: RpcError | null }

function instalarSessao(sessao: Sessao, rpcResult: RpcResult = { data: [], error: null }) {
  const calls: RpcCall[] = []
  const supabase = {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: sessao.user === undefined ? { id: 'operator-1' } : sessao.user },
        error: null,
      }),
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn().mockResolvedValue({
            data: sessao.perfil === undefined ? { funcao: 'vendedor', ativo: true } : sessao.perfil,
            error: sessao.perfilError ?? null,
          }),
        })),
      })),
    })),
    rpc: vi.fn((fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args })
      return Promise.resolve(rpcResult)
    }),
  }

  mocks.createClient.mockResolvedValue(supabase)

  return { calls, supabase }
}

let erroLog: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  erroLog = vi.spyOn(console, 'error').mockImplementation(() => {})
})

const CENARIOS_SEM_AUTORIZACAO: Array<{ rotulo: string; sessao: Sessao; erro: string }> = [
  { rotulo: 'an unauthenticated session', sessao: { user: null }, erro: 'ACESSO_NEGADO_NAO_AUTENTICADO' },
  { rotulo: 'a profile that cannot be read', sessao: { perfil: null, perfilError: { message: 'no rows' } }, erro: 'PERFIL_NAO_ENCONTRADO' },
  { rotulo: 'an inactive operator', sessao: { perfil: { funcao: 'vendedor', ativo: false } }, erro: 'PERFIL_INATIVO' },
  { rotulo: 'a non-operator profile', sessao: { perfil: { funcao: 'cliente', ativo: true } }, erro: 'ACESSO_NEGADO_PERMISSAO_INSUFICIENTE' },
]

const FALHAS_RPC: Array<{ code: string; message: string; token: string }> = [
  { code: '42501', message: 'SOFIA_FATO_OPERADOR_REQUERIDO', token: 'ACESSO_NEGADO_PERMISSAO_INSUFICIENTE' },
  { code: '22023', message: 'SOFIA_FATO_ENTRADA_INVALIDA', token: 'ERRO_INTERNO' },
  { code: 'P0002', message: 'SOFIA_FATO_NAO_ENCONTRADO', token: 'ERRO_INTERNO' },
]

const FATO_LISTADO = {
  fato_id: 'fact-1',
  tipo: 'preferencia',
  chave: 'bebida',
  valor: 'sem acucar',
  origem: 'ia',
  origem_conversa_id: 'conversation-1',
  confianca: 0.9,
  estado: 'pendente',
  revisado_por: null,
  revisado_em: null,
  substitui_id: null,
  criado_em: '2026-09-18T00:00:00.000Z',
  atualizado_em: '2026-09-18T00:00:00.000Z',
}

describe.each(CENARIOS_SEM_AUTORIZACAO)('$rotulo', (cenario) => {
  it('refuses listarFatosCliente before issuing any RPC', async () => {
    const { calls, supabase } = instalarSessao(cenario.sessao)

    const resultado = await listarFatosCliente('client-1')

    expect(resultado).toEqual({ success: false, error: cenario.erro })
    expect(calls).toEqual([])
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('refuses revisarFatoCliente before issuing any RPC', async () => {
    const { calls, supabase } = instalarSessao(cenario.sessao)

    const resultado = await revisarFatoCliente('fact-1', 'aprovar')

    expect(resultado).toEqual({ success: false, error: cenario.erro })
    expect(calls).toEqual([])
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
})

describe('listarFatosCliente', () => {
  it('calls listar_fatos_cliente with the exact argument object and returns the rows', async () => {
    const { calls } = instalarSessao(OPERADOR_AUTORIZADO, { data: [FATO_LISTADO], error: null })

    const resultado = await listarFatosCliente('client-1')

    expect(calls).toEqual([
      { fn: 'listar_fatos_cliente', args: { p_cliente_id: 'client-1', p_estados: null, p_limite: 200 } },
    ])
    expect(resultado).toEqual({ success: true, data: [FATO_LISTADO] })
    expect(JSON.parse(JSON.stringify(resultado))).toEqual(resultado)
  })

  it('returns an empty list when the RPC returns no rows', async () => {
    instalarSessao(OPERADOR_AUTORIZADO, { data: null, error: null })

    const resultado = await listarFatosCliente('client-1')

    expect(resultado).toEqual({ success: true, data: [] })
  })
})

describe('revisarFatoCliente', () => {
  it('calls revisar_fato_cliente with a null value for an approval decision', async () => {
    const revisado = [{ fato_id: 'fact-1', estado: 'aprovado', valor: 'sem acucar', origem: 'ia' }]
    const { calls } = instalarSessao(OPERADOR_AUTORIZADO, { data: revisado, error: null })

    const resultado = await revisarFatoCliente('fact-1', 'aprovar')

    expect(calls).toEqual([
      { fn: 'revisar_fato_cliente', args: { p_fato_id: 'fact-1', p_decisao: 'aprovar', p_valor: null } },
    ])
    expect(resultado).toEqual({ success: true, data: revisado })
    expect(JSON.parse(JSON.stringify(resultado))).toEqual(resultado)
  })

  it('calls revisar_fato_cliente with the corrected value for a correction decision', async () => {
    const revisado = [{ fato_id: 'fact-1', estado: 'aprovado', valor: 'sem lactose', origem: 'ia' }]
    const { calls } = instalarSessao(OPERADOR_AUTORIZADO, { data: revisado, error: null })

    const resultado = await revisarFatoCliente('fact-1', 'corrigir', 'sem lactose')

    expect(calls).toEqual([
      { fn: 'revisar_fato_cliente', args: { p_fato_id: 'fact-1', p_decisao: 'corrigir', p_valor: 'sem lactose' } },
    ])
    expect(resultado).toEqual({ success: true, data: revisado })
  })
})

describe.each(FALHAS_RPC)('RPC failure $code', (falha) => {
  it('maps a listar_fatos_cliente failure to the action result shape without leaking the database token', async () => {
    instalarSessao(OPERADOR_AUTORIZADO, { data: null, error: { code: falha.code, message: falha.message } })

    const resultado = await listarFatosCliente('client-1')

    expect(resultado).toEqual({ success: false, error: falha.token })
    // Over the value the action returned, not over the fixture: whatever the mapping does, the
    // token that leaves the module must stay inside the session vocabulary plus `ERRO_INTERNO`.
    const { error: tokenRetornado } = resultado as { error?: string }
    expect([...SESSION_ERRORS, 'ERRO_INTERNO']).toContain(tokenRetornado)
    expect(JSON.stringify(resultado)).not.toContain('SOFIA_FATO_')
    expect(JSON.stringify(resultado)).not.toContain(falha.message)
    expect(JSON.stringify(resultado)).not.toContain(falha.code)
    expect(erroLog.mock.calls.flat().join(' ')).toContain(falha.message)
  })

  it('maps a revisar_fato_cliente failure to the action result shape without leaking the database token', async () => {
    instalarSessao(OPERADOR_AUTORIZADO, { data: null, error: { code: falha.code, message: falha.message } })

    const resultado = await revisarFatoCliente('fact-1', 'rejeitar')

    expect(resultado).toEqual({ success: false, error: falha.token })
    // Mirrors the `listar` twin: the returned token, not the fixture, is checked against the
    // session vocabulary plus `ERRO_INTERNO`.
    const { error: tokenRetornado } = resultado as { error?: string }
    expect([...SESSION_ERRORS, 'ERRO_INTERNO']).toContain(tokenRetornado)
    expect(JSON.stringify(resultado)).not.toContain('SOFIA_FATO_')
    expect(JSON.stringify(resultado)).not.toContain(falha.message)
    expect(JSON.stringify(resultado)).not.toContain(falha.code)
    expect(erroLog.mock.calls.flat().join(' ')).toContain(falha.message)
  })
})

describe('transport failures', () => {
  it('never lets a thrown transport error escape listarFatosCliente', async () => {
    const { supabase } = instalarSessao(OPERADOR_AUTORIZADO)
    // The call recorder is bypassed on purpose here: `mockImplementation` replaces the recording implementation, so the single `toEqual` on the result below is what carries the assertion.
    supabase.rpc.mockImplementation(() => {
      throw new Error('transport down')
    })

    const resultado = await listarFatosCliente('client-1')

    expect(resultado).toEqual({ success: false, error: 'ERRO_INTERNO' })
    expect(JSON.stringify(resultado)).not.toContain('transport down')
  })

  it('never lets a thrown transport error escape revisarFatoCliente', async () => {
    const { supabase } = instalarSessao(OPERADOR_AUTORIZADO)
    // The call recorder is bypassed on purpose here: `mockImplementation` replaces the recording implementation, so the single `toEqual` on the result below is what carries the assertion.
    supabase.rpc.mockImplementation(() => {
      throw new Error('transport down')
    })

    const resultado = await revisarFatoCliente('fact-1', 'aprovar')

    expect(resultado).toEqual({ success: false, error: 'ERRO_INTERNO' })
    expect(JSON.stringify(resultado)).not.toContain('transport down')
  })
})

describe('fatos-cliente action surface', () => {
  it('is a server action module that exports only async functions and types', () => {
    const modulo = fonte(FATOS_CLIENTE)

    expect(modulo.startsWith("'use server'\n")).toBe(true)

    const exportacoes = modulo.split('\n').filter((linha) => /^export\b/.test(linha))
    expect(exportacoes.length).toBeGreaterThanOrEqual(2)
    expect(exportacoes.every((linha) => /^export (async function|type)\b/.test(linha))).toBe(true)
    for (const linha of exportacoes) {
      expect(linha).not.toMatch(/\bsupabase\b/)
    }
  })

  it('performs no direct fatos_cliente table access', () => {
    const modulo = fonte(FATOS_CLIENTE)

    expect(modulo).not.toMatch(/\.from\s*\(/)
    expect(modulo).not.toContain('.insert(')
    expect(modulo).not.toContain('.update(')
    expect(modulo).not.toContain('.delete(')
    expect(modulo).not.toContain('.upsert(')
    expect(modulo).toContain("supabase.rpc('listar_fatos_cliente'")
    expect(modulo).toContain("supabase.rpc('revisar_fato_cliente'")
  })

  it('keeps the database error vocabulary and the raw client out of every return value', () => {
    const modulo = fonte(FATOS_CLIENTE)

    expect(modulo).not.toContain('SOFIA_FATO_')

    // Regex over the whole module, not a scan of `return` lines: every line that mentions
    // `supabase` must be one of the two gated RPC calls. The old per-line `return` scan only saw
    // a single-line return, so a `check.supabase` written across several lines -- or any extra
    // reference to the client anywhere else in the module -- escaped it.
    const linhasComSupabase = modulo.match(/^.*\bsupabase\b.*$/gm) ?? []
    expect(linhasComSupabase).toHaveLength(2)
    expect(
      linhasComSupabase.every((linha) =>
        /^\s*const \{ data, error \} = await check\.supabase\.rpc\('(?:listar_fatos_cliente|revisar_fato_cliente)', \{$/.test(
          linha,
        ),
      ),
    ).toBe(true)

    const retornos = modulo.split('\n').filter((linha) => /\breturn\b/.test(linha))
    expect(retornos.length).toBeGreaterThan(0)
    for (const linha of retornos) {
      expect(linha).not.toContain('.message')
    }
  })
})

describe('operator authorization move', () => {
  it('moves the role list and the helper out of the server action module verbatim', () => {
    const operador = fonte(OPERADOR)

    expect(operador).toContain("const FUNCOES_OPERADOR_AUTORIZADAS = ['admin', 'supervisor', 'vendedor']")
    expect(operador).toContain('async function verificarOperadorAutorizado(): Promise<AuthorizedOperatorCheck> {')
    expect(operador).toContain("return { authorized: true, supabase, user: { id: user.id }, perfil }")
    expect(operador).not.toContain("'use server'")

    const atendimento = fonte(ATENDIMENTO)
    expect(atendimento).not.toContain('const FUNCOES_OPERADOR_AUTORIZADAS')
    expect(atendimento).not.toContain('function verificarOperadorAutorizado')
    expect(atendimento).toContain("import { verificarOperadorAutorizado } from '@/lib/auth/operador'")
    expect(atendimento.match(/await verificarOperadorAutorizado\(\)/g)).toHaveLength(3)
  })

  it('keeps every server action module free of exported non-serializable helpers', () => {
    for (const caminho of [ATENDIMENTO, FATOS_CLIENTE]) {
      const exportacoes = fonte(caminho).split('\n').filter((linha) => /^export\b/.test(linha))
      expect(exportacoes.length).toBeGreaterThan(0)
      expect(exportacoes.every((linha) => /^export (async function|type)\b/.test(linha))).toBe(true)
    }
  })
})

describe.each(CENARIOS_SEM_AUTORIZACAO)('atendimento keeps refusing $rotulo through the moved helper', (cenario) => {
  it('returns the same session error token without issuing any RPC', async () => {
    const { calls } = instalarSessao(cenario.sessao)

    const resultado = await obterStatusSofiaAtendimento()

    expect(resultado).toEqual({ success: false, error: cenario.erro })
    expect(calls).toEqual([])
  })
})
