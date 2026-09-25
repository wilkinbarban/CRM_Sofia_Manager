import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const dir = join(process.cwd(), 'supabase/migrations')
const name = '20260922040000_clear_legacy_tags_and_hours.sql'
const path = join(dir, name)
const read = (file: string) => readFileSync(join(dir, file), 'utf8')
const brand = read('20260828160000_update_brand_and_combos_brasa_sabor.sql')
const original = read('20260816260000_seed_combos_e_base_conhecimento_oficial.sql')
const hours = read('20260708000000_estoque_horarios.sql')
const sourceTags = [...brand.matchAll(/tags = (ARRAY\[[^\]]+\])/g)].map((m) => m[1])
const pickup = original.match(/'Janelas de Retirada \(Takeaway\)[^\n]+\n\s*'[^\n]+\n\s*(ARRAY\[[^\]]+\])/)
const seedMessage = hours.match(/'MENSAGEM_FORA_HORARIO',\s*'([^']+)'/)

function assignments(sql: string) {
  return [...sql.matchAll(/update public\.base_conhecimento\s+set tags = (ARRAY\[[^\]]+\])(?:::varchar\(100\)\[\])?\s+where tags = (ARRAY\[[^\]]+\])(?:::varchar\(100\)\[\])?/gi)]
    .map((match) => ({ target: match[1], source: match[2] }))
}

function values(array: string) {
  return [...array.matchAll(/'([^']+)'/g)].map((match) => match[1])
}

// Model SQL array/text equality: NULL never satisfies the WHERE predicate.
function applyTagGuard(input: string[] | null, source: string[], target: string[]): string[] | null {
  return input !== null && input.length === source.length && input.every((tag, index) => tag === source[index])
    ? [...target]
    : input
}

function applyHoursGuard(input: string | null, source: string, target: string): string | null {
  return input === source ? target : input
}

// The full hours seed guard must use empty-tag dollar quoting ($$...$$): the
// runner (ops/supabase/migrate.sh) mis-lexes tagged $tag$ bodies and rejects
// their content. Returns [full, target, source, style].
function hoursGuard(sql: string) {
  const single = sql.match(/update public\.configuracoes_sistema\s+set valor = '([^']+)'\s+where chave = 'MENSAGEM_FORA_HORARIO'\s+and valor = '([^']+)'/i)
  if (single) return [single[0], single[1], single[2], 'single'] as const
  const dollar = sql.match(/update public\.configuracoes_sistema\s+set valor = '([^']+)'\s+where chave = 'MENSAGEM_FORA_HORARIO'\s+and valor = \$\$([\s\S]*?)\$\$/i)
  if (dollar) return [dollar[0], dollar[1], dollar[2], 'dollar'] as const
  return null
}

