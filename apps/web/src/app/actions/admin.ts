'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { getSupabaseServerUrl } from '@/lib/supabase/url'
import { z } from 'zod'
import { google } from 'googleapis'
import {
  getEvolutionConnectionState,
  getEvolutionQrCode,
} from '@/lib/whatsapp/evolution-admin-client'
import { revalidatePath } from 'next/cache'
import { consolidateAdminUsers } from '@/lib/admin/user-list'
import { obterConfiguracaoSistema } from '@/lib/config/sistema'
import { resolveOmniRouteAdminTarget } from '@/lib/ai/omniroute-admin-target'
import { parseFinancialOperationalMetrics, validateReportingPeriod } from '@/lib/admin/financial-metrics'

/**
 * Helper para validar se o usuário atual está autenticado, ativo
 * e se possui papel de 'admin' ou 'supervisor'.
 */
async function verificarPermissaoOperador() {
  const supabase = await createClient()

  // 1. Obter usuário autenticado da sessão
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return { authorized: false, error: 'ACESSO_NEGADO_NAO_AUTENTICADO', supabase }
  }

  // 2. Buscar o perfil do usuário e validar suas permissões e status
  const { data: perfil, error: perfilError } = await supabase
    .from('perfis')
    .select('funcao, ativo')
    .eq('id', user.id)
    .single()

  if (perfilError || !perfil) {
    return { authorized: false, error: 'PERFIL_NAO_ENCONTRADO', supabase }
  }

  if (!perfil.ativo) {
    return { authorized: false, error: 'PERFIL_INATIVO', supabase }
  }

  const funcoesAutorizadas = ['admin', 'supervisor']
  if (!funcoesAutorizadas.includes(perfil.funcao)) {
    return { authorized: false, error: 'ACESSO_NEGADO_PERMISSAO_INSUFICIENTE', supabase }
  }

  return { authorized: true, user, perfil, supabase }
}

/**
 * Server Action 2.2: listarUsuariosAdmin
 * Consolida a lista de usuários do Auth com seus respectivos perfis e-mail/função na tabela perfis.
 */
