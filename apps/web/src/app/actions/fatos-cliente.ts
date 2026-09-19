'use server'

import { verificarOperadorAutorizado } from '@/lib/auth/operador'

export type FatoClienteListado = {
  fato_id: string
  tipo: string
  chave: string
  valor: string
  origem: string
  origem_conversa_id: string | null
  confianca: number | null
  estado: string
  revisado_por: string | null
  revisado_em: string | null
  substitui_id: string | null
  criado_em: string
  atualizado_em: string
}

export type DecisaoRevisaoFato = 'aprovar' | 'rejeitar' | 'corrigir'

export type FatoClienteRevisado = {
  fato_id: string
  estado: string
  valor: string
  origem: string
}

// Mesmo valor do default do RPC (`p_limite` vale 200 quando omitido; o maximo aceito e 500).
const LIMITE_FATOS_CLIENTE = 200

/**
 * O erro do banco nunca chega ao navegador: o SQLSTATE decide apenas entre o token de sessao
 * (`42501`, a unica falha de autorizacao que o operador pode provocar) e o fallback generico do
 * repositorio. A mensagem `SOFIA_*` fica no log do servidor, onde o operador nao a le.
 */
function tokenDeErroDaRpc(error: { code?: string | null } | null): string {
  return error?.code === '42501' ? 'ACESSO_NEGADO_PERMISSAO_INSUFICIENTE' : 'ERRO_INTERNO'
}

/** Lista os fatos de um cliente em todos os estados, so para operador autorizado. */
export async function listarFatosCliente(clienteId: string) {
  try {
    const check = await verificarOperadorAutorizado()
    if (!check.authorized) {
      return { success: false, error: check.error }
    }

    // `p_estados` nulo devolve todos os estados (pendente, aprovado, rejeitado, substituido).
    const { data, error } = await check.supabase.rpc('listar_fatos_cliente', {
      p_cliente_id: clienteId,
      p_estados: null,
      p_limite: LIMITE_FATOS_CLIENTE,
    })

    if (error) {
      console.error('Erro na action listarFatosCliente:', error.code, error.message)
      return { success: false, error: tokenDeErroDaRpc(error) }
    }

    return { success: true, data: (data ?? []) as FatoClienteListado[] }
  } catch (error: any) {
    console.error('Erro na action listarFatosCliente:', error?.message || error)
    return { success: false, error: 'ERRO_INTERNO' }
  }
}

/**
 * Aprova, rejeita ou corrige um fato. O valor so acompanha a decisao `corrigir`; o RPC recusa
 * qualquer outra combinacao com `22023`. O revisor e registrado pelo banco a partir de `auth.uid()`.
 */
export async function revisarFatoCliente(fatoId: string, decisao: DecisaoRevisaoFato, valor: string | null = null) {
  try {
    const check = await verificarOperadorAutorizado()
    if (!check.authorized) {
      return { success: false, error: check.error }
    }

    const { data, error } = await check.supabase.rpc('revisar_fato_cliente', {
      p_fato_id: fatoId,
      p_decisao: decisao,
      p_valor: valor,
    })

    if (error) {
      console.error('Erro na action revisarFatoCliente:', error.code, error.message)
      return { success: false, error: tokenDeErroDaRpc(error) }
    }

    return { success: true, data: (data ?? []) as FatoClienteRevisado[] }
  } catch (error: any) {
    console.error('Erro na action revisarFatoCliente:', error?.message || error)
    return { success: false, error: 'ERRO_INTERNO' }
  }
}
