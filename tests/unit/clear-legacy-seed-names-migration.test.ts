import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATION_NAME = '20260922020000_clear_legacy_seed_names.sql'
const MIGRATIONS_DIR = join(process.cwd(), 'supabase/migrations')
const MIGRATION_PATH = join(MIGRATIONS_DIR, MIGRATION_NAME)
const PREVIOUS_MIGRATION = '20260922010000_clear_legacy_sofia_prompt.sql'
const MIGRATE_SH_PATH = join(process.cwd(), 'ops/supabase/migrate.sh')
const SEED_OFICIAL_PATH = join(MIGRATIONS_DIR, '20260816260000_seed_combos_e_base_conhecimento_oficial.sql')
const SEED_BRAND_PATH = join(MIGRATIONS_DIR, '20260828160000_update_brand_and_combos_brasa_sabor.sql')
const ORIGIN_MIGRATION_PATH = join(MIGRATIONS_DIR, '20260920020000_replace_retired_origin_in_knowledge.sql')
const CARDS_PATH = join(process.cwd(), 'apps/web/src/lib/cardapio/cards.ts')

interface Assignment {
  table: string
  column: string
  target: string
  source: string
}

function readMigration(): string {
  return readFileSync(MIGRATION_PATH, 'utf8')
}

function stripComments(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
}

