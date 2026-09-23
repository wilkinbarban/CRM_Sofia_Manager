import { obterConfiguracaoSistema } from '@/lib/config/sistema'

/**
 * Configuration keys used to store business profile settings in `configuracoes_sistema`.
 */
export const BUSINESS_PROFILE_CONFIG_KEYS = {
  name: 'BUSINESS_NAME',
  shortName: 'BUSINESS_SHORT_NAME',
  location: 'BUSINESS_LOCATION',
  pickupAddress: 'BUSINESS_PICKUP_ADDRESS',
  description: 'BUSINESS_DESCRIPTION',
  personaRole: 'SOFIA_PERSONA_ROLE',
} as const

export interface BusinessProfile {
  name: string
  shortName: string
  location: string
  pickupAddress: string
  description: string
  personaRole: string
}

/**
 * Default business profile preserved for baseline operations while retaining
 * Curitiba regional validation and identity conventions.
 */
export const DEFAULT_BUSINESS_PROFILE: BusinessProfile = {
  name: 'CRM Sofia Manager',
  shortName: 'Sofia CRM',
  location: 'Curitiba - PR',
  pickupAddress: 'Balcão Principal',
  description: 'Plataforma omnichannel de atendimento inteligente e gestão de pedidos.',
  personaRole: 'assistente virtual inteligente e anfitriã de atendimento',
}

function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function resolveField(
  dbValue: string | null | undefined,
  envValue: string | null | undefined,
  defaultValue: string,
): string {
  return cleanString(dbValue) ?? cleanString(envValue) ?? defaultValue
}

/**
 * Resolves the active business profile.
 * Precedence: `configuracoes_sistema` (DB) > `process.env` > `DEFAULT_BUSINESS_PROFILE`.
 */
export async function getBusinessProfile(): Promise<BusinessProfile> {
  const [dbName, dbShortName, dbLocation, dbPickupAddress, dbDescription, dbPersonaRole] =
    await Promise.all([
      obterConfiguracaoSistema(BUSINESS_PROFILE_CONFIG_KEYS.name),
      obterConfiguracaoSistema(BUSINESS_PROFILE_CONFIG_KEYS.shortName),
      obterConfiguracaoSistema(BUSINESS_PROFILE_CONFIG_KEYS.location),
      obterConfiguracaoSistema(BUSINESS_PROFILE_CONFIG_KEYS.pickupAddress),
      obterConfiguracaoSistema(BUSINESS_PROFILE_CONFIG_KEYS.description),
      obterConfiguracaoSistema(BUSINESS_PROFILE_CONFIG_KEYS.personaRole),
    ])

  return {
    name: resolveField(dbName, process.env[BUSINESS_PROFILE_CONFIG_KEYS.name], DEFAULT_BUSINESS_PROFILE.name),
    shortName: resolveField(
      dbShortName,
      process.env[BUSINESS_PROFILE_CONFIG_KEYS.shortName],
      DEFAULT_BUSINESS_PROFILE.shortName,
    ),
    location: resolveField(
      dbLocation,
      process.env[BUSINESS_PROFILE_CONFIG_KEYS.location],
      DEFAULT_BUSINESS_PROFILE.location,
    ),
    pickupAddress: resolveField(
      dbPickupAddress,
      process.env[BUSINESS_PROFILE_CONFIG_KEYS.pickupAddress],
      DEFAULT_BUSINESS_PROFILE.pickupAddress,
    ),
    description: resolveField(
      dbDescription,
      process.env[BUSINESS_PROFILE_CONFIG_KEYS.description],
      DEFAULT_BUSINESS_PROFILE.description,
    ),
    personaRole: resolveField(
      dbPersonaRole,
      process.env[BUSINESS_PROFILE_CONFIG_KEYS.personaRole],
      DEFAULT_BUSINESS_PROFILE.personaRole,
    ),
  }
}

/**
 * Synchronous resolver for contexts where async DB reads are not possible
 * (e.g. static formatters or initial SSR hydration).
 * Precedence: `process.env` > `DEFAULT_BUSINESS_PROFILE`.
 */
export function resolveBusinessProfileSync(): BusinessProfile {
  return {
    name: resolveField(null, process.env[BUSINESS_PROFILE_CONFIG_KEYS.name], DEFAULT_BUSINESS_PROFILE.name),
    shortName: resolveField(
      null,
      process.env[BUSINESS_PROFILE_CONFIG_KEYS.shortName],
      DEFAULT_BUSINESS_PROFILE.shortName,
    ),
    location: resolveField(
      null,
      process.env[BUSINESS_PROFILE_CONFIG_KEYS.location],
      DEFAULT_BUSINESS_PROFILE.location,
    ),
    pickupAddress: resolveField(
      null,
      process.env[BUSINESS_PROFILE_CONFIG_KEYS.pickupAddress],
      DEFAULT_BUSINESS_PROFILE.pickupAddress,
    ),
    description: resolveField(
      null,
      process.env[BUSINESS_PROFILE_CONFIG_KEYS.description],
      DEFAULT_BUSINESS_PROFILE.description,
    ),
    personaRole: resolveField(
      null,
      process.env[BUSINESS_PROFILE_CONFIG_KEYS.personaRole],
      DEFAULT_BUSINESS_PROFILE.personaRole,
    ),
  }
}

/**
 * Standardized OTP notification message formatted with the business short name.
 */
export function formatOtpMessage(code: string, profile: BusinessProfile = DEFAULT_BUSINESS_PROFILE): string {
  const brand = profile.shortName || profile.name
  return `🔐 *Código de Verificação — ${brand}*\n\nSeu código é: *${code}*\n\n⏳ Válido por *10 minutos*. Se você não solicitou, desconsidere.`
}

/**
 * Standardized Telegram welcome message formatted with the business name.
 */
export function formatTelegramWelcomeMessage(profile: BusinessProfile = DEFAULT_BUSINESS_PROFILE): string {
  const brand = profile.shortName || profile.name
  return `Olá! Seja bem-vindo(a) à *${brand}*!\n\nEm que posso te ajudar hoje?`
}
