import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATION_NAME = '20260922010000_clear_legacy_sofia_prompt.sql'
const MIGRATION_PATH = join(process.cwd(), 'supabase/migrations', MIGRATION_NAME)
const MIGRATIONS_DIR = join(process.cwd(), 'supabase/migrations')
const HISTORICAL_SEED_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260828160000_update_brand_and_combos_brasa_sabor.sql',
)
const MIGRATE_SH_PATH = join(process.cwd(), 'ops/supabase/migrate.sh')

function extractHistoricalSeedPrompt(): string {
  const content = readFileSync(HISTORICAL_SEED_MIGRATION, 'utf8')
  const match = content.match(/VALUES\s*\(\s*'SOFIA_SYSTEM_PROMPT'\s*,\s*'([\s\S]*?)'\s*,\s*false\s*\)/i)
  if (!match) throw new Error('Historical seed prompt not found in 20260828160000')
  return match[1]
}

function extractTargetLiterals(sql: string): string[] {
  const matches = [...sql.matchAll(/\$\$([\s\S]*?)\$\$/g)]
  return matches.map((m) => m[1])
}

function runMigrateShValidator(filePath: string) {
  const script = readFileSync(MIGRATE_SH_PATH, 'utf8')
  const awkStart = script.indexOf("LC_ALL=C awk '")
  const awkEnd = script.indexOf("' \"$1\"", awkStart)
  if (awkStart === -1 || awkEnd === -1) throw new Error('Could not extract validate_sql awk script from migrate.sh')
  const awkBody = script.slice(awkStart + "LC_ALL=C awk '".length, awkEnd)
  return spawnSync('awk', [awkBody, filePath], { encoding: 'utf8' })
}

