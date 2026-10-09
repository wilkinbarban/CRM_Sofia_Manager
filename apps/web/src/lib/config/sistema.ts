import { createAdminClient } from '@/lib/supabase/admin'

/**
 * Recupera uma chave de configuração do sistema.
 * Consulta prioritariamente a tabela public.configuracoes_sistema do banco de dados.
 * Se ausente, recorre a process.env como contingência (fallback).
 * 
 * @param chave Nome da chave de configuração
 */
export async function obterConfiguracaoSistema(chave: string): Promise<string | null> {
  try {
    const supabase = createAdminClient()
    
    // Consulta direta à tabela configuracoes_sistema ignorando RLS via service_role
    const { data, error } = await supabase
      .from('configuracoes_sistema')
      .select('valor')
      .eq('chave', chave)
      .maybeSingle()
      
    if (error) {
      console.warn(`[Config Fallback] Erro ao ler a chave ${chave} do banco de dados:`, error.message)
    }

    if (data && data.valor) {
      return data.valor
    }
  } catch (err) {
    console.error(`[Config Fallback] Falha técnica ao consultar chave ${chave}:`, err)
  }

  // Fallback para variáveis de ambiente locais do servidor
  return process.env[chave] || null
}

export const SOFIA_GLOBAL_CONFIG_KEYS = {
  whatsapp: 'SOFIA_GLOBAL_WHATSAPP_ENABLED',
  telegram: 'SOFIA_GLOBAL_TELEGRAM_ENABLED',
} as const

export type SofiaGlobalChannel = keyof typeof SOFIA_GLOBAL_CONFIG_KEYS
export type SofiaChannelAvailability = 'operational' | 'scheduled_pause' | 'global_off'

export type SofiaGlobalChannelConfig = {
  channel: SofiaGlobalChannel
  key: (typeof SOFIA_GLOBAL_CONFIG_KEYS)[SofiaGlobalChannel]
  enabled: boolean
  rawValue: string | null
  configured: boolean
}

const SOFIA_CHANNEL_CREDENTIAL_KEYS: Record<SofiaGlobalChannel, readonly string[]> = {
  whatsapp: ['EVOLUTION_API_URL', 'EVOLUTION_API_KEY', 'EVOLUTION_INSTANCE_NAME'],
  telegram: ['TELEGRAM_BOT_TOKEN'],
}

export function deriveSofiaChannelConfigured(
  channel: SofiaGlobalChannel,
  values: Record<string, string | null | undefined>,
): boolean {
  return SOFIA_CHANNEL_CREDENTIAL_KEYS[channel].every(key => {
    const value = values[key]
    return typeof value === 'string' && value.trim().length > 0
  })
}

const BOOLEAN_TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on', 'enabled', 'sim'])
const BOOLEAN_FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off', 'disabled', 'nao', 'não'])

export function parseBooleanConfigValue(value: string | null | undefined, defaultValue = true): boolean {
  if (value == null) return defaultValue

  const normalized = value.trim().toLowerCase()
  if (!normalized) return defaultValue
  if (BOOLEAN_TRUE_VALUES.has(normalized)) return true
  if (BOOLEAN_FALSE_VALUES.has(normalized)) return false

  return defaultValue
}

export function deriveSofiaChannelAvailability(
  enabled: boolean,
  withinBusinessHours: boolean,
): SofiaChannelAvailability {
  if (!enabled) return 'global_off'
  return withinBusinessHours ? 'operational' : 'scheduled_pause'
}

export async function obterSofiaGlobalChannelConfig(channel: SofiaGlobalChannel): Promise<SofiaGlobalChannelConfig> {
  const key = SOFIA_GLOBAL_CONFIG_KEYS[channel]
  const credentialKeys = SOFIA_CHANNEL_CREDENTIAL_KEYS[channel]
  const [rawValue, ...credentialValues] = await Promise.all([
    obterConfiguracaoSistema(key),
    ...credentialKeys.map(credentialKey => obterConfiguracaoSistema(credentialKey)),
  ])

  const credentials = Object.fromEntries(
    credentialKeys.map((credentialKey, index) => [credentialKey, credentialValues[index]]),
  )

  return {
    channel,
    key,
    enabled: parseBooleanConfigValue(rawValue, true),
    rawValue,
    configured: deriveSofiaChannelConfigured(channel, credentials),
  }
}

export async function obterSofiaGlobalStatusConfig(): Promise<Record<SofiaGlobalChannel, SofiaGlobalChannelConfig>> {
  const [whatsapp, telegram] = await Promise.all([
    obterSofiaGlobalChannelConfig('whatsapp'),
    obterSofiaGlobalChannelConfig('telegram'),
  ])

  return { whatsapp, telegram }
}

export async function salvarSofiaGlobalChannelConfig(channel: SofiaGlobalChannel, enabled: boolean): Promise<SofiaGlobalChannelConfig> {
  const supabase = createAdminClient()
  const key = SOFIA_GLOBAL_CONFIG_KEYS[channel]
  const value = enabled ? 'true' : 'false'

  const { error } = await supabase
    .from('configuracoes_sistema')
    .upsert({
      chave: key,
      valor: value,
      eh_segredo: false,
      data_atualizacao: new Date().toISOString(),
    }, { onConflict: 'chave' })

  if (error) {
    throw new Error(`Failed to persist Sofia global status: ${error.message}`)
  }

  return obterSofiaGlobalChannelConfig(channel)
}