function parseAssignments(sql: string): Assignment[] {
  const body = stripComments(sql)
  const pattern =
    /update\s+public\.(\w+)\s+set\s+(\w+)\s*=\s*'([^']*)'\s+where\s+(\w+)\s*=\s*'([^']*)'/gi
  return [...body.matchAll(pattern)].map((match) => ({
    table: match[1],
    column: match[2],
    target: match[3],
    source: match[5],
  }))
}

function comboNameFromCards(cards: string, numeroCombo: number): string {
  const match = cards.match(new RegExp(`numeroCombo: ${numeroCombo},[\\s\\S]*?nome: '([^']*)'`))
  if (!match) throw new Error(`Combo ${numeroCombo} name not found in cards.ts`)
  return match[1]
}

function applyAssignments(mock: Map<string, string[]>, assignments: Assignment[]): number {
  let changed = 0
  for (const assignment of assignments) {
    const key = `${assignment.table}.${assignment.column}`
    const values = mock.get(key) ?? []
    const next = values.map((value) => (value === assignment.source ? assignment.target : value))
    changed += next.reduce((total, value, index) => total + (value === values[index] ? 0 : 1), 0)
    mock.set(key, next)
  }
  return changed
}

function runMigrateShValidator(filePath: string) {
  const script = readFileSync(MIGRATE_SH_PATH, 'utf8')
  const awkStart = script.indexOf("LC_ALL=C awk '")
  const awkEnd = script.indexOf("' \"$1\"", awkStart)
  if (awkStart === -1 || awkEnd === -1) throw new Error('Could not extract validate_sql awk script from migrate.sh')
  const awkBody = script.slice(awkStart + "LC_ALL=C awk '".length, awkEnd)
  return spawnSync('awk', [awkBody, filePath], { encoding: 'utf8' })
}

const cards = readFileSync(CARDS_PATH, 'utf8')
const comboNome1 = comboNameFromCards(cards, 1)
const comboNome3 = comboNameFromCards(cards, 3)
const RETIRED_PRODUCT_1 = 'Combo 1 – O Clássico Brasa & Sabor'
const RETIRED_PRODUCT_3 = 'Combo 3 – Dueto Brasa & Sabor (Frango & Costelinha Suína)'
const RETIRED_TITLE_1 = 'Combo 1 – O Clássico Brasa & Sabor: Ficha Técnica e Detalhes'
const RETIRED_TITLE_3 = 'Combo 3 – Dueto Brasa & Sabor (Frango & Costelinha Suína): Ficha Técnica'
const RETIRED_TITLE_PICKUP = 'Janelas de Retirada (Takeaway) e Delivery Próprio em Curitiba'
const TARGET_TITLE_PICKUP = 'Janelas de Retirada (Takeaway) e Delivery Próprio'

describe('20260922020000_clear_legacy_seed_names migration', () => {
  it('exists with a forward-only timestamp strictly after 20260922010000', () => {
    expect(existsSync(MIGRATION_PATH), `Migration file must exist at ${MIGRATION_PATH}`).toBe(true)

    const allMigrations = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith('.sql'))
      .sort()

    const targetIndex = allMigrations.indexOf(MIGRATION_NAME)
    expect(targetIndex, `${MIGRATION_NAME} must be indexed in migrations`).toBeGreaterThan(-1)

    const previousIndex = allMigrations.indexOf(PREVIOUS_MIGRATION)
    expect(previousIndex, `${PREVIOUS_MIGRATION} must exist`).toBeGreaterThan(-1)
    expect(targetIndex, `Target migration must follow ${PREVIOUS_MIGRATION}`).toBeGreaterThan(previousIndex)

    const targetTimestamp = MIGRATION_NAME.split('_')[0]
    expect(targetTimestamp).toBe('20260922020000')
    expect(Number(targetTimestamp)).toBeGreaterThan(20260922010000)
    expect(allMigrations[targetIndex - 1]).toBe(PREVIOUS_MIGRATION)
  })

  it('uses a filename the migrate.sh inventory accepts', () => {
    expect(MIGRATION_NAME).toMatch(/^\d{14}_[A-Za-z0-9_]+\.sql$/)
  })

  it('obeys ops/supabase/migrate.sh lexical rules without embedded transactions or metacommands', () => {
    const rawSql = readMigration()
    const validation = runMigrateShValidator(MIGRATION_PATH)

    expect(validation.status, `validate_sql failed with stderr: ${validation.stderr}`).toBe(0)
    expect(rawSql).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i)
    expect(rawSql).not.toMatch(/^\\/m)
    expect(rawSql).not.toMatch(/\bE'/i)
    expect(rawSql).not.toMatch(/\bU&'/i)
  })

  it('contains purely DML cleanup and no DDL or function owner transfer statements', () => {
    const statements = stripComments(readMigration())
    expect(statements).not.toMatch(/\b(create|alter|drop|owner\s+to)\b/i)
  })

  it('scopes exactly five assignments to product names and article titles', () => {
    const assignments = parseAssignments(readMigration())

    expect(assignments).toHaveLength(5)
    expect(assignments.filter((a) => a.table === 'produtos' && a.column === 'nome')).toHaveLength(2)
    expect(assignments.filter((a) => a.table === 'base_conhecimento' && a.column === 'titulo')).toHaveLength(3)

    for (const assignment of assignments) {
      expect(assignment.source).not.toBe(assignment.target)
    }

    const statements = stripComments(readMigration())
    expect(statements).not.toMatch(/configuracoes_sistema/i)
    expect(statements).not.toMatch(/set\s+(conteudo|tags|descricao)/i)
    expect(statements).not.toMatch(/public\.(?!produtos|base_conhecimento)/i)
  })

  it('matches with exact equality and never with broad or partial matching', () => {
    const body = stripComments(readMigration())

    expect(body).toMatch(/where\s+nome\s*=\s*'/i)
    expect(body).toMatch(/where\s+titulo\s*=\s*'/i)
    expect(body).not.toMatch(/\blike\b/i)
    expect(body).not.toMatch(/\bilike\b/i)
    expect(body).not.toMatch(/replace\s*\(/i)
    expect(body).not.toMatch(/%/)
  })

  it('retires the exact seeded product names and titles recorded by the current seed migrations', () => {
    const seedOficial = readFileSync(SEED_OFICIAL_PATH, 'utf8')
    const seedBrand = readFileSync(SEED_BRAND_PATH, 'utf8')
    const assignments = parseAssignments(readMigration())
    const productAssignments = assignments.filter((a) => a.table === 'produtos')
    const titleAssignments = assignments.filter((a) => a.table === 'base_conhecimento')

    for (const retired of [RETIRED_PRODUCT_1, RETIRED_PRODUCT_3, RETIRED_TITLE_1, RETIRED_TITLE_3]) {
      expect(seedBrand).toContain(retired)
    }
    expect(seedOficial).toContain(RETIRED_TITLE_PICKUP)

    expect(productAssignments.map((a) => a.source).sort()).toEqual([RETIRED_PRODUCT_1, RETIRED_PRODUCT_3].sort())
    expect(titleAssignments.map((a) => a.source).sort()).toEqual(
      [RETIRED_TITLE_1, RETIRED_TITLE_3, RETIRED_TITLE_PICKUP].sort(),
    )
  })

  it('writes targets that match the current cards.ts catalog and drop the city from the pickup title', () => {
    const assignments = parseAssignments(readMigration())
    const targets = new Map(assignments.map((a) => [`${a.table}.${a.column}.${a.source}`, a.target]))

    expect(targets.get(`produtos.nome.${RETIRED_PRODUCT_1}`)).toBe(comboNome1)
    expect(targets.get(`produtos.nome.${RETIRED_PRODUCT_3}`)).toBe(comboNome3)
    expect(targets.get(`base_conhecimento.titulo.${RETIRED_TITLE_1}`)).toBe(`${comboNome1}: Ficha Técnica e Detalhes`)
    expect(targets.get(`base_conhecimento.titulo.${RETIRED_TITLE_3}`)).toBe(`${comboNome3}: Ficha Técnica`)
    expect(targets.get(`base_conhecimento.titulo.${RETIRED_TITLE_PICKUP}`)).toBe(TARGET_TITLE_PICKUP)

    const targetLiterals = assignments.map((a) => a.target).join('\n')
    for (const retiredToken of ['Brasa & Sabor', 'Curitiba', 'Umbará']) {
      expect(targetLiterals).not.toContain(retiredToken)
    }
  })

  it('leaves title cleanup ownership with this migration instead of the origin replacement', () => {
    const origin = readFileSync(ORIGIN_MIGRATION_PATH, 'utf8')
    expect(origin).toMatch(/replace\(titulo/i)
    expect(origin).not.toContain('Combo 1 – O Clássico')
    expect(origin).not.toContain('Combo 3 – Dueto')
  })

  it('is idempotent when executed twice against an already-cleared database', () => {
    const assignments = parseAssignments(readMigration())
    const mock = new Map<string, string[]>([
      ['produtos.nome', [comboNome1, comboNome3, 'Frango Recheado Inteiro Assado (Avulso)']],
      ['base_conhecimento.titulo', [`${comboNome1}: Ficha Técnica e Detalhes`, `${comboNome3}: Ficha Técnica`]],
    ])

    expect(applyAssignments(mock, assignments)).toBe(0)

    const mockAfterFirstRun = new Map<string, string[]>([
      ['produtos.nome', [RETIRED_PRODUCT_1, RETIRED_PRODUCT_3, 'Frango Recheado Inteiro Assado (Avulso)']],
      ['base_conhecimento.titulo', [RETIRED_TITLE_1, RETIRED_TITLE_3, RETIRED_TITLE_PICKUP]],
    ])

    expect(applyAssignments(mockAfterFirstRun, assignments)).toBe(5)
    expect(applyAssignments(mockAfterFirstRun, assignments)).toBe(0)
    expect(mockAfterFirstRun.get('produtos.nome')).toEqual([
      comboNome1,
      comboNome3,
      'Frango Recheado Inteiro Assado (Avulso)',
    ])
    expect(mockAfterFirstRun.get('base_conhecimento.titulo')).toEqual([
      `${comboNome1}: Ficha Técnica e Detalhes`,
      `${comboNome3}: Ficha Técnica`,
      TARGET_TITLE_PICKUP,
    ])
  })

  it('preserves operator-edited names and titles that are not byte-identical to the retired seed', () => {
    const assignments = parseAssignments(readMigration())
    const mock = new Map<string, string[]>([
      [
        'produtos.nome',
        [
          `${RETIRED_PRODUCT_1} (receita da casa)`,
          'Combo 1 – O Clássico Premium do Chef',
          'Combo 1 – O Clássico Brasa&Sabor',
        ],
      ],
      [
        'base_conhecimento.titulo',
        [
          `${RETIRED_TITLE_1} — revisado pelo operador`,
          'Dueto Especial do Bairro',
          'Janelas de Retirada (Takeaway) e Delivery Próprio em Curitiba e região',
        ],
      ],
    ])

    const snapshot = JSON.stringify([...mock.entries()])
    expect(applyAssignments(mock, assignments)).toBe(0)
    expect(JSON.stringify([...mock.entries()])).toBe(snapshot)
  })
})