export async function listarUsuariosAdmin() {
  try {
    const check = await verificarPermissaoOperador()
    if (!check.authorized) {
      return { success: false, error: check.error }
    }

    const adminSupabase = createAdminClient()
    const { data: authData, error: authError } = await adminSupabase.auth.admin.listUsers({
      page: 1,
      perPage: 1000
    })

    const authUsers = authError || !authData?.users ? [] : authData.users
    if (authError) {
      console.warn('[Admin Users] Auth Admin indisponível; exibindo perfis sem metadados de autenticação.')
    }

    const { data: perfis, error: perfisError } = await adminSupabase
      .from('perfis')
      .select('*')
      .order('data_criacao', { ascending: false })

    if (perfisError || !perfis) {
      return { success: false, error: `ERRO_PERFIS: ${perfisError?.message || 'Falha ao buscar perfis'}` }
    }

    const { data: clientes } = await adminSupabase
      .from('clientes')
      .select('id, usuario_id, telefone')

    const consolidated = consolidateAdminUsers(perfis, authUsers, clientes || [])

    return { success: true, data: consolidated }
  } catch (error: any) {
    console.error('Erro na action listarUsuariosAdmin:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}

/**
 * Server Action 2.3 & 2.4: atualizarPerfilUsuario
 * Atualiza a função e status ativo de um usuário, com proteção contra lockout
 * e garantindo no mínimo um administrador ativo. Escreve no log de auditoria.
 */
export async function atualizarPerfilUsuario(usuarioAlvoId: string, funcao: string, ativo: boolean) {
  try {
    const funcoesValidas = ['admin', 'supervisor', 'vendedor', 'cliente']
    if (!funcoesValidas.includes(funcao)) {
      return { success: false, error: 'FUNCAO_INVALIDA' }
    }
    const supabase = await createClient()
    const { error } = await supabase.rpc('gerenciar_funcao_status_perfil', {
      p_usuario_alvo_id: usuarioAlvoId, p_funcao: funcao, p_ativo: ativo,
    })
    if (error) return { success: false, error: error.message }

    revalidatePath('/atendimento/admin')
    return { success: true }
  } catch (error: any) {
    console.error('Erro na action atualizarPerfilUsuario:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}

/**
 * Server Action: criarUsuarioAdmin
 * Cria um novo usuário/operador no Supabase Auth e registra seu perfil na tabela perfis.
 */
export async function criarUsuarioAdmin(dados: {
  nome: string
  email: string
  senha: string
  funcao: 'admin' | 'supervisor' | 'vendedor' | 'cliente'
  telefone?: string
}) {
  try {
    const check = await verificarPermissaoOperador()
    if (!check.authorized || !check.user || check.perfil?.funcao !== 'admin') {
      return { success: false, error: 'ACESSO_NEGADO_APENAS_ADMINISTRADORES' }
    }

    const { nome, email, senha, funcao, telefone } = dados
    if (!nome || !email || !senha) {
      return { success: false, error: 'DADOS_OBRIGATORIOS_AUSENTES' }
    }
    if (senha.length < 6) {
      return { success: false, error: 'SENHA_MINIMA_6_CARACTERES' }
    }

    const adminSupabase = createAdminClient()

    // 1. Criar no Supabase Auth
    const { data: authData, error: authError } = await adminSupabase.auth.admin.createUser({
      email: email.trim().toLowerCase(),
      password: senha,
      email_confirm: true,
      user_metadata: { nome: nome.trim() }
    })

    if (authError || !authData?.user) {
      return { success: false, error: `ERRO_AUTH_CRIAR: ${authError?.message || 'Falha ao criar autenticação'}` }
    }

    const novoId = authData.user.id

    // 2. Criar ou upsert no public.perfis
    const { error: perfilError } = await adminSupabase
      .from('perfis')
      .upsert({
        id: novoId,
        nome: nome.trim(),
        funcao: funcao || 'vendedor',
        ativo: true
      })

    if (perfilError) {
      return { success: false, error: `ERRO_PERFIL_CRIAR: ${perfilError.message}` }
    }

    // 3. Se for cliente e tiver telefone, registrar na tabela clientes
    if (funcao === 'cliente' && telefone) {
      await adminSupabase.from('clientes').upsert({
        id: novoId,
        nome: nome.trim(),
        telefone: telefone.trim(),
        email: email.trim().toLowerCase()
      })
    }

    // 4. Log de auditoria
    await adminSupabase.from('logs_auditoria').insert({
      usuario_id: check.user.id,
      acao: 'criar_usuario',
      detalhes: {
        usuario_criado_id: novoId,
        nome: nome.trim(),
        email: email.trim().toLowerCase(),
        funcao: funcao
      }
    })

    revalidatePath('/atendimento/admin')
    return {
      success: true,
      usuario: {
        id: novoId,
        nome: nome.trim(),
        email: email.trim().toLowerCase(),
        funcao,
        ativo: true
      }
    }
  } catch (error: any) {
    console.error('Erro na action criarUsuarioAdmin:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}

/**
 * Server Action: editarUsuarioAdmin
 * Permite ao Administrador atualizar todos os dados cadastrais (nome, email, telefone, função, status e redefinição de senha).
 */
export async function editarUsuarioAdmin(
  usuarioAlvoId: string,
  dados: {
    nome: string
    email?: string
    telefone?: string
    funcao?: string
    ativo?: boolean
    novaSenha?: string
  }
) {
  try {
    const check = await verificarPermissaoOperador()
    if (!check.authorized || !check.user || check.perfil?.funcao !== 'admin') {
      return { success: false, error: 'ACESSO_NEGADO_APENAS_ADMINISTRADORES' }
    }

    const adminSupabase = createAdminClient()

    // Buscar dados atuais do alvo
    const { data: perfilAlvo, error: getPerfilErr } = await adminSupabase
      .from('perfis')
      .select('*')
      .eq('id', usuarioAlvoId)
      .single()

    if (getPerfilErr || !perfilAlvo) {
      return { success: false, error: 'USUARIO_NAO_ENCONTRADO' }
    }

    // Proteção anti-lockout caso esteja alterando o próprio usuário ou o último admin
    const isSelf = usuarioAlvoId === check.user.id
    const targetRole = dados.funcao || perfilAlvo.funcao
    const targetActive = dados.ativo !== undefined ? dados.ativo : perfilAlvo.ativo

    if (isSelf && (!targetActive || targetRole !== 'admin')) {
      return { success: false, error: 'ANTI_LOCKOUT' }
    }

    if (perfilAlvo.funcao === 'admin' && (targetRole !== 'admin' || !targetActive)) {
      const { count: activeAdminsCount, error: countErr } = await adminSupabase
        .from('perfis')
        .select('*', { count: 'exact', head: true })
        .eq('funcao', 'admin')
        .eq('ativo', true)

      if (!countErr && (activeAdminsCount || 0) <= 1) {
        return { success: false, error: 'MINIMO_UM_ADMIN_ATIVO' }
      }
    }

    // 1. Atualizar public.perfis
    const nomeFinal = dados.nome?.trim() || perfilAlvo.nome
    const { error: updPerfilErr } = await adminSupabase
      .from('perfis')
      .update({
        nome: nomeFinal,
        funcao: targetRole,
        ativo: targetActive,
        data_atualizacao: new Date().toISOString()
      })
      .eq('id', usuarioAlvoId)

    if (updPerfilErr) {
      return { success: false, error: `ERRO_ATUALIZAR_PERFIL: ${updPerfilErr.message}` }
    }

    // 2. Atualizar auth.users se email ou senha foram fornecidos
    const authUpdates: Record<string, any> = {
      user_metadata: { nome: nomeFinal }
    }
    if (dados.email && dados.email.trim() !== '') {
      authUpdates.email = dados.email.trim().toLowerCase()
    }
    if (dados.novaSenha && dados.novaSenha.trim() !== '') {
      if (dados.novaSenha.trim().length < 6) {
        return { success: false, error: 'SENHA_MINIMA_6_CARACTERES' }
      }
      authUpdates.password = dados.novaSenha.trim()
    }

    const { error: authUpdErr } = await adminSupabase.auth.admin.updateUserById(usuarioAlvoId, authUpdates)
    if (authUpdErr) {
      console.warn('Aviso ao atualizar auth do usuário:', authUpdErr.message)
    }

    // 3. Atualizar tabela clientes se existir vínculo
    if (dados.telefone !== undefined) {
      await adminSupabase
        .from('clientes')
        .update({
          nome: nomeFinal,
          telefone: dados.telefone?.trim() || null,
          email: dados.email?.trim().toLowerCase() || null
        })
        .eq('id', usuarioAlvoId)
    }

    // 4. Log de auditoria
    await adminSupabase.from('logs_auditoria').insert({
      usuario_id: check.user.id,
      acao: 'editar_usuario',
      detalhes: {
        usuario_alvo_id: usuarioAlvoId,
        nome: nomeFinal,
        funcao_anterior: perfilAlvo.funcao,
        funcao_nova: targetRole,
        ativo_anterior: perfilAlvo.ativo,
        ativo_novo: targetActive,
        senha_redefinida: !!(dados.novaSenha && dados.novaSenha.trim() !== '')
      }
    })

    revalidatePath('/atendimento/admin')
    return { success: true }
  } catch (error: any) {
    console.error('Erro na action editarUsuarioAdmin:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}

/**
 * Server Action 2.5: testarGoogleCalendar
 * Realiza o agendamento de um evento de teste de 15 minutos e registra o resultado em logs_auditoria.
 */
export async function testarGoogleCalendar(
  customCalendarId?: string,
  customClientEmail?: string,
  customPrivateKey?: string
) {
  try {
    const check = await verificarPermissaoOperador()
    if (!check.authorized || !check.user) {
      return { success: false, error: check.error || 'ACESSO_NEGADO_NAO_AUTENTICADO' }
    }

    const { user } = check

    const clientEmail = customClientEmail || await obterConfiguracaoSistema('GOOGLE_CLIENT_EMAIL')
    const privateKey = customPrivateKey || await obterConfiguracaoSistema('GOOGLE_PRIVATE_KEY')
    const calendarId = customCalendarId || await obterConfiguracaoSistema('GOOGLE_CALENDAR_ID')

    const isMockMode =
      !clientEmail ||
      !privateKey ||
      !calendarId ||
      clientEmail.includes('placeholder') ||
      privateKey.includes('placeholder') ||
      calendarId.includes('placeholder')

    let eventId = null
    let sucesso = false
    let erroMensagem = null

    if (isMockMode) {
      console.warn('[Google Calendar Test] Servidor rodando em modo MOCK. Credenciais de calendário ausentes ou placeholders.')
      // Simular latência de rede (200ms)
      await new Promise((resolve) => setTimeout(resolve, 200))
      eventId = `mock-test-event-${Date.now()}`
      sucesso = true
    } else {
      try {
        const auth = new google.auth.JWT({
          email: clientEmail,
          key: privateKey!.replace(/\\n/g, '\n'),
          scopes: ['https://www.googleapis.com/auth/calendar'],
        })

        const calendar = google.calendar({ version: 'v3', auth })

        const start = new Date()
        const end = new Date(start.getTime() + 15 * 60 * 1000) // 15 minutos
        const timestamp = start.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })

        const response = await calendar.events.insert({
          calendarId: calendarId,
          requestBody: {
            summary: `[TESTE] Conexão Asados - ${timestamp}`,
            description: 'Evento de teste para validar a integração com o Google Calendar.',
            start: {
              dateTime: start.toISOString(),
              timeZone: 'America/Sao_Paulo',
            },
            end: {
              dateTime: end.toISOString(),
              timeZone: 'America/Sao_Paulo',
            },
          },
        })

        eventId = response.data.id || 'sem_id'
        sucesso = true
      } catch (err: any) {
        console.error('[Google Calendar Test] Erro ao agendar evento:', err)
        erroMensagem = err.message || 'Falha técnica ao integrar com a API do Google Calendar'
      }
    }

    // Inserir log de auditoria
    const adminSupabase = createAdminClient()
    const { error: logError } = await adminSupabase
      .from('logs_auditoria')
      .insert({
        usuario_id: user.id,
        acao: 'teste_calendario',
        detalhes: {
          sucesso,
          mock: isMockMode,
          eventId,
          erro: erroMensagem,
          calendarId: calendarId || null,
        },
      })

    if (logError) {
      console.error('Erro ao registrar log de teste de calendário:', logError)
    }

    if (!sucesso) {
      return { success: false, error: erroMensagem || 'FALHA_CONEXAO' }
    }

    return { success: true, data: { eventId, mock: isMockMode } }
  } catch (error: any) {
    console.error('Erro na action testarGoogleCalendar:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}

/**
 * Server Action 2.6: obterEstatisticasMensagens
 * Busca a contagem total de mensagens filtradas por remetente e computa a taxa percentual de automação.
 */
export async function obterEstatisticasMensagens() {
  try {
    const check = await verificarPermissaoOperador()
    if (!check.authorized) {
      return { success: false, error: check.error }
    }

    const { supabase } = check

    // Consultas separadas com head: true para obter contagens de forma performática
    const [resIa, resOperador, resCliente] = await Promise.all([
      supabase.from('mensagens').select('*', { count: 'exact', head: true }).eq('remetente', 'ia'),
      supabase.from('mensagens').select('*', { count: 'exact', head: true }).eq('remetente', 'operador'),
      supabase.from('mensagens').select('*', { count: 'exact', head: true }).eq('remetente', 'cliente'),
    ])

    if (resIa.error || resOperador.error || resCliente.error) {
      console.error('Erro ao buscar estatísticas de mensagens:', {
        ia: resIa.error,
        operador: resOperador.error,
        cliente: resCliente.error,
      })
      return {
        success: false,
        error: `ERRO_METRICAS: ${resIa.error?.message || resOperador.error?.message || resCliente.error?.message || 'Falha nas consultas'}`,
      }
    }

    const ia = resIa.count || 0
    const operador = resOperador.count || 0
    const cliente = resCliente.count || 0
    const total = ia + operador + cliente

    const totalRespostas = ia + operador
    const taxaAutomacao = totalRespostas > 0 ? (ia / totalRespostas) * 100 : 0

    return {
      success: true,
      data: {
        totalIa: ia,
        totalOperador: operador,
        totalCliente: cliente,
        totalMensagens: total,
        taxaAutomacao: parseFloat(taxaAutomacao.toFixed(2)),
      },
    }
  } catch (error: any) {
    console.error('Erro na action obterEstatisticasMensagens:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}

/** Aggregate-only operational financial control; never returns identifiers or fiscal accounting data. */
export async function obterMetricasFinanceirasOperacionais(input: unknown) {
  const period = validateReportingPeriod(input)
  if (!period) return { success: false as const, error: 'PERIODO_INVALIDO' }
  try {
    const check = await verificarPermissaoOperador()
    if (!check.authorized) return { success: false as const, error: check.error }
    const admin = createAdminClient()
    const [operational, financial] = await Promise.all([
      admin.rpc('get_operational_reporting', { p_start: period.startAt, p_end: period.endAt }),
      admin.rpc('get_financial_operational_reporting', { p_start: period.startAt, p_end: period.endAt }),
    ])
    if (operational.error || financial.error) return { success: false as const, error: 'METRICAS_FINANCEIRAS_INDISPONIVEIS' }
    return { success: true as const, data: parseFinancialOperationalMetrics(operational.data, financial.data, period.startAt, period.endAt), fetchedAt: new Date().toISOString() }
  } catch (error: any) {
    console.error('Erro na action obterMetricasFinanceirasOperacionais:', error)
    return { success: false as const, error: 'METRICAS_FINANCEIRAS_INDISPONIVEIS' }
  }
}

/**
 * Server Action: obterLogsAuditoria
 * Busca os logs de auditoria mais recentes (limite padrão 100).
 */
export async function obterLogsAuditoria(limite: number = 100) {
  try {
    const check = await verificarPermissaoOperador()
    if (!check.authorized) {
      return { success: false, error: check.error }
    }

    const { supabase } = check

    const { data: logs, error: logsError } = await supabase
      .from('logs_auditoria')
      .select('*')
      .order('data_criacao', { ascending: false })
      .limit(limite)

    if (logsError) {
      console.error('Erro ao buscar logs de auditoria:', logsError)
      return { success: false, error: `ERRO_LOGS: ${logsError.message}` }
    }

    return { success: true, data: logs }
  } catch (error: any) {
    console.error('Erro na action obterLogsAuditoria:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}

/**
 * Server Action: salvarConfiguracaoAdmin
 * Salva/upsert uma chave de configuração do sistema e gera log de auditoria.
 */
export async function salvarConfiguracaoAdmin(chave: string, valor: string) {
  try {
    const check = await verificarPermissaoOperador()
    if (!check.authorized || !check.user) {
      return { success: false, error: check.error || 'ACESSO_NEGADO_NAO_AUTENTICADO' }
    }

    const adminSupabase = createAdminClient()
    const ehSegredo = chave.toUpperCase().includes('_KEY') || chave.toUpperCase().includes('_TOKEN')

    const { error: upsertError } = await adminSupabase
      .from('configuracoes_sistema')
      .upsert({
        chave,
        valor,
        eh_segredo: ehSegredo,
        data_atualizacao: new Date().toISOString()
      }, { onConflict: 'chave' })

    if (upsertError) {
      console.error('Erro ao salvar configuração do sistema:', upsertError)
      return { success: false, error: `ERRO_SALVAR_CONFIG: ${upsertError.message}` }
    }

    const valorMascarado = ehSegredo
      ? (valor.length > 4 ? valor.substring(0, 4) + '***' : '***')
      : valor

    const { error: logError } = await adminSupabase.from('logs_auditoria').insert({
      usuario_id: check.user.id,
      acao: 'salvar_configuracao',
      detalhes: {
        chave,
        valor: valorMascarado
      }
    })

    if (logError) {
      console.warn('Erro ao registrar log de auditoria para salvar_configuracao:', logError.message)
    }

    revalidatePath('/atendimento/admin')
    return { success: true }
  } catch (error: any) {
    console.error('Erro na action salvarConfiguracaoAdmin:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}

const totalPurgeRequestSchema = z.object({
  usuarioAlvoId: z.string().uuid(),
  senhaAtual: z.string().min(1),
  confirmacao: z.literal('PURGAR DEFINITIVAMENTE'),
})
const residualClientPurgeRequestSchema = z.object({
  clienteId: z.string().uuid(),
  senhaAtual: z.string().min(1),
  confirmacao: z.literal('PURGAR RESIDUAL DEFINITIVAMENTE'),
})

function authUserAlreadyAbsent(error: { status?: number; message?: string } | null | undefined) {
  return error?.status === 404 || /user.*not found|not found.*user/i.test(error?.message || '')
}

async function verifyCurrentAdminPassword(actor: { id: string; email?: string | null; phone?: string | null }, password: string) {
  const credential = actor.email ? { email: actor.email, password } : actor.phone ? { phone: actor.phone, password } : null
  if (!credential) return false

  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!anonKey) return false
  const temporaryAuth = createSupabaseClient(getSupabaseServerUrl(), anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await temporaryAuth.auth.signInWithPassword(credential)
  // This client neither persists nor refreshes the temporary session. Let its
  // credentials expire locally: a server-side logout could revoke the active
  // browser session for this same administrator.
  return !error && data.user?.id === actor.id
}

/** Performs the durable total-purge workflow. The password only lives in this invocation. */
export async function purgarUsuarioAdminTotal(input: unknown) {
  const parsed = totalPurgeRequestSchema.safeParse(input)
  if (!parsed.success) return { success: false as const, error: 'CONFIRMACAO_DE_PURGA_INVALIDA' }

  try {
    const check = await verificarPermissaoOperador()
    if (!check.authorized || !check.user) return { success: false as const, error: check.error || 'ACESSO_NEGADO_NAO_AUTENTICADO' }
    if (check.perfil?.funcao !== 'admin') return { success: false as const, error: 'ACESSO_NEGADO_PERMISSAO_INSUFICIENTE' }

    const passwordValid = await verifyCurrentAdminPassword(check.user, parsed.data.senhaAtual)
    if (!passwordValid) return { success: false as const, error: 'SENHA_ATUAL_INVALIDA' }

    const { data: manifest, error: startError } = await check.supabase.rpc('iniciar_purga_total_usuario_admin', {
      p_usuario_alvo_id: parsed.data.usuarioAlvoId,
    })
    if (startError) return { success: false as const, error: startError.message }

    const rows = Array.isArray(manifest) ? manifest : []
    for (const row of rows) {
      if (!row || typeof row !== 'object' || typeof row.job_id !== 'string' || typeof row.bucket_id !== 'string' || typeof row.object_path !== 'string') {
        return { success: false as const, error: 'MANIFESTO_DE_PURGA_INVALIDO' }
      }
      const { error: storageError } = await createAdminClient().storage.from(row.bucket_id).remove([row.object_path])
      const { error: progressError } = await check.supabase.rpc('registrar_storage_purga_usuario_admin', {
        p_job_id: row.job_id, p_bucket_id: row.bucket_id, p_object_path: row.object_path,
        p_sucesso: !storageError, p_erro: storageError ? 'STORAGE_DELETE_FAILED' : null,
      })
      if (storageError || progressError) return { success: false as const, error: 'ERRO_STORAGE_PURGA_PENDENTE' }
    }

    const jobId = rows[0]?.job_id
    if (!jobId) {
      const { data: job, error: lookupError } = await createAdminClient().from('admin_user_deletion_jobs')
        .select('id').eq('target_user_id', parsed.data.usuarioAlvoId).eq('mode', 'purge').single()
      if (lookupError || !job?.id) return { success: false as const, error: 'JOB_DE_PURGA_INDISPONIVEL' }
      rows.push({ job_id: job.id })
    }
    const activeJobId = rows[0].job_id
    const { error: sqlError } = await check.supabase.rpc('executar_sql_purga_total_usuario_admin', { p_job_id: activeJobId })
    if (sqlError) return { success: false as const, error: sqlError.message }

    const { error: authError } = await createAdminClient().auth.admin.deleteUser(parsed.data.usuarioAlvoId)
    if (authError && !authUserAlreadyAbsent(authError)) return { success: false as const, error: 'ERRO_AUTH_DELETE_PENDENTE' }
    const { error: completionError } = await check.supabase.rpc('concluir_purga_total_usuario_admin', { p_job_id: activeJobId })
    if (completionError) return { success: false as const, error: completionError.message }
    revalidatePath('/atendimento/admin')
    return { success: true as const }
  } catch (error: any) {
    console.error('Erro na Server Action purgarUsuarioAdminTotal:', error)
    return { success: false as const, error: error.message || 'ERRO_INTERNO' }
  }
}

/** Purges the records left after a prior client anonymization; it never deletes Auth. */
export async function purgarResidualClienteAdmin(input: unknown) {
  const parsed = residualClientPurgeRequestSchema.safeParse(input)
  if (!parsed.success) return { success: false as const, error: 'CONFIRMACAO_DE_PURGA_INVALIDA' }
  try {
    const check = await verificarPermissaoOperador()
    if (!check.authorized || !check.user) return { success: false as const, error: check.error || 'ACESSO_NEGADO_NAO_AUTENTICADO' }
    if (check.perfil?.funcao !== 'admin') return { success: false as const, error: 'ACESSO_NEGADO_PERMISSAO_INSUFICIENTE' }
    if (!await verifyCurrentAdminPassword(check.user, parsed.data.senhaAtual)) return { success: false as const, error: 'SENHA_ATUAL_INVALIDA' }

    const { data: manifest, error: startError } = await check.supabase.rpc('iniciar_purga_residual_cliente_admin', { p_cliente_id: parsed.data.clienteId })
    if (startError) return { success: false as const, error: startError.message }
    const rows = Array.isArray(manifest) ? manifest : []
    for (const row of rows) {
      if (!row || typeof row !== 'object' || typeof row.job_id !== 'string' || typeof row.bucket_id !== 'string' || typeof row.object_path !== 'string') return { success: false as const, error: 'MANIFESTO_DE_PURGA_INVALIDO' }
      const { error: storageError } = await createAdminClient().storage.from(row.bucket_id).remove([row.object_path])
      const { error: progressError } = await check.supabase.rpc('registrar_storage_purga_residual_cliente_admin', {
        p_job_id: row.job_id, p_bucket_id: row.bucket_id, p_object_path: row.object_path, p_sucesso: !storageError, p_erro: storageError ? 'STORAGE_DELETE_FAILED' : null,
      })
      if (storageError || progressError) return { success: false as const, error: 'ERRO_STORAGE_PURGA_PENDENTE' }
    }
    let jobId = rows[0]?.job_id
    if (!jobId) {
      const { data: job, error: lookupError } = await createAdminClient().from('residual_client_purge_jobs')
        .select('id').eq('client_id', parsed.data.clienteId).single()
      if (lookupError || !job?.id) return { success: false as const, error: 'JOB_DE_PURGA_INDISPONIVEL' }
      jobId = job.id
    }
    const { error: purgeError } = await check.supabase.rpc('executar_purga_residual_cliente_admin', { p_job_id: jobId })
    if (purgeError) return { success: false as const, error: purgeError.message }
    revalidatePath('/atendimento/admin')
    return { success: true as const }
  } catch (error: any) {
    console.error('Erro na Server Action purgarResidualClienteAdmin:', error)
    return { success: false as const, error: error.message || 'ERRO_INTERNO' }
  }
}

/**
 * Server Action 2.1: deletarUsuarioAdmin
 * Realiza a remoção lógica e física completa de todos os dados gerados por um usuário (cliente ou operador),
 * garantindo lockout guards e no mínimo um administrador ativo. Escreve no log de auditoria.
 */
export async function deletarUsuarioAdmin(usuarioAlvoId: string) {
  try {
    const check = await verificarPermissaoOperador()
    if (!check.authorized || !check.user) {
      return { success: false, error: check.error || 'ACESSO_NEGADO_NAO_AUTENTICADO' }
    }
    if (check.perfil?.funcao !== 'admin') {
      return { success: false, error: 'ACESSO_NEGADO_PERMISSAO_INSUFICIENTE' }
    }

    // The database owns one locked transaction: it preserves orders, events,
    // receipts and the immutable audit trail while detaching personal data.
    const { error: dbError } = await check.supabase.rpc('anonymizar_usuario_admin', {
      p_usuario_alvo_id: usuarioAlvoId,
    })
    if (dbError) return { success: false, error: dbError.message }

    // Auth deletion is deliberately after the committed DB authority. If it
    // fails, the inactive/anonymised state remains safe and can be retried.
    const { error: authDeleteError } = await createAdminClient().auth.admin.deleteUser(usuarioAlvoId)
    const authAlreadyAbsent = authUserAlreadyAbsent(authDeleteError)
    if (authDeleteError && !authAlreadyAbsent) {
      return { success: false, error: `ERRO_AUTH_DELETE_PENDENTE: ${authDeleteError.message}` }
    }

    const { error: completionError } = await check.supabase.rpc('concluir_anonymizacao_usuario_admin', {
      p_usuario_alvo_id: usuarioAlvoId,
    })
    if (completionError) return { success: false, error: completionError.message }

    revalidatePath('/atendimento/admin')
    return { success: true }
  } catch (error: any) {
    console.error('Erro na Server Action deletarUsuarioAdmin:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}

/**
 * Server Action: obterModelosDisponiveis
 * Busca dinamicamente os modelos disponíveis em OpenRouter ou DeepSeek de acordo com a API Key informada.
 */
export async function obterModelosDisponiveis(apiKey: string) {
  try {
    const check = await verificarPermissaoOperador()
    if (!check.authorized || !check.user) {
      return { success: false, error: check.error || 'ACESSO_NEGADO_NAO_AUTENTICADO' }
    }

    if (!apiKey || apiKey.trim() === '' || apiKey.toLowerCase().includes('placeholder') || apiKey.toLowerCase().includes('insert_here')) {
      return {
        success: true,
        models: [
          { id: 'google/gemini-2.5-flash', name: 'Google: Gemini 2.5 Flash' },
          { id: 'google/gemini-2.5-pro', name: 'Google: Gemini 2.5 Pro' },
          { id: 'deepseek/deepseek-chat', name: 'DeepSeek: DeepSeek Chat' },
          { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70b Instruct' }
        ]
      }
    }

    const isDeepSeek = !apiKey.includes('sk-or-') && apiKey.startsWith('sk-')

    if (isDeepSeek) {
      return {
        success: true,
        models: [
          { id: 'deepseek-chat', name: 'DeepSeek Chat (v3)' },
          { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner (R1)' }
        ]
      }
    } else {
      try {
        const response = await fetch('https://openrouter.ai/api/v1/models', {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          }
        })
        if (response.ok) {
          const json = await response.json()
          if (json && Array.isArray(json.data)) {
            const modelsList = json.data.map((m: any) => ({
              id: m.id,
              name: m.name || m.id
            }))
            return { success: true, models: modelsList }
          }
        }
        throw new Error(`Resposta HTTP ${response.status}: ${response.statusText}`)
      } catch (err: any) {
        console.warn('Erro ao buscar modelos do OpenRouter, retornando fallback estático:', err.message)
        return {
          success: true,
          models: [
            { id: 'google/gemini-2.5-flash', name: 'Google: Gemini 2.5 Flash' },
            { id: 'google/gemini-2.5-pro', name: 'Google: Gemini 2.5 Pro' },
            { id: 'deepseek/deepseek-chat', name: 'DeepSeek: DeepSeek Chat' },
            { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70b Instruct' },
            { id: 'qwen/qwen-2.5-72b-instruct', name: 'Qwen 2.5 72b Instruct' }
          ]
        }
      }
    }
  } catch (error: any) {
    console.error('Erro na action obterModelosDisponiveis:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}

/**
 * Server Action: testarConexaoLLM
 * Executa uma chamada simples (1 palavra) para testar a validade da API Key e do modelo informados.
 */
export async function testarConexaoLLM(apiKey: string, model: string) {
  try {
    const check = await verificarPermissaoOperador()
    if (!check.authorized || !check.user) {
      return { success: false, error: check.error || 'ACESSO_NEGADO_NAO_AUTENTICADO' }
    }

    if (!apiKey || apiKey.trim() === '' || apiKey.toLowerCase().includes('placeholder') || apiKey.toLowerCase().includes('insert_here')) {
      return { success: false, error: 'A API Key não pode estar vazia ou conter placeholder para o teste.' }
    }

    const isDeepSeek = !apiKey.includes('sk-or-') && apiKey.startsWith('sk-')
    const apiUrl = isDeepSeek
      ? 'https://api.deepseek.com/chat/completions'
      : 'https://openrouter.ai/api/v1/chat/completions'

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }

    if (!isDeepSeek) {
      headers['HTTP-Referer'] = 'https://github.com/wilkin/proyectos/Asados'
      headers['X-Title'] = 'CRM Casa de Assados Brasa & Sabor Test'
    }

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model || (isDeepSeek ? 'deepseek-chat' : 'google/gemini-2.5-flash'),
        messages: [
          { role: 'user', content: 'responda apenas com a palavra OK' }
        ],
        max_tokens: 150,
        temperature: 0.1
      })
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`HTTP ${response.status} - ${text || response.statusText}`)
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content?.trim() || ''

    // Criar entrada no log de auditoria
    const adminSupabase = createAdminClient()
    const keyMasked = apiKey.length > 4 ? apiKey.substring(0, 4) + '***' : '***'
    await adminSupabase.from('logs_auditoria').insert({
      usuario_id: check.user.id,
      acao: 'teste_llm',
      detalhes: {
        modelo: model,
        chave: keyMasked,
        resposta: content
      }
    })

    return { success: true, response: content }
  } catch (error: any) {
    console.error('Erro na action testarConexaoLLM:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}

/**
 * Server Action: testarConexaoOmniRoute
 * Testa a conexão e resolução do OmniRoute Gateway com um combo/tier específico.
 */
export async function testarConexaoOmniRoute(baseUrl: string, apiKey: string, modelOrTier: string) {
  try {
    const check = await verificarPermissaoOperador()
    if (!check.authorized || !check.user) {
      return { success: false, error: check.error || 'ACESSO_NEGADO_NAO_AUTENTICADO' }
    }

    const { baseUrl: host, apiKey: key } = await resolveOmniRouteAdminTarget({
      callerBaseUrl: baseUrl,
      callerApiKey: apiKey,
      configuredBaseUrl: process.env.OMNIROUTE_BASE_URL || 'http://127.0.0.1:20128',
      configuredApiKey: process.env.OMNIROUTE_API_KEY,
    })
    const targetModel = modelOrTier || 'business-economy'

    if (!key || key.toLowerCase().includes('placeholder')) {
      return { success: false, error: 'API Key do OmniRoute não informada ou inválida.' }
    }

    const url = `${host.replace(/\/+$/, '')}/v1/chat/completions`
    const inicio = Date.now()

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: targetModel,
        messages: [
          { role: 'system', content: 'Você é a Sofía da Casa de Assados.' },
          { role: 'user', content: 'responda apenas com a palavra OK' }
        ],
        max_tokens: 150,
        temperature: 0.1
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(15000)
    })

    const latenciaMs = Date.now() - inicio

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`HTTP ${response.status} - ${text || response.statusText}`)
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content?.trim() || ''
    const modelResolved = data.model || targetModel

    const adminSupabase = createAdminClient()
    const keyMasked = key.length > 8 ? key.substring(0, 8) + '***' : '***'
    await adminSupabase.from('logs_auditoria').insert({
      usuario_id: check.user.id,
      acao: 'teste_omniroute',
      detalhes: {
        tier_solicitado: targetModel,
        modelo_resolvido: modelResolved,
        chave: keyMasked,
        latencia_ms: latenciaMs,
        resposta: content
      }
    })

    return {
      success: true,
      response: content,
      modelResolved,
      latencyMs: latenciaMs
    }
  } catch (error: any) {
    console.error('Erro na action testarConexaoOmniRoute:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}

/**
 * Server Action: obterCombosOmniRoute
 * Busca a lista de modelos e combos disponíveis no OmniRoute Gateway.
 */
export async function obterCombosOmniRoute(baseUrl: string, apiKey: string) {
  try {
    const check = await verificarPermissaoOperador()
    if (!check.authorized || !check.user) {
      return { success: false, error: check.error || 'ACESSO_NEGADO_NAO_AUTENTICADO' }
    }

    const { baseUrl: host, apiKey: key } = await resolveOmniRouteAdminTarget({
      callerBaseUrl: baseUrl,
      callerApiKey: apiKey,
      configuredBaseUrl: process.env.OMNIROUTE_BASE_URL || 'http://127.0.0.1:20128',
      configuredApiKey: process.env.OMNIROUTE_API_KEY,
    })

    if (!key || key.toLowerCase().includes('placeholder')) {
      return {
        success: true,
        combos: [
          { id: 'business-economy', name: '🟢 business-economy (FAQs & Cardápio)' },
          { id: 'business-smart', name: '🟡 business-smart (Consultivo & Objeções)' },
          { id: 'business-frontier', name: '🔴 business-frontier (Eventos & Corporativo)' }
        ]
      }
    }

    const url = `${host.replace(/\/+$/, '')}/v1/models`
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      redirect: 'error',
      signal: AbortSignal.timeout(5000)
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const json = await response.json()
    const allModels: string[] = Array.isArray(json.data) ? json.data.map((m: any) => m.id) : []

    return {
      success: true,
      combos: [
        { id: 'business-economy', name: '🟢 business-economy (FAQs & Cardápio)' },
        { id: 'business-smart', name: '🟡 business-smart (Consultivo & Objeções)' },
        { id: 'business-frontier', name: '🔴 business-frontier (Eventos & Corporativo)' }
      ],
      totalModels: allModels.length
    }
  } catch (error: any) {
    console.error('Erro na action obterCombosOmniRoute:', error)
    return {
      success: true,
      combos: [
        { id: 'business-economy', name: '🟢 business-economy (FAQs & Cardápio)' },
        { id: 'business-smart', name: '🟡 business-smart (Consultivo & Objeções)' },
        { id: 'business-frontier', name: '🔴 business-frontier (Eventos & Corporativo)' }
      ]
    }
  }
}

/**
 * Server Action: testarConexaoMeta
 * Verifica a validade do Token de Acesso e do Phone Number ID chamando a Graph API da Meta.
 */
export async function testarConexaoMeta(accessToken: string, phoneNumberId: string) {
  try {
    const check = await verificarPermissaoOperador()
    if (!check.authorized || !check.user) {
      return { success: false, error: check.error || 'ACESSO_NEGADO_NAO_AUTENTICADO' }
    }

    if (!accessToken || accessToken.trim() === '' || !phoneNumberId || phoneNumberId.trim() === '') {
      return { success: false, error: 'O Token de Acesso e o ID do Número são obrigatórios para o teste.' }
    }

    const url = `https://graph.facebook.com/v21.0/${phoneNumberId}`
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    })

    if (!response.ok) {
      const errJson = await response.json().catch(() => ({}))
      const errMsg = errJson.error?.message || response.statusText
      throw new Error(`HTTP ${response.status} - ${errMsg}`)
    }

    const data = await response.json()
    
    // Log de auditoria
    const adminSupabase = createAdminClient()
    await adminSupabase.from('logs_auditoria').insert({
      usuario_id: check.user.id,
      acao: 'teste_meta',
      detalhes: {
        phone_number_id: phoneNumberId,
        display_phone_number: data.display_phone_number || 'N/A',
        verified_name: data.verified_name || 'N/A'
      }
    })

    return { 
      success: true, 
      display_phone_number: data.display_phone_number || 'N/A',
      verified_name: data.verified_name || 'N/A',
      quality_rating: data.quality_rating || 'N/A'
    }
  } catch (error: any) {
    console.error('Erro na Server Action testarConexaoMeta:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}

/**
 * Server Action: testarConexaoEvolution
 * Verifica a conectividade com a Evolution API e o estado da instância informada.
 */
export async function testarConexaoEvolution(apiUrl: string, apiKey: string, instanceName: string) {
  try {
    const check = await verificarPermissaoOperador()
    if (!check.authorized || !check.user) {
      return { success: false, error: check.error || 'ACESSO_NEGADO_NAO_AUTENTICADO' }
    }

    if (!apiUrl || !apiKey || !instanceName) {
      return { success: false, error: 'URL, API Key e Nome da Instância são obrigatórios.' }
    }

    const publicOrigin = process.env.NEXT_PUBLIC_APP_URL || 'https://crmsofiamanager.duckdns.org'
    const { connected: isConnected, state, data } = await getEvolutionConnectionState(
      { apiUrl, apiKey, instanceName },
      publicOrigin,
    )

    // Log de auditoria
    const adminSupabase = createAdminClient()
    await adminSupabase.from('logs_auditoria').insert({
      usuario_id: check.user.id,
      acao: 'teste_evolution',
      detalhes: {
        instance_name: instanceName,
        state,
        connected: isConnected
      }
    })

    return { success: true, connected: isConnected, data }
  } catch (error: any) {
    console.error('Erro na Server Action testarConexaoEvolution:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}

/**
 * Server Action: obterQrCodeEvolution
 * Solicita o QR Code de conexão (em formato base64) para a instância do Evolution API.
 */
export async function obterQrCodeEvolution(apiUrl: string, apiKey: string, instanceName: string) {
  try {
    const check = await verificarPermissaoOperador()
    if (!check.authorized || !check.user) {
      return { success: false, error: check.error || 'ACESSO_NEGADO_NAO_AUTENTICADO' }
    }

    if (!apiUrl || !apiKey || !instanceName) {
      return { success: false, error: 'URL, API Key e Nome da Instância são obrigatórios.' }
    }

    const publicOrigin = process.env.NEXT_PUBLIC_APP_URL || 'https://crmsofiamanager.duckdns.org'
    const { qrcode } = await getEvolutionQrCode(
      { apiUrl, apiKey, instanceName },
      publicOrigin,
    )

    // Log de auditoria
    const adminSupabase = createAdminClient()
    await adminSupabase.from('logs_auditoria').insert({
      usuario_id: check.user.id,
      acao: 'obter_qrcode_evolution',
      detalhes: {
        instance_name: instanceName
      }
    })

    return { success: true, qrcode }
  } catch (error: any) {
    console.error('Erro na Server Action obterQrCodeEvolution:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}

/**
 * Server Action: testarConexaoMercadoPago
 * Valida o Access Token do Mercado Pago chamando a API de métodos de pagamento.
 */
export async function testarConexaoMercadoPago(accessToken: string) {
  try {
    const check = await verificarPermissaoOperador()
    if (!check.authorized || !check.user) {
      return { success: false, error: check.error || 'ACESSO_NEGADO_NAO_AUTENTICADO' }
    }

    if (!accessToken) {
      return { success: false, error: 'O Access Token é obrigatório.' }
    }

    const url = 'https://api.mercadopago.com/v1/payment_methods'
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    })

    if (!response.ok) {
      const errJson = await response.json().catch(() => ({}))
      const errMsg = errJson.message || response.statusText
      throw new Error(`HTTP ${response.status} - ${errMsg}`)
    }

    // Log de auditoria
    const adminSupabase = createAdminClient()
    await adminSupabase.from('logs_auditoria').insert({
      usuario_id: check.user.id,
      acao: 'teste_mercado_pago',
      detalhes: {}
    })

    return { success: true }
  } catch (error: any) {
    console.error('Erro na Server Action testarConexaoMercadoPago:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}

/**
 * Server Action: testarConexaoTelegram
 * Verifica se um token de bot do Telegram é válido chamando getMe.
 */
export async function testarConexaoTelegram(token: string) {
  try {
    const check = await verificarPermissaoOperador()
    if (!check.authorized || !check.user) {
      return { success: false, error: check.error || 'ACESSO_NEGADO_NAO_AUTENTICADO' }
    }

    if (!token) {
      return { success: false, error: 'O token do Telegram é obrigatório.' }
    }

    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    })

    const data = await response.json()

    if (data && data.ok) {
      // Log de auditoria
      const adminSupabase = createAdminClient()
      await adminSupabase.from('logs_auditoria').insert({
        usuario_id: check.user.id,
        acao: 'teste_telegram_bot',
        detalhes: { username: data.result.username }
      })

      return {
        success: true,
        username: data.result.username,
        name: data.result.first_name
      }
    } else {
      return {
        success: false,
        error: data.description || 'Token inválido'
      }
    }
  } catch (error: any) {
    console.error('Erro na Server Action testarConexaoTelegram:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}
/**
 * Server Action 2.7: obterComprovantes
 * Busca e retorna todos os registros de comprovantes da tabela comprovantes,
 * incluindo o nome do cliente correspondente. Suporta filtros por cliente_id
 * e intervalo de datas (dataInicio e dataFim).
 */
export async function obterComprovantes(filtros: {
  clienteId?: string
  dataInicio?: string
  dataFim?: string
}) {
  try {
    const check = await verificarPermissaoOperador()
    if (!check.authorized) {
      return { success: false, error: check.error }
    }

    const { supabase } = check

    let query = supabase
      .from('comprovantes')
      .select('*, clientes(nome)')

    if (filtros.clienteId) {
      query = query.eq('cliente_id', filtros.clienteId)
    }

    if (filtros.dataInicio) {
      query = query.gte('data_criacao', filtros.dataInicio)
    }

    if (filtros.dataFim) {
      query = query.lte('data_criacao', filtros.dataFim)
    }

    const { data, error } = await query.order('data_criacao', { ascending: false })

    if (error) {
      console.error('Erro ao buscar comprovantes no banco:', error)
      return { success: false, error: `ERRO_BANCO_COMPROVANTES: ${error.message}` }
    }

    return { success: true, data }
  } catch (error: any) {
    console.error('Erro na action obterComprovantes:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}

export type AnonymizedResidualClient = { id: string; conversations: number; messages: number; orders: number; paymentProofs: number; legacyReceipts: number; retentionStatus: 'preserved' }
export async function listarRegistrosAnonimizadosPreservados(): Promise<{ success: true; data: AnonymizedResidualClient[] } | { success: false; error: string }> {
  const check = await verificarPermissaoOperador()
  if (!check.authorized || check.perfil?.funcao !== 'admin') return { success: false, error: 'ACESSO_NEGADO_PERMISSAO_INSUFICIENTE' }
  const db = createAdminClient()
  const { data: clients, error } = await db.from('clientes').select('id').is('usuario_id', null).eq('nome', 'Deleted customer').order('id')
  if (error || !clients) return { success: false, error: 'REGISTROS_ANONIMIZADOS_INDISPONIVEIS' }
  const data = await Promise.all(clients.map(async ({ id }) => {
    const [conversations, orders, proofs, receipts] = await Promise.all([
      db.from('conversas').select('*', { count: 'exact', head: true }).eq('cliente_id', id),
      db.from('pedidos').select('*', { count: 'exact', head: true }).eq('cliente_id', id),
      db.from('payment_proofs').select('*', { count: 'exact', head: true }).eq('customer_id', id),
      db.from('comprovantes').select('*', { count: 'exact', head: true }).eq('cliente_id', id),
    ])
    const conversationIds = (await db.from('conversas').select('id').eq('cliente_id', id)).data?.map((row) => row.id) ?? []
    const messages = conversationIds.length ? await db.from('mensagens').select('*', { count: 'exact', head: true }).in('conversa_id', conversationIds) : { count: 0 }
    return { id, conversations: conversations.count ?? 0, messages: messages.count ?? 0, orders: orders.count ?? 0, paymentProofs: proofs.count ?? 0, legacyReceipts: receipts.count ?? 0, retentionStatus: 'preserved' as const }
  }))
  return { success: true, data }
}
