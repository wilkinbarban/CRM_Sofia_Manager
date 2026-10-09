import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Presentation contract for the "Meu Perfil" module on phones.
 *
 * This suite asserts the control markup statically because the harness cannot
 * mount this component: `PerfilForm` calls `useRouter` on render and this stack
 * (Next 16.3.3 sources under vitest) resolves `next/navigation` in a way that
 * bypasses `vi.mock` and every App Router context the test can provide, so any
 * render throws "invariant expected app router to be mounted". The same defect
 * already breaks other pre-existing suites (`operator-inactivity`,
 * `cliente/perfil`). Once the harness can mount an App Router context, this
 * contract should move to a rendered assertion.
 */
const source = readFileSync(
  resolve(import.meta.dirname, '../../apps/web/src/components/operator/PerfilForm.tsx'),
  'utf-8',
)

function tagsOf(element: 'button' | 'input'): string[] {
  const tags: string[] = []
  const opener = new RegExp(`<${element}\\b`, 'g')
  let match: RegExpExecArray | null

  while ((match = opener.exec(source)) !== null) {
    let depth = 0
    let index = match.index + match[0].length

    for (; index < source.length; index += 1) {
      const char = source[index]
      if (char === '{') depth += 1
      else if (char === '}') depth -= 1
      else if (char === '>' && depth === 0) break
    }

    tags.push(source.slice(match.index, index + 1))
    opener.lastIndex = index
  }

  return tags
}

describe('PerfilForm mobile treatment', () => {
  it('gives every control a touch-sized target', () => {
    const controls = [...tagsOf('button'), ...tagsOf('input')]
    expect(controls.length).toBeGreaterThanOrEqual(7)

    for (const control of controls) {
      expect(control).toContain('min-h-11')
    }
  })

  it('stacks the primary actions full width so a phone can reach them with the thumb', () => {
    const primary = tagsOf('button').filter((tag) => tag.includes('type="submit"'))
    expect(primary).toHaveLength(2)

    for (const action of primary) {
      expect(action).toContain('w-full')
      expect(action).toContain('sm:w-auto')
    }
  })

  it('names the password visibility toggles for assistive technology', () => {
    expect(source).toContain("aria-label={verSenha ? 'Ocultar senha' : 'Mostrar senha'}")
    expect(source).toContain(
      "aria-label={verConfirmarSenha ? 'Ocultar confirmação de senha' : 'Mostrar confirmação de senha'}",
    )
  })
})
