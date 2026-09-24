import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATION_NAME = '20260922030000_clear_legacy_knowledge_content.sql'
const MIGRATIONS_DIR = join(process.cwd(), 'supabase/migrations')
const MIGRATION_PATH = join(MIGRATIONS_DIR, MIGRATION_NAME)
const PREVIOUS_MIGRATION = '20260922020000_clear_legacy_seed_names.sql'
const MIGRATE_SH_PATH = join(process.cwd(), 'ops/supabase/migrate.sh')
const SEED_OFICIAL_PATH = join(MIGRATIONS_DIR, '20260816260000_seed_combos_e_base_conhecimento_oficial.sql')
const SEED_BRAND_PATH = join(MIGRATIONS_DIR, '20260828160000_update_brand_and_combos_brasa_sabor.sql')
const ORIGIN_MIGRATION_PATH = join(MIGRATIONS_DIR, '20260920020000_replace_retired_origin_in_knowledge.sql')

const RETIRED_BRAND = 'Brasa & Sabor'
const RETIRED_RETIRED_BRAND = 'Casa de Assados Sofia'
const RETIRED_CITY = 'Curitiba'
const NAMED_NEIGHBOURHOODS = ['Umbará', 'Ganchinho', 'Sítio Cercado', 'Pinheirinho'] as const
const DEMO_CLAIM = /dados de teste|ambiente de demonstra|fictício|ficticio|nenhum negócio real/i

interface ConteudoAssignment {
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

function parseConteudoAssignments(sql: string): ConteudoAssignment[] {
  const body = stripComments(sql)
  const pattern =
    /update\s+public\.base_conhecimento\s+set\s+conteudo\s*=\s*'([^']*)'\s+where\s+conteudo\s*=\s*'([^']*)'/gi
  return [...body.matchAll(pattern)].map((match) => ({
    target: match[1],
    source: match[2],
  }))
}

function extractBrandContents(): string[] {
  const brand = readFileSync(SEED_BRAND_PATH, 'utf8')
  return [...brand.matchAll(/conteudo = '([^']*)'/g)].map((match) => match[1])
}

function extractCombo4Content(): string {
  const seed = readFileSync(SEED_OFICIAL_PATH, 'utf8')
  const match = seed.match(/'Combo 4 – Kit Churrasco Família: O Grande Banquete',\s*'([^']*)'/)
  if (!match) throw new Error('Combo 4 conteudo not found in 20260816260000')
  return match[1]
}

function runMigrateShValidator(filePath: string) {
  const script = readFileSync(MIGRATE_SH_PATH, 'utf8')
  const awkStart = script.indexOf("LC_ALL=C awk '")
  const awkEnd = script.indexOf("' \"$1\"", awkStart)
  if (awkStart === -1 || awkEnd === -1) throw new Error('Could not extract validate_sql awk script from migrate.sh')
  const awkBody = script.slice(awkStart + "LC_ALL=C awk '".length, awkEnd)
  return spawnSync('awk', [awkBody, filePath], { encoding: 'utf8' })
}

function applyAssignments(values: string[], assignments: ConteudoAssignment[]): number {
  let changed = 0
  for (const assignment of assignments) {
    for (let index = 0; index < values.length; index += 1) {
      if (values[index] === assignment.source) {
        values[index] = assignment.target
        changed += 1
      }
    }
  }
  return changed
}

const brandContents = extractBrandContents()
const combo4Content = extractCombo4Content()
const combo1Source = brandContents[0]
const combo3Source = brandContents[1]
const pickupSource = brandContents[2]
const seededContents = [combo1Source, combo3Source, combo4Content, pickupSource]

