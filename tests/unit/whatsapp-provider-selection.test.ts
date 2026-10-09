import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/config/sistema', () => ({ obterConfiguracaoSistema: vi.fn() }))
vi.mock('@/lib/whatsapp/evolution', () => ({
  EvolutionProvider: class EvolutionProvider {
    readonly transport = 'evolution'
  },
}))
vi.mock('@/lib/whatsapp/send', () => ({
  MetaProvider: class MetaProvider {
    readonly transport = 'meta'
  },
}))

import { obterConfiguracaoSistema } from '@/lib/config/sistema'

function transportOf(provider: unknown): string {
  return (provider as { transport?: string }).transport ?? 'unknown'
}

describe('whatsapp provider selection', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(obterConfiguracaoSistema).mockReset()
  })

  afterEach(() => {
    vi.resetModules()
  })

  it.each(['meta', 'evolution', 'META', 'omniroute', ''])(
    'always resolves the Evolution provider when the legacy configuration says "%s"',
    async (configured) => {
      vi.mocked(obterConfiguracaoSistema).mockResolvedValue(configured as never)

      const { obterProvedorAtivo } = await import('@/lib/whatsapp/provider')
      const provider = await obterProvedorAtivo()

      expect(transportOf(provider)).toBe('evolution')
    }
  )

  it('resolves the Evolution provider when no provider key is configured at all', async () => {
    vi.mocked(obterConfiguracaoSistema).mockResolvedValue(null as never)

    const { obterProvedorAtivo } = await import('@/lib/whatsapp/provider')
    const provider = await obterProvedorAtivo()

    expect(transportOf(provider)).toBe('evolution')
  })
})
