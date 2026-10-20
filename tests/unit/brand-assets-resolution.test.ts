import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, statSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { generateMetadata } from '@/app/layout'
import {
  DEFAULT_BUSINESS_PROFILE,
  resolveBusinessProfileSync,
  getBusinessProfile,
  BUSINESS_PROFILE_CONFIG_KEYS,
} from '@/lib/config/business-profile'
import { obterCartoesCombosOficiais } from '@/lib/cardapio/cards'

vi.mock('@/lib/config/sistema', () => ({
  obterConfiguracaoSistema: vi.fn(async () => null),
}))

describe('brand assets resolution and URL compatibility harness', () => {
  const originalEnv = { ...process.env }
  const webPublicDir = resolve(__dirname, '../../apps/web/public')

  beforeEach(() => {
    vi.clearAllMocks()
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('resolves default layout metadata assets exclusively to verified modern brand paths', async () => {
    const metadata = await generateMetadata()

    // OpenGraph image assertions
    const ogImages = (metadata.openGraph as { images?: Array<{ url: string | URL }> })?.images
    expect(ogImages).toBeDefined()
    expect(ogImages!.length).toBeGreaterThan(0)
    const primaryOgUrl = String(ogImages![0].url)
    expect(primaryOgUrl).toBe('/banners/banner-og-dark-1200x630.png')
    expect(primaryOgUrl).not.toContain('brasa')
    expect(primaryOgUrl).not.toContain('docx')

    // Twitter image assertions
    const twitterImages = (metadata.twitter as { images?: string[] })?.images
    expect(twitterImages).toBeDefined()
    expect(twitterImages![0]).toBe('/banners/banner-og-dark-1200x630.png')

    // Icon assertions
    const icons = metadata.icons as {
      icon?: Array<{ url: string }>
      shortcut?: string
      apple?: string
    }
    expect(icons.shortcut).toBe('/favicon.ico')
    expect(icons.apple).toBe('/apple-touch-icon.png')
    const iconUrls = (icons.icon ?? []).map((i) => i.url)
    expect(iconUrls).toContain('/favicon.ico')
    expect(iconUrls).toContain('/icon.png')

    // Ensure none of the icon URLs reference legacy assets
    for (const url of iconUrls) {
      expect(url).not.toContain('brasa')
      expect(url).not.toContain('docx')
    }
  })

  it('guarantees all resolved layout asset paths point to readable non-empty files in public', () => {
    const resolvedAssetUrls = [
      '/banners/banner-og-dark-1200x630.png',
      '/favicon.ico',
      '/icon.png',
      '/apple-touch-icon.png',
      '/favicon-16x16.png',
      '/favicon-32x32.png',
    ]

    for (const assetUrl of resolvedAssetUrls) {
      const diskPath = join(webPublicDir, assetUrl.replace(/^\//, ''))
      expect(existsSync(diskPath), `Expected file to exist: ${diskPath}`).toBe(true)

      const stats = statSync(diskPath)
      expect(stats.isFile()).toBe(true)
      expect(stats.size).toBeGreaterThan(100) // All assets must be non-empty valid files
    }
  })

  it('preserves clean brand name fallback without injecting legacy company names', () => {
    delete process.env[BUSINESS_PROFILE_CONFIG_KEYS.name]
    delete process.env[BUSINESS_PROFILE_CONFIG_KEYS.shortName]

    const profile = resolveBusinessProfileSync()
    expect(profile.name).toBe(DEFAULT_BUSINESS_PROFILE.name)
    expect(profile.shortName).toBe(DEFAULT_BUSINESS_PROFILE.shortName)
    expect(profile.name).not.toMatch(/brasa|sabor/i)
  })

  it('resolves dynamic business profile environment overrides while preserving safe asset URLs', async () => {
    process.env[BUSINESS_PROFILE_CONFIG_KEYS.name] = 'Custom Gastro Bar'
    process.env[BUSINESS_PROFILE_CONFIG_KEYS.shortName] = 'Gastro Bar'

    const profile = await getBusinessProfile()
    expect(profile.name).toBe('Custom Gastro Bar')
    expect(profile.shortName).toBe('Gastro Bar')

    const metadata = await generateMetadata()
    expect(metadata.title).toEqual({
      default: 'Custom Gastro Bar | Atendimento Inteligente',
      template: '%s | CRM Sofia Manager',
    })

    // Assets remain deterministic regardless of dynamic text changes
    const ogImages = (metadata.openGraph as { images?: Array<{ url: string | URL }> })?.images
    expect(String(ogImages![0].url)).toBe('/banners/banner-og-dark-1200x630.png')
  })

  it('verifies all catalog card images resolve to existing /cardapio files with valid image headers', () => {
    const cards = obterCartoesCombosOficiais()
    expect(cards.length).toBeGreaterThan(0)

    // Magic headers for image binary formats (PNG: 89 50 4E 47, JPEG: FF D8 FF)
    const isPng = (buf: Buffer) => buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    const isJpeg = (buf: Buffer) => buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff

    for (const card of cards) {
      const imagePaths = [card.urlImagemPrincipal, card.urlImagemSecundaria]
      for (const imgUrl of imagePaths) {
        expect(imgUrl.startsWith('/cardapio/')).toBe(true)
        expect(imgUrl).not.toContain('brasa')

        const diskPath = join(webPublicDir, imgUrl.replace(/^\//, ''))
        expect(existsSync(diskPath), `Card image missing: ${diskPath}`).toBe(true)

        const buf = readFileSync(diskPath)
        const hasValidHeader = isPng(buf) || isJpeg(buf)
        expect(hasValidHeader, `File is not a valid image binary: ${diskPath}`).toBe(true)
      }
    }
  })
})