describe('exact legacy tags and hours cleanup', () => {
  it('types every tag equality operand to match the declared varchar(100)[] column', () => {
    const schema = read('20260704160000_epica5_rag_knowledge.sql')
    expect(schema).toMatch(/tags\s+VARCHAR\(100\)\[\]/i)
    const sql = readFileSync(path, 'utf8')
    const pairs = assignments(sql)
    expect(pairs).toHaveLength(3)
    const typedGuards = [...sql.matchAll(/set tags = ARRAY\[[^\]]+\]::varchar\(100\)\[\]\s+where tags = ARRAY\[[^\]]+\]::varchar\(100\)\[\]/gi)]
    expect(typedGuards).toHaveLength(pairs.length)
  })
  it('simulates seed conversion once and stability on a second pass', () => {
    const pairs = assignments(readFileSync(path, 'utf8'))
    expect(pairs).toHaveLength(3)
    for (const pair of pairs) {
      const source = values(pair.source)
      const target = values(pair.target)
      const first = applyTagGuard(source, source, target)
      expect(first).toEqual(target)
      expect(applyTagGuard(first, source, target)).toEqual(target)
    }
    const sql = readFileSync(path, 'utf8')
    const match = hoursGuard(sql)
    expect(match).not.toBeNull()
    expect(match![3]).toBe('dollar')
    expect(match![2]).toBe(seedMessage![1])
    const first = applyHoursGuard(match![2], match![2], match![1])
    expect(first).toBe(match![1])
    expect(applyHoursGuard(first, match![2], match![1])).toBe(match![1])
  })

  it('simulates preserving reordered, extended, custom and null operator values across two passes', () => {
    const pairs = assignments(readFileSync(path, 'utf8'))
    expect(pairs).toHaveLength(3)
    for (const pair of pairs) {
      const source = values(pair.source)
      const target = values(pair.target)
      const variants: (string[] | null)[] = [null, [...source].reverse(), [...source, 'operator'], ['operator']]
      for (const variant of variants) {
        const first = applyTagGuard(variant, source, target)
        expect(first).toEqual(variant)
        expect(applyTagGuard(first, source, target)).toEqual(variant)
      }
    }
    const sql = readFileSync(path, 'utf8')
    const match = hoursGuard(sql)
    expect(match).not.toBeNull()
    for (const variant of [null, `${match![2]} operator edit`, 'operator message']) {
      const first = applyHoursGuard(variant, match![2], match![1])
      expect(first).toBe(variant)
      expect(applyHoursGuard(first, match![2], match![1])).toBe(variant)
    }
  })

  it('is a forward-only migration immediately after content cleanup', () => {
    expect(existsSync(path)).toBe(true)
    const ordered = readdirSync(dir).filter((file) => file.endsWith('.sql')).sort()
    expect(ordered[ordered.indexOf(name) - 1]).toBe('20260922030000_clear_legacy_knowledge_content.sql')
  })

  it('maps only the three exact seed tag arrays, preserving product tags', () => {
    expect(sourceTags).toHaveLength(2)
    expect(pickup).not.toBeNull()
    const sql = readFileSync(path, 'utf8')
    const pairs = assignments(sql)
    expect(pairs).toHaveLength(3)
    expect(pairs.map((pair) => pair.source)).toEqual([...sourceTags, pickup![1]])
    expect(pairs.map((pair) => values(pair.target))).toEqual([
      values(sourceTags[0]).filter((tag) => tag !== 'clássico brasa e sabor'),
      values(sourceTags[1]).filter((tag) => tag !== 'dueto brasa & sabor'),
      values(pickup![1]).filter((tag) => tag !== 'umbara' && tag !== 'curitiba'),
    ])
    for (const pair of pairs) {
      const custom = [...values(pair.source), 'custom']
      expect(custom).not.toEqual(values(pair.source))
      expect(pair.target).not.toBe(pair.source)
      expect(pairs.some((other) => other.source === pair.target)).toBe(false)
    }
  })

  it('changes only the exact original hours message and keeps dynamic schedule placeholders', () => {
    expect(seedMessage).not.toBeNull()
    const sql = readFileSync(path, 'utf8')
    const match = hoursGuard(sql)
    expect(match).not.toBeNull()
    expect(match![3]).toBe('dollar')
    expect(match![2]).toBe(seedMessage![1])
    expect(match![1]).not.toBe(match![2])
    for (const placeholder of ['{dias_semana}', '{horario_inicio}', '{horario_fim}']) expect(match![1]).toContain(placeholder)
    expect(match![1]).not.toMatch(/🥩|🍖|Curitiba|Asados|demonstração|fictício/i)
    expect(sql).not.toMatch(/\b(like|ilike|replace)\b/i)
  })

  it('obeys runner lexical rules and limits writes to tags and the keyed message', () => {
    const sql = readFileSync(path, 'utf8')
    const script = readFileSync(join(process.cwd(), 'ops/supabase/migrate.sh'), 'utf8')
    const start = script.indexOf("LC_ALL=C awk '")
    const end = script.indexOf("' \"$1\"", start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const check = spawnSync('awk', [script.slice(start + "LC_ALL=C awk '".length, end), path], { encoding: 'utf8' })
    expect(check.status, check.stderr).toBe(0)
    const body = sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n')
    expect(body.match(/\bupdate\b/gi)).toHaveLength(4)
    expect(body).not.toMatch(/\b(create|alter|drop|delete|insert|begin|commit|rollback)\b/i)
    expect(body).not.toMatch(/\bE'|\bU&'|^\\/im)
  })
})
