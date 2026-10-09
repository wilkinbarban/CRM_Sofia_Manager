import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const LOGIN_PATH = 'apps/web/src/app/login/page.tsx'

function loginSource(): string {
  return readFileSync(join(process.cwd(), LOGIN_PATH), 'utf8')
}

describe('login screen polish contract', () => {
  it('declares a single level-one heading carrying the resolved brand name', () => {
    const source = loginSource()

    expect(source.match(/<h1/g) ?? []).toHaveLength(1)
    expect(source).toMatch(/<h1[^>]*>\s*\{brandName \|\| brandShortName\}/)
  })

  it('exposes the login mode as an accessible tab list with linked panels', () => {
    const source = loginSource()

    expect(source).toContain('role="tablist"')
    expect(source.match(/role="tab"/g) ?? []).toHaveLength(2)
    expect(source.match(/aria-selected=/g) ?? []).toHaveLength(2)
    expect(source).toContain('role="tabpanel"')
    expect(source).toContain('aria-controls=')
    expect(source).toContain('aria-labelledby=')
  })

  it('shares one field style constant across the login form inputs', () => {
    const source = loginSource()

    expect(source).toMatch(/const FIELD_CLASS =/)
    expect(source.match(/className=\{FIELD_CLASS\}/g) ?? []).toHaveLength(3)
  })

  it('gives the primary action a mobile-sized touch target', () => {
    const source = loginSource()

    expect(source).toMatch(/type="submit"[\s\S]{0,400}min-h-11/)
  })
})