describe('20260922010000_clear_legacy_sofia_prompt migration', () => {
  it('exists with a forward-only timestamp strictly after 20260921010000', () => {
    expect(existsSync(MIGRATION_PATH), `Migration file must exist at ${MIGRATION_PATH}`).toBe(true)

    const allMigrations = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith('.sql'))
      .sort()

    const targetIndex = allMigrations.indexOf(MIGRATION_NAME)
    expect(targetIndex, `${MIGRATION_NAME} must be indexed in migrations`).toBeGreaterThan(-1)

    const previousMigration = '20260921010000_drop_retired_google_event_id.sql'
    const prevIndex = allMigrations.indexOf(previousMigration)
    expect(prevIndex, `${previousMigration} must exist`).toBeGreaterThan(-1)
    expect(targetIndex, 'Target migration must follow 20260921010000').toBeGreaterThan(prevIndex)

    const targetTimestamp = MIGRATION_NAME.split('_')[0]
    expect(targetTimestamp).toBe('20260922010000')
    expect(Number(targetTimestamp)).toBeGreaterThan(20260921010000)

    // Later forward-only migrations must not make this historical ordering test fail.
    expect(allMigrations[targetIndex - 1]).toBe(previousMigration)
  })

  it('obeys ops/supabase/migrate.sh lexical rules without embedded transactions or metacommands', () => {
    const rawSql = readFileSync(MIGRATION_PATH, 'utf8')
    const validation = runMigrateShValidator(MIGRATION_PATH)

    expect(validation.status, `validate_sql failed with stderr: ${validation.stderr}`).toBe(0)
    expect(rawSql).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i)
    expect(rawSql).not.toMatch(/^\\/m)
    expect(rawSql).not.toMatch(/\bE'/i)
    expect(rawSql).not.toMatch(/\bU&'/i)
  })

  it('contains purely DML cleanup and no DDL or function owner transfer statements', () => {
    const rawSql = readFileSync(MIGRATION_PATH, 'utf8')
    expect(rawSql).not.toMatch(/\b(create|alter\s+table|drop\s+table|owner\s+to)\b/i)
  })

  it('uses DELETE with exact equality on SOFIA_SYSTEM_PROMPT and avoids broad LIKE matching', () => {
    const rawSql = readFileSync(MIGRATION_PATH, 'utf8')
    const sqlWithoutComments = rawSql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')

    expect(sqlWithoutComments).toMatch(/delete\s+from\s+public\.configuracoes_sistema/i)
    expect(sqlWithoutComments).toMatch(/chave\s*=\s*'SOFIA_SYSTEM_PROMPT'/i)
    expect(sqlWithoutComments.toLowerCase()).not.toContain('like')
    expect(sqlWithoutComments.toLowerCase()).not.toContain('ilike')
  })

  it('clears exact historical seed prompt from 20260828160000 and 20260920020000 domain variant', () => {
    const rawSql = readFileSync(MIGRATION_PATH, 'utf8')
    const historicalSeed = extractHistoricalSeedPrompt()
    const domainReplacedVariant = historicalSeed.replaceAll('casadeasados.duckdns.org', 'crmsofiamanager.duckdns.org')

    expect(domainReplacedVariant).not.toBe(historicalSeed)
    expect(domainReplacedVariant).toContain('crmsofiamanager.duckdns.org')
    expect(historicalSeed).toContain('casadeasados.duckdns.org')

    const targetLiterals = extractTargetLiterals(rawSql)
    expect(targetLiterals).toHaveLength(2)
    expect(targetLiterals).toContain(historicalSeed)
    expect(targetLiterals).toContain(domainReplacedVariant)
  })

  it('preserves operator-customized prompts even if they contain legacy headers or brand mentions', () => {
    const rawSql = readFileSync(MIGRATION_PATH, 'utf8')
    const historicalSeed = extractHistoricalSeedPrompt()
    const domainReplacedVariant = historicalSeed.replaceAll('casadeasados.duckdns.org', 'crmsofiamanager.duckdns.org')
    const targetLiterals = new Set(extractTargetLiterals(rawSql))

    const shouldDelete = (row: { chave: string; valor: string | null }) => {
      if (row.chave !== 'SOFIA_SYSTEM_PROMPT') return false
      if (!row.valor) return false
      return targetLiterals.has(row.valor)
    }

    // Historical exact literals MUST be deleted
    expect(shouldDelete({ chave: 'SOFIA_SYSTEM_PROMPT', valor: historicalSeed })).toBe(true)
    expect(shouldDelete({ chave: 'SOFIA_SYSTEM_PROMPT', valor: domainReplacedVariant })).toBe(true)

    // Unrelated configuration keys MUST NOT be touched
    expect(shouldDelete({ chave: 'OUTRA_CHAVE', valor: historicalSeed })).toBe(false)
    expect(shouldDelete({ chave: 'EVOLUTION_API_KEY', valor: 'token-xyz' })).toBe(false)

    // Operator customizations MUST be preserved
    expect(
      shouldDelete({
        chave: 'SOFIA_SYSTEM_PROMPT',
        valor: `${historicalSeed}\n\n-- Observação do operador: não atender pedidos após 14h.`,
      }),
    ).toBe(false)

    expect(
      shouldDelete({
        chave: 'SOFIA_SYSTEM_PROMPT',
        valor: '# PROMPT MESTRE — SOFÍA | CASA DE ASSADOS BRASA & SABOR (UMBARÁ, CURITIBA)\n\nTexto customizado.',
      }),
    ).toBe(false)

    expect(
      shouldDelete({
        chave: 'SOFIA_SYSTEM_PROMPT',
        valor: 'Você é a Sofia do restaurante Casa de Assados Brasa & Sabor.',
      }),
    ).toBe(false)

    expect(
      shouldDelete({
        chave: 'SOFIA_SYSTEM_PROMPT',
        valor: 'Instruções personalizadas do operador: você é a Sofia VIP.',
      }),
    ).toBe(false)

    expect(shouldDelete({ chave: 'SOFIA_SYSTEM_PROMPT', valor: '' })).toBe(false)
    expect(shouldDelete({ chave: 'SOFIA_SYSTEM_PROMPT', valor: '   ' })).toBe(false)
    expect(shouldDelete({ chave: 'SOFIA_SYSTEM_PROMPT', valor: null })).toBe(false)
  })

  it('is idempotent when executed against an already-cleared database', () => {
    const rawSql = readFileSync(MIGRATION_PATH, 'utf8')
    const targetLiterals = new Set(extractTargetLiterals(rawSql))

    const mockDb = [
      { chave: 'SOFIA_GLOBAL_WHATSAPP_ENABLED', valor: 'true' },
      { chave: 'EVOLUTION_API_KEY', valor: 'token-xyz' },
    ]

    const remaining = mockDb.filter((row) => !(row.chave === 'SOFIA_SYSTEM_PROMPT' && targetLiterals.has(row.valor)))
    expect(remaining).toHaveLength(mockDb.length)
    expect(remaining).toEqual(mockDb)
  })
})
