import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SOFIA_PACE_BASE_MS,
  SOFIA_PACE_MAX_MS,
  SOFIA_PACE_SCAN_LIMIT_UNITS,
  SOFIA_PACE_STEP_MS,
  SOFIA_PACE_TRIM_CODE_POINTS,
  SOFIA_BATCH_SILENCE_WINDOW_MS,
  SOFIA_BATCH_STARVATION_CAP_MS,
  SOFIA_BATCH_MAINTENANCE_CADENCE_SECONDS,
  SOFIA_BATCH_MAINTENANCE_CADENCE_MS,
  sofiaResponsePaceMinimumMs,
} from '@/lib/sofia/response-pace'

/**
 * Migration-contract parity: `apps/web/src/lib/sofia/response-pace.ts` must stay arithmetic- and
 * whitespace-identical to the delivered SQL authority
 * `public.sofia_response_pace_minimum_ms(text)`. This is the reason the helper is not decorative:
 * changing either side without the other breaks this file.
 */

const CORE_B_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260911030000_sofia_pacing_core_b.sql'
)
const CORRECTION_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260913010000_sofia_timing_and_pacing_correction.sql'
)
const BATCH_TIMING_10S_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20261018010000_sofia_silence_window_10s_cap_20s.sql'
)
const PACING_PGTAP = join(process.cwd(), 'supabase/tests/sofia_pacing_core_b.sql')
const SCHEDULER_SCRIPT = join(process.cwd(), 'ops/sofia-inbound-batch-maintenance-scheduler.sh')

const readUtf8 = (path: string) => readFileSync(path, 'utf8')

/** The exact SQL expression the delivered function returns, rebuilt from the TypeScript constants. */
function expectedSqlArithmetic(): string {
  return `least(${SOFIA_PACE_MAX_MS}, ${SOFIA_PACE_BASE_MS} + least(v_units, ${SOFIA_PACE_SCAN_LIMIT_UNITS}) * ${SOFIA_PACE_STEP_MS})`
}

/** Expands a SQL bracket character class such as `\0009\2000-\200A` into its code points. */
function expandTrimClass(classText: string): number[] {
  const tokens = classText.match(/\\[0-9A-F]{4}(?:-\\[0-9A-F]{4})?/g) ?? []
  const codePoints: number[] = []
  for (const token of tokens) {
    const [start, end] = token
      .split('-')
      .map((part) => Number.parseInt(part.slice(1), 16))
    for (let codePoint = start; codePoint <= (end ?? start); codePoint += 1) {
      codePoints.push(codePoint)
    }
  }
  return codePoints
}

/** The two bracket classes the SQL trim regex is built from: leading run and trailing run. */
function sqlTrimClasses(sql: string): string[] {
  return [...sql.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1])
}

/** Empty list means the SQL contract still matches the TypeScript definition. */
function findPaceContractDrift(sql: string): string[] {
  const drift: string[] = []

  const arithmetic = expectedSqlArithmetic()
  if (!sql.includes(arithmetic)) {
    drift.push(`pace arithmetic drift: SQL does not contain \`${arithmetic}\``)
  }

  const classes = sqlTrimClasses(sql)
  if (classes.length !== 2) {
    drift.push(`trim class drift: expected 2 bracket classes, found ${classes.length}`)
    return drift
  }
  if (classes[0] !== classes[1]) {
    drift.push('trim class drift: leading and trailing classes differ')
  }

  const sqlCodePoints = [...new Set(expandTrimClass(classes[0]))].sort((a, b) => a - b)
  const tsCodePoints = [...SOFIA_PACE_TRIM_CODE_POINTS].sort((a, b) => a - b)
  if (JSON.stringify(sqlCodePoints) !== JSON.stringify(tsCodePoints)) {
    drift.push(
      `trim class drift: SQL ${sqlCodePoints.length} code points vs TypeScript ${tsCodePoints.length}`
    )
  }

  return drift
}

