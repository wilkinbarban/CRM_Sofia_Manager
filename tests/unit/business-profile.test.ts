import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  DEFAULT_BUSINESS_PROFILE,
  BUSINESS_PROFILE_CONFIG_KEYS,
  getBusinessProfile,
  resolveBusinessProfileSync,
  formatOtpMessage,
  formatTelegramWelcomeMessage,
  type BusinessProfile,
} from '@/lib/config/business-profile'
import * as sistemaConfig from '@/lib/config/sistema'

describe('Business Profile configuration', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.restoreAllMocks()
    process.env = { ...originalEnv }
    delete process.env.BUSINESS_NAME
    delete process.env.BUSINESS_SHORT_NAME
    delete process.env.BUSINESS_LOCATION
    delete process.env.BUSINESS_PICKUP_ADDRESS
    delete process.env.BUSINESS_DESCRIPTION
    delete process.env.SOFIA_PERSONA_ROLE
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('exposes defined default values with Curitiba regional location preserved', () => {
    expect(DEFAULT_BUSINESS_PROFILE.name).toBe('Casa de Assados Brasa & Sabor')
    expect(DEFAULT_BUSINESS_PROFILE.shortName).toBe('Asados')
    expect(DEFAULT_BUSINESS_PROFILE.location).toContain('Curitiba')
    expect(DEFAULT_BUSINESS_PROFILE.pickupAddress).toBeDefined()
    expect(DEFAULT_BUSINESS_PROFILE.personaRole).toBeDefined()
  })

  it('resolves default profile when no DB and no environment values are configured', async () => {
    vi.spyOn(sistemaConfig, 'obterConfiguracaoSistema').mockResolvedValue(null)

    const profile = await getBusinessProfile()
    expect(profile).toEqual(DEFAULT_BUSINESS_PROFILE)
  })

  it('resolves environment variables when DB values are absent', async () => {
    vi.spyOn(sistemaConfig, 'obterConfiguracaoSistema').mockResolvedValue(null)
    process.env.BUSINESS_NAME = 'Pizzaria do Bairro'
    process.env.BUSINESS_SHORT_NAME = 'Pizzaria'
    process.env.BUSINESS_LOCATION = 'Batel, Curitiba - PR'
    process.env.BUSINESS_PICKUP_ADDRESS = 'Balcão Batel'
    process.env.SOFIA_PERSONA_ROLE = 'assistente de pedidos'

    const profile = await getBusinessProfile()
    expect(profile.name).toBe('Pizzaria do Bairro')
    expect(profile.shortName).toBe('Pizzaria')
    expect(profile.location).toBe('Batel, Curitiba - PR')
    expect(profile.pickupAddress).toBe('Balcão Batel')
    expect(profile.personaRole).toBe('assistente de pedidos')
  })

  it('prioritizes database configuracoes_sistema over environment variables', async () => {
    process.env.BUSINESS_NAME = 'Env Business'
    process.env.BUSINESS_SHORT_NAME = 'EnvShort'

    vi.spyOn(sistemaConfig, 'obterConfiguracaoSistema').mockImplementation(async (key: string) => {
      if (key === BUSINESS_PROFILE_CONFIG_KEYS.name) return 'DB Business'
      if (key === BUSINESS_PROFILE_CONFIG_KEYS.shortName) return 'DBShort'
      return null
    })

    const profile = await getBusinessProfile()
    expect(profile.name).toBe('DB Business')
    expect(profile.shortName).toBe('DBShort')
  })

  it('falls back to environment or default if DB returns whitespace or placeholder', async () => {
    process.env.BUSINESS_NAME = 'Fallback Name'

    vi.spyOn(sistemaConfig, 'obterConfiguracaoSistema').mockImplementation(async (key: string) => {
      if (key === BUSINESS_PROFILE_CONFIG_KEYS.name) return '   '
      return null
    })

    const profile = await getBusinessProfile()
    expect(profile.name).toBe('Fallback Name')
    expect(profile.shortName).toBe(DEFAULT_BUSINESS_PROFILE.shortName)
  })

  it('resolveBusinessProfileSync falls back to environment or defaults synchronously', () => {
    process.env.BUSINESS_NAME = 'Sync Business'
    const profile = resolveBusinessProfileSync()
    expect(profile.name).toBe('Sync Business')
    expect(profile.shortName).toBe(DEFAULT_BUSINESS_PROFILE.shortName)
  })

  it('formats OTP message with business short name and exact expiration notice', () => {
    const customProfile: BusinessProfile = {
      ...DEFAULT_BUSINESS_PROFILE,
      shortName: 'EmpresaX',
    }

    const msg = formatOtpMessage('123456', customProfile)
    expect(msg).toContain('EmpresaX')
    expect(msg).toContain('123456')
    expect(msg).toContain('10 minutos')
  })

  it('formats Telegram welcome message with business short or full name', () => {
    const customProfile: BusinessProfile = {
      ...DEFAULT_BUSINESS_PROFILE,
      name: 'Empresa Modelo',
      shortName: 'Modelo',
    }

    const msg = formatTelegramWelcomeMessage(customProfile)
    expect(msg).toContain('Modelo')
  })
})
