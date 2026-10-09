import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CONSOLE_FILES = [
  'apps/web/src/components/operator/SofiaGlobalStatusBar.tsx',
  'apps/web/src/components/operator/OperatorInboxContainer.tsx',
]

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

describe('attendant console polish contract', () => {
  it.each(CONSOLE_FILES)('keeps a mobile-sized touch target on the interactive controls of %s', (path) => {
    const text = source(path)

    expect(text).toContain('min-h-11')
    expect(text.match(/min-h-11/g) ?? []).toHaveLength(
      (text.match(/<button/g) ?? []).length
    )
  })

  it('keeps visible focus affordances on those controls', () => {
    for (const path of CONSOLE_FILES) {
      expect(source(path)).toContain('focus-visible:ring')
    }
  })
})
