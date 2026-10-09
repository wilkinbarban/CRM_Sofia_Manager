import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = process.cwd()

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8')
}

describe('brand runtime wiring', () => {
  it('resolves the business profile on the server for the customer layout and passes it to the logo', () => {
    const source = read('apps/web/src/app/cliente/layout.tsx')

    expect(source).toContain('getBusinessProfile(')
    expect(source).toMatch(/<BrandLogo[^>]*brandName=/)
    expect(source).not.toContain('CRM Sofia Manager')
  })

  it('passes the resolved business name from the customer chat page into the chat container', () => {
    const source = read('apps/web/src/app/cliente/chat/page.tsx')

    expect(source).toContain('getBusinessProfile(')
    expect(source).toMatch(/<ChatContainer[\s\S]*brandName=/)
  })

  it('keeps no hardcoded business name in the admin control panel title', () => {
    const source = read('apps/web/src/components/operator/AdminDashboard.tsx')

    expect(source).not.toContain('Painel de Controle • CRM Sofia Manager')
    expect(source).toMatch(/Painel de Controle • \{/)
  })
})
