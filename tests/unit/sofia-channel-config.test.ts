import { describe, expect, it } from 'vitest'
import { deriveSofiaChannelConfigured } from '@/lib/config/sistema'

describe('sofia channel configuration detection', () => {
  it('requires every Evolution credential before WhatsApp can be considered configured', () => {
    expect(
      deriveSofiaChannelConfigured('whatsapp', {
        EVOLUTION_API_URL: 'http://evolution:8080',
        EVOLUTION_API_KEY: 'global-key',
        EVOLUTION_INSTANCE_NAME: 'asados',
      })
    ).toBe(true)

    expect(
      deriveSofiaChannelConfigured('whatsapp', {
        EVOLUTION_API_URL: 'http://evolution:8080',
        EVOLUTION_API_KEY: 'global-key',
      })
    ).toBe(false)

    expect(
      deriveSofiaChannelConfigured('whatsapp', {
        EVOLUTION_API_URL: '   ',
        EVOLUTION_API_KEY: 'global-key',
        EVOLUTION_INSTANCE_NAME: 'asados',
      })
    ).toBe(false)
  })

  it('requires the Telegram bot token before Telegram can be considered configured', () => {
    expect(deriveSofiaChannelConfigured('telegram', { TELEGRAM_BOT_TOKEN: '123:abc' })).toBe(true)
    expect(deriveSofiaChannelConfigured('telegram', { TELEGRAM_BOT_TOKEN: '  ' })).toBe(false)
    expect(deriveSofiaChannelConfigured('telegram', {})).toBe(false)
  })
})
