import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const REPO_ROOT = process.cwd()
const WEB_ROOT = join(REPO_ROOT, 'apps/web')
const SKIPPED_DIRS = new Set(['node_modules', '.next', 'dist', 'coverage', '.turbo'])
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json']
const CSP_MARKER = /content-security-policy|script-src/i

type SourceEntry = { path: string; text: string }

function collectSourceFiles(root: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(root)) {
    if (SKIPPED_DIRS.has(entry)) continue
    const full = join(root, entry)
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, acc)
      continue
    }
    if (SCANNED_EXTENSIONS.some((ext) => entry.endsWith(ext))) acc.push(full)
  }
  return acc
}

function readEntries(files: string[]): SourceEntry[] {
  return files.map((path) => ({ path: relative(REPO_ROOT, path), text: readFileSync(path, 'utf8') }))
}

function findCspDirectives(entries: SourceEntry[]): string[] {
  return entries.filter((entry) => CSP_MARKER.test(entry.text)).map((entry) => entry.path)
}

describe('csp source contract', () => {
  it('flags a synthetic local CSP directive so the check cannot pass vacuously', () => {
    const entries: SourceEntry[] = [
      { path: 'apps/web/next.config.ts', text: "headers: () => [{ key: 'Content-Security-Policy', value: \"script-src 'self'\" }]" },
      { path: 'apps/web/src/app/layout.tsx', text: "export const metadata = { title: 'ok' }" },
    ]
    expect(findCspDirectives(entries)).toEqual(['apps/web/next.config.ts'])
  })

  it('flags a synthetic script-src reference even without the header name', () => {
    const entries: SourceEntry[] = [{ path: 'apps/web/proxy.ts', text: "const csp = \"script-src 'unsafe-eval'\"" }]
    expect(findCspDirectives(entries)).toEqual(['apps/web/proxy.ts'])
  })

  it('declares no Content-Security-Policy or script-src anywhere under apps/web', () => {
    const files = collectSourceFiles(WEB_ROOT)
    expect(files.length).toBeGreaterThan(100)
    expect(files.some((file) => file.endsWith(join('apps', 'web', 'next.config.ts')))).toBe(true)
    expect(findCspDirectives(readEntries(files))).toEqual([])
  })

  it('keeps the app free of a headers() export that could re-block Next chunks upstream', () => {
    const config = readFileSync(join(WEB_ROOT, 'next.config.ts'), 'utf8')
    expect(config).not.toMatch(CSP_MARKER)
    expect(existsSync(join(WEB_ROOT, 'middleware.ts'))).toBe(false)
  })
})
