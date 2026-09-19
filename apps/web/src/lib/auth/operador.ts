import { createClient } from '@/lib/supabase/server'

const FUNCOES_OPERADOR_AUTORIZADAS = ['admin', 'supervisor', 'vendedor']

type AuthorizedOperatorCheck =
  | { authorized: true; supabase: Awaited<ReturnType<typeof createClient>>; user: { id: string }; perfil: { funcao: string; ativo: boolean } }
  | { authorized: false; error: string }

export async function verificarOperadorAutorizado(): Promise<AuthorizedOperatorCheck> {
  const supabase = await createClient()

  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return { authorized: false, error: 'ACESSO_NEGADO_NAO_AUTENTICADO' }
  }

  const { data: perfil, error: perfilError } = await supabase
    .from('perfis')
    .select('funcao, ativo')
    .eq('id', user.id)
    .single()

  if (perfilError || !perfil) {
    return { authorized: false, error: 'PERFIL_NAO_ENCONTRADO' }
  }

  if (!perfil.ativo) {
    return { authorized: false, error: 'PERFIL_INATIVO' }
  }

  if (!FUNCOES_OPERADOR_AUTORIZADAS.includes(perfil.funcao)) {
    return { authorized: false, error: 'ACESSO_NEGADO_PERMISSAO_INSUFICIENTE' }
  }

  return { authorized: true, supabase, user: { id: user.id }, perfil }
}