describe('20260922030000_clear_legacy_knowledge_content migration', () => {
  it('exists with a forward-only timestamp strictly after 20260922020000', () => {
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
    expect(targetTimestamp).toBe('20260922030000')
    expect(Number(targetTimestamp)).toBeGreaterThan(20260922020000)
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

  it('scopes exactly four assignments to base_conhecimento.conteudo', () => {
    const assignments = parseConteudoAssignments(readMigration())

    expect(assignments).toHaveLength(4)
    for (const assignment of assignments) {
      expect(assignment.source).not.toBe(assignment.target)
      expect(assignment.source.length).toBeGreaterThan(0)
    }

    const statements = stripComments(readMigration())
    expect(statements).not.toMatch(/public\.(?!base_conhecimento)/i)
    expect(statements).not.toMatch(/set\s+(titulo|tags|ativo)/i)
    expect(statements).not.toMatch(/produtos|configuracoes_sistema/i)
  })

  it('matches with exact full equality and never with broad or partial matching', () => {
    const body = stripComments(readMigration())

    expect(body).toMatch(/where\s+conteudo\s*=\s*'/i)
    expect(body).not.toMatch(/\blike\b/i)
    expect(body).not.toMatch(/\bilike\b/i)
    expect(body).not.toMatch(/replace\s*\(/i)
    expect(body).not.toMatch(/%/)
  })

  it('retires the exact seeded conteudo literals recorded by the seed migrations', () => {
    const assignments = parseConteudoAssignments(readMigration())
    const sources = assignments.map((assignment) => assignment.source)

    expect(new Set(sources)).toEqual(new Set(seededContents))
    expect(sources).toHaveLength(4)
  })

  it('takes Combo 4 from 20260816260000 and the brand rows from 20260828160000', () => {
    const assignments = parseConteudoAssignments(readMigration())
    const sources = assignments.map((assignment) => assignment.source)

    const seedOficial = readFileSync(SEED_OFICIAL_PATH, 'utf8')
    const seedBrand = readFileSync(SEED_BRAND_PATH, 'utf8')

    expect(seedOficial).toContain(combo4Content)
    expect(seedBrand).toContain(combo1Source)
    expect(seedBrand).toContain(combo3Source)
    expect(seedBrand).toContain(pickupSource)

    expect(sources).toContain(combo4Content)
    expect(sources).not.toContain(combo4Content + ' ')
  })

  it('has no later domain variant because 20260920020000 never touches these conteudo rows', () => {
    const origin = readFileSync(ORIGIN_MIGRATION_PATH, 'utf8')
    expect(origin).toMatch(/replace\(conteudo/i)

    for (const content of seededContents) {
      expect(content).not.toContain('casadeasados')
      expect(content).not.toMatch(/duckdns/i)
    }
  })

  it('removes the retired brand and city without touching legitimate product facts', () => {
    const assignments = parseConteudoAssignments(readMigration())
    const targets = assignments.map((assignment) => assignment.target).join('\n')

    for (const retired of [RETIRED_BRAND, RETIRED_RETIRED_BRAND, RETIRED_CITY, 'Sofia']) {
      expect(targets).not.toContain(retired)
    }
    expect(targets).not.toMatch(DEMO_CLAIM)

    expect(targets).toContain('R$ 69,90')
    expect(targets).toContain('R$ 94,90')
    expect(targets).toContain('R$ 169,90')
    expect(targets).toContain('3 a 4 pessoas')
    expect(targets).toContain('Frango recheado inteiro')
    expect(targets).toContain('costelinha suína')
    expect(targets).toContain('marinado por 12 horas')
    expect(targets).toContain('65°C')
    expect(targets).toContain('5 km')
    expect(targets).toContain('no balcão de retirada')
    expect(targets).toContain('em um raio de até 5 km,')
    expect(targets).toContain('WhatsApp')
    expect(targets).toContain('menos de 90 segundos')
    for (const window of ['11h30', '11h45', '12h00', '13h00', '13h30']) {
      expect(targets).toContain(window)
    }

    // Named neighbourhoods describe arbitrary locations that a configurable
    // BusinessProfile no longer owns, so they must leave the target while the
    // general pickup point and the 5 km radius stay.
    for (const neighbourhood of NAMED_NEIGHBOURHOODS) {
      expect(targets).not.toContain(neighbourhood)
    }
  })

  it('keeps the exact seeded neighbourhood text only as the migration source', () => {
    const assignments = parseConteudoAssignments(readMigration())
    const pickup = assignments.find((assignment) => assignment.source === pickupSource)

    expect(pickup, 'pickup assignment must exist').toBeDefined()
    expect(pickup?.source).toBe(pickupSource)
    expect(pickup?.source).toContain('no balcão no Umbará')
    expect(pickup?.source).toContain('5 km no Umbará, Ganchinho, Sítio Cercado e Pinheirinho')
    for (const neighbourhood of NAMED_NEIGHBOURHOODS) {
      expect(pickup?.target).not.toContain(neighbourhood)
    }
  })

  it('uses removal-style targets consistent with the retired brand and city tokens', () => {
    const assignments = parseConteudoAssignments(readMigration())
    const bySource = new Map(assignments.map((assignment) => [assignment.source, assignment.target]))

    expect(bySource.get(combo1Source)).toBe(combo1Source.replace('(O Clássico Brasa & Sabor)', '(O Clássico da Casa)'))
    expect(bySource.get(combo3Source)).toBe(combo3Source.replace('(Dueto Brasa & Sabor)', '(Dueto Especial)'))
    expect(bySource.get(combo4Content)).toBe(combo4Content.replace(` de ${RETIRED_CITY}.`, '.'))
    const pickupTarget = pickupSource
      .replace('A Casa de Assados Brasa & Sabor opera', 'A casa opera')
      .replace('no balcão no Umbará', 'no balcão de retirada')
      .replace('em um raio de até 5 km no Umbará, Ganchinho, Sítio Cercado e Pinheirinho', 'em um raio de até 5 km')
    expect(bySource.get(pickupSource)).toBe(pickupTarget)
  })

  it('is idempotent when executed twice against an already-cleared database', () => {
    const assignments = parseConteudoAssignments(readMigration())
    const cleared = seededContents.slice()

    expect(applyAssignments(cleared, assignments)).toBe(4)
    expect(applyAssignments(cleared, assignments)).toBe(0)
    expect(cleared).toEqual(assignments.map((assignment) => assignment.target))
  })

  it('preserves operator-edited conteudo that is not byte-identical to the retired seed', () => {
    const assignments = parseConteudoAssignments(readMigration())
    const operatorRows = [
      `${combo1Source} Atualização do operador: promover às sextas.`,
      'Texto totalmente reescrito pelo operador.',
      combo3Source.replace('94,90', '99,90'),
      'O Combo 4 custa R$ 169,90 e serve 5 a 6 pessoas.',
    ]

    const snapshot = operatorRows.slice()
    expect(applyAssignments(operatorRows, assignments)).toBe(0)
    expect(operatorRows).toEqual(snapshot)
  })
})
