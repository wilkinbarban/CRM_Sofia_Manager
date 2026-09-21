import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { listarUsuariosAdmin, obterEstatisticasMensagens } from '@/app/actions/admin'
import { isUsableDeepSeekApiKey } from '@/lib/ai/deepseek'
import AdminDashboard from '@/components/operator/AdminDashboard'
import { OperatorWorkspaceHeader } from '@/components/operator/OperatorWorkspaceHeader'

export const dynamic = 'force-dynamic'

type AdminPageProps = {
  searchParams: Promise<{ tab?: string | string[] }>
}

/**
 * Secret-shaped configuration keys, matching the `eh_segredo` classification
 * used by `salvarConfiguracaoAdmin` on the write path. Must stay in sync with
 * it: a key classified as secret on one side and not the other reopens the
 * leak this boundary closes.
 */
const SECRET_CONFIG_KEY_PATTERN = /(_KEY|_TOKEN|_SECRET)/i

/** Client-side DeepSeek state marker: the key status without the key itself. */
const DEEPSEEK_CONFIGURED_KEY = 'DEEPSEEK_CONFIGURED'

/**
 * Projects `configuracoes_sistema` onto the client payload.
 *
 * Every value whose key contains `_KEY`, `_TOKEN`, or `_SECRET` is dropped at
 * this server-to-client boundary — including environment fallbacks — so the
 * dashboard can only render write-only credential inputs instead of prefilled
 * secrets. `DEEPSEEK_CONFIGURED` is the single DeepSeek signal that crosses:
 * it is serialized as the string `'true'` because `systemConfigs` is a string
 * map, and it mirrors the same key resolution
 * (`configuracoes_sistema` first, environment fallback, placeholder keys
 * rejected) that `listAuthorizedDeepSeekModels` uses on the server.
 */
function toClientSystemConfigs(systemConfigs: Record<string, string>): Record<string, string> {
  const clientConfigs: Record<string, string> = {}

  for (const [key, value] of Object.entries(systemConfigs)) {
    if (SECRET_CONFIG_KEY_PATTERN.test(key)) continue
    clientConfigs[key] = value
  }

  const deepSeekApiKey = systemConfigs.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY
  if (isUsableDeepSeekApiKey(deepSeekApiKey)) {
    clientConfigs[DEEPSEEK_CONFIGURED_KEY] = 'true'
  }

  return clientConfigs
}

const adminTabs = new Set([
  'operadores', 'integracoes', 'conhecimento', 'metricas', 'auditoria',
  'prompt', 'horarios', 'estoque', 'storage-orphans', 'comprovantes',
])