describe('sofia response pace — migration contract parity (drift guard)', () => {
  it('detects a drifting SQL contract instead of passing vacuously', () => {
    const pristine = readUtf8(CORE_B_MIGRATION)
    expect(findPaceContractDrift(pristine)).toEqual([])

    const mutatedArithmetic = pristine.replace('least(v_units, 500)', 'least(v_units, 501)')
    expect(mutatedArithmetic).not.toBe(pristine)
    expect(findPaceContractDrift(mutatedArithmetic)).toContain(
      `pace arithmetic drift: SQL does not contain \`${expectedSqlArithmetic()}\``
    )

    const mutatedClass = pristine.replace(
      `U&'^[${sqlTrimClasses(pristine)[0]}]+|`,
      `U&'^[${sqlTrimClasses(pristine)[0].replace('\\00A0', '\\00A1')}]+|`
    )
    expect(mutatedClass).not.toBe(pristine)
    expect(findPaceContractDrift(mutatedClass).length).toBeGreaterThan(0)
  })

  it('matches the delivered public.sofia_response_pace_minimum_ms definition exactly', () => {
    expect(findPaceContractDrift(readUtf8(CORE_B_MIGRATION))).toEqual([])
  })

  it('honours the trim white-space list the SQL class enumerates', () => {
    const classes = sqlTrimClasses(readUtf8(CORE_B_MIGRATION))
    expect(expandTrimClass(classes[0])).toHaveLength(25)
    expect([...new Set(expandTrimClass(classes[0]))].sort((a, b) => a - b)).toEqual(
      [...SOFIA_PACE_TRIM_CODE_POINTS].sort((a, b) => a - b)
    )
  })

  it('reproduces every pace value pinned by the delivered pgTAP suite', () => {
    const pgtap = readUtf8(PACING_PGTAP)
    const pinned: ReadonlyArray<readonly [number, string]> = [
      [3000, "repeat('a',100)),3000"],
      [6000, "repeat('a',500)),6000"],
      [2020, "E'\\U0001F600'),2020"],
      [3000, "E'\\u00a0' || repeat('a',100) || E'\\uFEFF'),3000"],
    ]

    for (const [, pgtapLine] of pinned) {
      expect(pgtap).toContain(pgtapLine)
    }

    expect(pinned.map(([expected]) => expected)).toEqual([3000, 6000, 2020, 3000])
    expect(sofiaResponsePaceMinimumMs('a'.repeat(100))).toBe(3000)
    expect(sofiaResponsePaceMinimumMs('a'.repeat(500))).toBe(6000)
    expect(sofiaResponsePaceMinimumMs('\u{1F600}')).toBe(2020)
    expect(sofiaResponsePaceMinimumMs(`\u00a0${'a'.repeat(100)}\uFEFF`)).toBe(3000)
  })

  it('records that the correction migration dropped the generation-elapsed subtraction', () => {
    const correction = readUtf8(CORRECTION_MIGRATION)
    expect(correction).toContain(
      'greatest(0, public.sofia_response_pace_minimum_ms(p_response_text));'
    )
    expect(correction).not.toContain(
      'public.sofia_response_pace_minimum_ms(p_response_text) - p_generation_elapsed_ms'
    )
    // The superseded Core B arithmetic, kept as the historical baseline this helper must not follow.
    expect(readUtf8(CORE_B_MIGRATION)).toContain(
      'greatest(0, public.sofia_response_pace_minimum_ms(p_response_text) - p_generation_elapsed_ms)'
    )
  })

  it('does not add a second pacing floor outside the SQL contract', () => {
    expect(sofiaResponsePaceMinimumMs('')).toBe(SOFIA_PACE_BASE_MS)
    expect(sofiaResponsePaceMinimumMs('a'.repeat(SOFIA_PACE_SCAN_LIMIT_UNITS + 1))).toBe(
      Math.min(
        SOFIA_PACE_MAX_MS,
        SOFIA_PACE_BASE_MS + (SOFIA_PACE_SCAN_LIMIT_UNITS + 1) * SOFIA_PACE_STEP_MS
      )
    )
  })

  it('maintains strict parity between JS batch timing constants, SQL migration, and scheduler', () => {
    expect(SOFIA_BATCH_SILENCE_WINDOW_MS).toBe(10_000)
    expect(SOFIA_BATCH_STARVATION_CAP_MS).toBe(20_000)
    expect(SOFIA_BATCH_MAINTENANCE_CADENCE_SECONDS).toBe(2)
    expect(SOFIA_BATCH_MAINTENANCE_CADENCE_MS).toBe(2_000)

    const migrationSql = readUtf8(BATCH_TIMING_10S_MIGRATION)
    expect(migrationSql).toContain(`interval '${SOFIA_BATCH_SILENCE_WINDOW_MS / 1000} seconds'`)
    expect(migrationSql).toContain(`interval '${SOFIA_BATCH_STARVATION_CAP_MS / 1000} seconds'`)

    const schedulerText = readUtf8(SCHEDULER_SCRIPT)
    expect(schedulerText).toContain(
      `: "\${SOFIA_BATCH_MAINTENANCE_INTERVAL_SECONDS:=${SOFIA_BATCH_MAINTENANCE_CADENCE_SECONDS}}"`
    )
  })
})
