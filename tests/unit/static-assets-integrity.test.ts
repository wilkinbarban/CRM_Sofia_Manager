import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

function collectFiles(dirPath: string, extensions: string[]): string[] {
  const result: string[] = []
  if (!existsSync(dirPath)) return result

  const entries = readdirSync(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      result.push(...collectFiles(fullPath, extensions))
    } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
      result.push(fullPath)
    }
  }
  return result
}

describe('static assets integrity & legacy references probe', () => {
  const repoRoot = resolve(__dirname, '../..')
  const webSrcDir = join(repoRoot, 'apps/web/src')
  const webPublicDir = join(repoRoot, 'apps/web/public')
  const docsDir = join(repoRoot, 'docs')

  const retiredAssetNames = [
    'logo-brasa-sabor.png',
    'logo-brasa-sabor.svg',
    'docx_extracted',
  ]

  it('verifies apps/web/src contains zero references to retired legacy artwork', () => {
    const srcFiles = collectFiles(webSrcDir, ['.ts', '.tsx', '.js', '.jsx', '.json', '.css'])
    expect(srcFiles.length).toBeGreaterThan(0)

    for (const filePath of srcFiles) {
      const content = readFileSync(filePath, 'utf8')
      for (const retiredName of retiredAssetNames) {
        expect(
          content.includes(retiredName),
          `Found forbidden legacy reference "${retiredName}" in ${filePath}`,
        ).toBe(false)
      }
    }
  })

  it('verifies documentation contains zero references to retired legacy artwork', () => {
    const docFiles = collectFiles(docsDir, ['.md', '.txt'])
    for (const filePath of docFiles) {
      const content = readFileSync(filePath, 'utf8')
      for (const retiredName of retiredAssetNames) {
        expect(
          content.includes(retiredName),
          `Found forbidden legacy reference "${retiredName}" in docs file ${filePath}`,
        ).toBe(false)
      }
    }
  })

  it('verifies all static public asset URLs referenced in runtime code exist on disk', () => {
    const srcFiles = collectFiles(webSrcDir, ['.ts', '.tsx'])
    const staticUrlRegex = /['"](\/(?:cardapio|banners)\/[a-zA-Z0-9_\-.]+\.(?:png|jpg|jpeg|svg|webp))['"]/g

    const referencedPaths = new Set<string>()

    for (const filePath of srcFiles) {
      const content = readFileSync(filePath, 'utf8')
      let match: RegExpExecArray | null
      while ((match = staticUrlRegex.exec(content)) !== null) {
        referencedPaths.add(match[1])
      }
    }

    expect(referencedPaths.size).toBeGreaterThan(0)

    for (const publicUrl of referencedPaths) {
      // Strips leading slash to map to apps/web/public
      const relativePath = publicUrl.replace(/^\//, '')
      const diskPath = join(webPublicDir, relativePath)
      expect(
        existsSync(diskPath),
        `Referenced asset does not exist on disk: ${diskPath} (from URL ${publicUrl})`,
      ).toBe(true)
    }
  })

  it('verifies layout core visual identity assets exist in apps/web/public', () => {
    const criticalLayoutAssets = [
      'favicon.ico',
      'icon.png',
      'apple-touch-icon.png',
      'banners/banner-og-dark-1200x630.png',
    ]

    for (const assetName of criticalLayoutAssets) {
      const diskPath = join(webPublicDir, assetName)
      expect(existsSync(diskPath), `Critical layout asset missing on disk: ${diskPath}`).toBe(true)
    }
  })
})