export default async function AdminPage({ searchParams }: AdminPageProps) {
  const supabase = await createClient()
  const requestedTab = (await searchParams).tab
  const initialTab = typeof requestedTab === 'string' && adminTabs.has(requestedTab)
    ? requestedTab
    : 'operadores'

  // 1. Verificar sessão do usuário ativo
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    redirect('/login')
  }

  // 2. Buscar perfil e validar se está ativo e possui papel administrativo (admin/supervisor)
  const { data: perfil, error: perfilError } = await supabase
    .from('perfis')
    .select('id, nome, funcao, ativo')
    .eq('id', user.id)
    .single()

  if (perfilError || !perfil || !perfil.ativo) {
    redirect('/login')
  }

  const allowedRoles = ['admin', 'supervisor']
  if (!allowedRoles.includes(perfil.funcao)) {
    redirect('/login') // Redireciona para o login ou página apropriada
  }

  // 3. Pré-carregar dados via Server Actions e consultas diretas
  const [usuariosRes, estatisticasRes] = await Promise.all([
    listarUsuariosAdmin(),
    obterEstatisticasMensagens()
  ])

  // 4. Buscar últimos 50 logs de auditoria
  const { data: logs, error: logsError } = await supabase
    .from('logs_auditoria')
    .select('*')
    .order('data_criacao', { ascending: false })
    .limit(50)

  if (logsError) {
    console.error('Erro ao buscar logs de auditoria no SSR:', logsError)
  }

  // 5. Buscar artigos de base de conhecimento
  const { data: artigos, error: artigosError } = await supabase
    .from('base_conhecimento')
    .select('id, titulo, conteudo, tags, ativo, data_criacao, data_atualizacao')
    .order('data_criacao', { ascending: false })

  if (artigosError) {
    console.error('Erro ao buscar artigos no SSR:', artigosError)
  }

  // 6. Buscar configurações do sistema
  const { data: dbConfigs, error: configsError } = await supabase
    .from('configuracoes_sistema')
    .select('chave, valor')

  if (configsError) {
    console.error('Erro ao buscar configuracoes do sistema no SSR:', configsError)
  }

  const systemConfigs: Record<string, string> = {
    DEEPSEEK_API_KEY: '',
    DEEPSEEK_MODEL: '',
    OPENROUTER_API_KEY: '',
    WHATSAPP_ACCESS_TOKEN: '',
    WHATSAPP_PHONE_NUMBER_ID: '',
    OPENROUTER_MODEL: '',
    WHATSAPP_APP_SECRET: '',
    WHATSAPP_VERIFY_TOKEN: '',
    EVOLUTION_API_URL: '',
    EVOLUTION_API_KEY: '',
    EVOLUTION_INSTANCE_NAME: '',
    WHATSAPP_PROVIDER: 'meta',
    MERCADO_PAGO_ACCESS_TOKEN: '',
    MERCADO_PAGO_PUBLIC_KEY: '',
    MERCADO_PAGO_WEBHOOK_SECRET: '',
    TELEGRAM_BOT_TOKEN: '',
    SOFIA_SYSTEM_PROMPT: '',
  }

  if (dbConfigs) {
    dbConfigs.forEach((cfg) => {
      systemConfigs[cfg.chave] = cfg.valor
    })
  }

  // Fallback to environment variables if not present in the database
  if (!systemConfigs.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY) {
    systemConfigs.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
  }
  if (!systemConfigs.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_ACCESS_TOKEN) {
    systemConfigs.WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN
  }
  if (!systemConfigs.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_PHONE_NUMBER_ID) {
    systemConfigs.WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID
  }
  if (!systemConfigs.OPENROUTER_MODEL && process.env.OPENROUTER_MODEL) {
    systemConfigs.OPENROUTER_MODEL = process.env.OPENROUTER_MODEL
  }
  if (!systemConfigs.DEEPSEEK_MODEL && process.env.DEEPSEEK_MODEL) {
    systemConfigs.DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL
  }
  if (!systemConfigs.WHATSAPP_APP_SECRET && process.env.WHATSAPP_APP_SECRET) {
    systemConfigs.WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET
  }
  if (!systemConfigs.WHATSAPP_VERIFY_TOKEN && process.env.WHATSAPP_VERIFY_TOKEN) {
    systemConfigs.WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN
  }
  if (!systemConfigs.EVOLUTION_API_URL && process.env.EVOLUTION_API_URL) {
    systemConfigs.EVOLUTION_API_URL = process.env.EVOLUTION_API_URL
  }
  if (!systemConfigs.EVOLUTION_API_KEY && process.env.EVOLUTION_API_KEY) {
    systemConfigs.EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY
  }
  if (!systemConfigs.EVOLUTION_INSTANCE_NAME && process.env.EVOLUTION_INSTANCE_NAME) {
    systemConfigs.EVOLUTION_INSTANCE_NAME = process.env.EVOLUTION_INSTANCE_NAME
  }
  if (!systemConfigs.WHATSAPP_PROVIDER && process.env.WHATSAPP_PROVIDER) {
    systemConfigs.WHATSAPP_PROVIDER = process.env.WHATSAPP_PROVIDER
  }
  if (!systemConfigs.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_TOKEN) {
    systemConfigs.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
  }
  if (!systemConfigs.SOFIA_SYSTEM_PROMPT && process.env.SOFIA_SYSTEM_PROMPT) {
    systemConfigs.SOFIA_SYSTEM_PROMPT = process.env.SOFIA_SYSTEM_PROMPT
  }
  if (!systemConfigs.MERCADO_PAGO_ACCESS_TOKEN && process.env.MERCADO_PAGO_ACCESS_TOKEN) {
    systemConfigs.MERCADO_PAGO_ACCESS_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN
  }
  if (!systemConfigs.MERCADO_PAGO_PUBLIC_KEY && process.env.MERCADO_PAGO_PUBLIC_KEY) {
    systemConfigs.MERCADO_PAGO_PUBLIC_KEY = process.env.MERCADO_PAGO_PUBLIC_KEY
  }
  if (!systemConfigs.MERCADO_PAGO_WEBHOOK_SECRET && process.env.MERCADO_PAGO_WEBHOOK_SECRET) {
    systemConfigs.MERCADO_PAGO_WEBHOOK_SECRET = process.env.MERCADO_PAGO_WEBHOOK_SECRET
  }

  // 7. Server-to-client projection: no secret value crosses the boundary
  const clientSystemConfigs = toClientSystemConfigs(systemConfigs)

  // 8. Configuração do Google Calendar
  const calendarConfig = {
    googleCalendarId: process.env.GOOGLE_CALENDAR_ID || null,
    googleClientEmail: process.env.GOOGLE_CLIENT_EMAIL || null,
    googlePrivateKeyConfigured: !!process.env.GOOGLE_PRIVATE_KEY
  }

  return (
    <div className="flex h-screen w-full flex-col bg-zinc-950 text-zinc-50 overflow-hidden font-sans">
      <OperatorWorkspaceHeader
        active="admin"
        role={perfil.funcao}
        adminTab={initialTab}
      />

      {/* Conteúdo Principal */}
      <main className="flex-1 overflow-hidden">
        <AdminDashboard
          initialTab={initialTab as 'operadores'}
          usuarioLogado={{
            id: perfil.id,
            nome: perfil.nome,
            funcao: perfil.funcao,
            ativo: perfil.ativo
          }}
          usuariosIniciais={usuariosRes.success ? (usuariosRes.data || []) : []}
          estatisticasIniciais={estatisticasRes.success ? (estatisticasRes.data || { totalIa: 0, totalOperador: 0, totalCliente: 0, totalMensagens: 0, taxaAutomacao: 0 }) : { totalIa: 0, totalOperador: 0, totalCliente: 0, totalMensagens: 0, taxaAutomacao: 0 }}
          logsIniciais={logs || []}
          calendarConfig={calendarConfig}
          artigosIniciais={artigos || []}
          systemConfigs={clientSystemConfigs}
        />
      </main>
    </div>
  )
}
