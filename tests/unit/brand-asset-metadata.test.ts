import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { metadata } from '@/app/layout'
import { resolveBusinessProfileSync } from '@/lib/config/business-profile'

function sha256(filePath: string): string {
  const buffer = readFileSync(filePath)
  return createHash('sha256').update(buffer).digest('hex')
}

function getPngDimensions(filePath: string): { width: number; height: number } {
  const buffer = readFileSync(filePath)
  // PNG signature is 8 bytes, followed by IHDR chunk: 4 bytes length, 4 bytes type ('IHDR'), 4 bytes width, 4 bytes height
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  return { width, height }
}

describe('brand visual identity assets & metadata', () => {
  /**
   * Remote-verified brand asset SHA256 fingerprints.
   * Provenance: Remote-verified brand asset kit (crm-sofia-assets-manifest.tsv / visual identity kit).
   * The /odd/ directory is ignored in Git (.gitignore), so literal hashes ensure the test suite is
   * self-contained and portable across CI environments without external filesystem dependencies.
   */
  const VERIFIED_BRAND_ASSET_HASHES = {
    icon: '2ef2b925529c383f0e7b008874784eb819fcae83785c3f5314ba86d9b1dc0eb4',
    apple: '2c986621c69326ed7e15ee2292ca2b1eb9e8326ec07052a224e3f49fd49d839c',
    ico: '89713a9ebe996b3d77f1a73b2afb8ab32a1b5c5b72decb7c08c008515dd78ba3',
    favicon16: '20de6ece8c95e4de552fea23a0d216b3ea64ca8dc10c500b4d0eace2c07f3f49',
    favicon32: '8cb8529c8c4ed7a3b82dc6e7341fd30736b3f00335f86974fb97199e46aa903e',
    banner: '73418c84e8a90788450a33acd5552c903239b43d0d707902ba245d71332baa9e',
  } as const

  it('verifies all expected static brand assets exist and match the verified staged kit hashes', () => {
    const expectedAssets = [
      {
        targetPath: resolve('apps/web/public/icon.png'),
        expectedSha: VERIFIED_BRAND_ASSET_HASHES.icon,
        expectedDimensions: { width: 512, height: 512 },
        type: 'png' as const,
      },
      {
        targetPath: resolve('apps/web/public/apple-touch-icon.png'),
        expectedSha: VERIFIED_BRAND_ASSET_HASHES.apple,
        expectedDimensions: { width: 180, height: 180 },
        type: 'png' as const,
      },
      {
        targetPath: resolve('apps/web/public/favicon-16x16.png'),
        expectedSha: VERIFIED_BRAND_ASSET_HASHES.favicon16,
        expectedDimensions: { width: 16, height: 16 },
        type: 'png' as const,
      },
      {
        targetPath: resolve('apps/web/public/favicon-32x32.png'),
        expectedSha: VERIFIED_BRAND_ASSET_HASHES.favicon32,
        expectedDimensions: { width: 32, height: 32 },
        type: 'png' as const,
      },
      {
        targetPath: resolve('apps/web/public/banners/banner-og-dark-1200x630.png'),
        expectedSha: VERIFIED_BRAND_ASSET_HASHES.banner,
        expectedDimensions: { width: 1200, height: 630 },
        type: 'png' as const,
      },
      {
        targetPath: resolve('apps/web/public/favicon.ico'),
        expectedSha: VERIFIED_BRAND_ASSET_HASHES.ico,
        type: 'ico' as const,
      },
      {
        targetPath: resolve('apps/web/src/app/favicon.ico'),
        expectedSha: VERIFIED_BRAND_ASSET_HASHES.ico,
        type: 'ico' as const,
      },
    ]

    for (const asset of expectedAssets) {
      expect(existsSync(asset.targetPath), `File should exist: ${asset.targetPath}`).toBe(true)

      const actualSha = sha256(asset.targetPath)
      expect(actualSha, `Hash mismatch for ${asset.targetPath}`).toBe(asset.expectedSha)

      if (asset.type === 'png' && asset.expectedDimensions) {
        const dims = getPngDimensions(asset.targetPath)
        expect(dims).toEqual(asset.expectedDimensions)
      }
    }
  })

  it('configures layout.tsx OpenGraph metadata to 1200x630 banner and preserves dynamic business profile', () => {
    const profile = resolveBusinessProfileSync()

    const og = metadata.openGraph as {
      title?: string
      description?: string
      url?: string | URL
      siteName?: string
      locale?: string
      type?: string
      images?: Array<{ url: string | URL; width?: number; height?: number; alt?: string }>
    } | null | undefined

    expect(og).toBeDefined()
    expect(og?.title).toBe(`${profile.name} | Atendimento Inteligente & Gestão de Pedidos`)
    expect(og?.description).toBe(profile.description)
    expect(og?.url).toBe('https://crmsofiamanager.duckdns.org')
    expect(og?.siteName).toBe(profile.name)
    expect(og?.locale).toBe('pt_BR')
    expect(og?.type).toBe('website')

    const ogImages = og?.images
    expect(Array.isArray(ogImages)).toBe(true)
    const imageList = ogImages as Array<{ url: string | URL; width?: number; height?: number; alt?: string }>
    expect(imageList.length).toBeGreaterThanOrEqual(1)

    const primaryImage = imageList[0]
    expect(primaryImage.url).toBe('/banners/banner-og-dark-1200x630.png')
    expect(primaryImage.width).toBe(1200)
    expect(primaryImage.height).toBe(630)
    expect(primaryImage.alt).toBe(`${profile.name} - Atendimento Inteligente`)
  })

  it('configures Twitter summary_large_image card sharing metadata with the 1200x630 banner', () => {
    const profile = resolveBusinessProfileSync()

    expect(metadata.twitter).toBeDefined()
    const twitter = metadata.twitter as {
      card?: string
      title?: string
      description?: string
      images?: string[]
    }
    expect(twitter?.card).toBe('summary_large_image')
    expect(twitter?.title).toBe(`${profile.name} | Atendimento Inteligente & Gestão de Pedidos`)
    expect(twitter?.description).toBe(profile.description)
    expect(twitter?.images).toEqual(['/banners/banner-og-dark-1200x630.png'])
  })

  it('preserves valid favicon and icon references in layout metadata', () => {
    expect(metadata.icons).toBeDefined()
    const icons = metadata.icons as {
      icon?: Array<{ url: string; sizes?: string; type?: string }>
      shortcut?: string
      apple?: string
    }
    expect(icons.shortcut).toBe('/favicon.ico')
    expect(icons.apple).toBe('/apple-touch-icon.png')
    expect(icons.icon).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: '/favicon.ico' }),
        expect.objectContaining({ url: '/icon.png' }),
      ])
    )
  })
})
