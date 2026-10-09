import { describe, expect, it, vi, beforeEach } from 'vitest'

const { mockGetBusinessProfile } = vi.hoisted(() => ({ mockGetBusinessProfile: vi.fn() }))

vi.mock('@/lib/config/business-profile', () => ({
  getBusinessProfile: mockGetBusinessProfile,
  resolveBusinessProfileSync: () => ({
    name: 'CRM Sofia Manager',
    shortName: 'CRM Sofia',
    location: 'Curitiba - PR',
    description: 'Plataforma omnichannel',
    personaRole: '',
    pickupAddress: '',
  }),
  DEFAULT_BUSINESS_PROFILE: {
    name: 'CRM Sofia Manager',
    shortName: 'CRM Sofia',
    location: 'Curitiba - PR',
    description: 'Plataforma omnichannel',
    personaRole: '',
    pickupAddress: '',
  },
}))

describe('brand metadata from the database profile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('builds the document metadata from the profile resolved on the server', async () => {
    mockGetBusinessProfile.mockResolvedValue({
      name: 'Padaria do Zé',
      shortName: 'Padaria Zé',
      location: 'Curitiba - PR',
      description: 'Padaria artesanal',
      personaRole: '',
      pickupAddress: '',
    })

    const layout = await import('@/app/layout')
    const metadata = await layout.generateMetadata()

    expect(mockGetBusinessProfile).toHaveBeenCalled()
    expect(metadata.openGraph?.siteName).toBe('Padaria do Zé')
    expect(metadata.openGraph?.title).toContain('Padaria do Zé')
    const title = metadata.title
    const defaultTitle = typeof title === 'string' ? title : ((title as { default?: string } | undefined)?.default ?? '')
    expect(defaultTitle).toContain('Padaria do Zé')
    expect(metadata.twitter?.title).toContain('Padaria do Zé')
  })

  it('falls back to the environment profile when the database profile is unavailable', async () => {
    mockGetBusinessProfile.mockRejectedValue(new Error('base indisponível'))

    const layout = await import('@/app/layout')
    const metadata = await layout.generateMetadata()

    expect(metadata.openGraph?.siteName).toBe('CRM Sofia Manager')
    expect(metadata.openGraph?.title).toContain('CRM Sofia Manager')
  })

  it('returns only the public brand fields from the public profile action', async () => {
    mockGetBusinessProfile.mockResolvedValue({
      name: 'Padaria do Zé',
      shortName: 'Padaria Zé',
      location: 'Curitiba - PR',
      description: 'Padaria artesanal',
      personaRole: '',
      pickupAddress: '',
    })

    const { obterPerfilPublico } = await import('@/app/actions/public-profile')

    await expect(obterPerfilPublico()).resolves.toEqual({
      name: 'Padaria do Zé',
      shortName: 'Padaria Zé',
      location: 'Curitiba - PR',
    })
  })

  it('fails with a descriptive error instead of a null dereference when the profile is missing', async () => {
    mockGetBusinessProfile.mockResolvedValue(undefined as never)

    const { obterPerfilPublico } = await import('@/app/actions/public-profile')

    await expect(obterPerfilPublico()).rejects.toThrow(/perfil de empresa indisponível/i)
  })

  it('keeps the customer-visible action free of a null dereference crash', async () => {
    mockGetBusinessProfile.mockResolvedValue({ name: undefined } as never)

    const { obterPerfilPublico } = await import('@/app/actions/public-profile')

    await expect(obterPerfilPublico()).rejects.toThrow(/perfil de empresa indisponível/i)
  })
})
