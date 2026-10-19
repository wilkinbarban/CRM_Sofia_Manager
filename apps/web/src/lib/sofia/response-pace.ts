/**
 * Canonical, deterministic JavaScript definition of Sofia's response pacing minimum.
 *
 * The delivered authority is still SQL: `public.sofia_response_pace_minimum_ms(text)` in
 * `supabase/migrations/20260911030000_sofia_pacing_core_b.sql`, consumed by the worker through
 * the DB-derived `remaining_ms` / `pace_not_before`. This module does not replace that path and
 * performs no I/O; it exists so the pacing arithmetic has one reviewable, executable JS
 * definition, kept honest by the migration-contract parity test in
 * `tests/unit/sofia-response-pace-migration-parity.test.ts`.
 *
 * Delivered arithmetic (note the two recorded divergences from `design.md` Decision 2, both
 * pinned by the delivered SQL and by `supabase/tests/sofia_pacing_core_b.sql`):
 *
 *   1. There is no `- 100` free allowance: 100 units cost 3000 ms in the delivered SQL (pgTAP
 *      `is(..., repeat('a',100), 3000)`, "100 ASCII UTF-16 units add 1000 milliseconds").
 *   2. The remainder never subtracts generation elapsed: the correction migration
 *      `20260913010000_sofia_timing_and_pacing_correction.sql` derives `remaining_ms` from
 *      `greatest(0, public.sofia_response_pace_minimum_ms(p_response_text))` so model latency
 *      cannot shorten the pause. Shipping an elapsed-subtracting remainder here would create a
 *      second, divergent pacing authority, so this module exposes the minimum only.
 *
 * Text semantics: ECMAScript `trim()` white space (WhiteSpace + LineTerminator), then the
 * remaining text is counted in UTF-16 code units, so a supplementary scalar value counts as 2
 * and a combining mark counts as 1. Counting is clamped at the 500-unit scan limit.
 */

/** Base pace floor in milliseconds: the delivered `2000` literal. */
export const SOFIA_PACE_BASE_MS = 2000

/** Milliseconds added per counted UTF-16 unit: the delivered `* 10` literal. */
export const SOFIA_PACE_STEP_MS = 10

/** Hard ceiling in milliseconds: the delivered `least(6000, ...)` literal. */
export const SOFIA_PACE_MAX_MS = 6000

/** Maximum counted UTF-16 units: the delivered `least(v_units, 500)` literal. */
export const SOFIA_PACE_SCAN_LIMIT_UNITS = 500

/**
 * Canonical batch timing constants across active channels (Telegram, WhatsApp, Web).
 * Strictly mirrors the database migration 20261018010000_sofia_silence_window_10s_cap_20s.sql
 * and the scheduler service cadence in ops/sofia-inbound-batch-maintenance-scheduler.sh.
 */
export const SOFIA_BATCH_SILENCE_WINDOW_MS = 10_000
export const SOFIA_BATCH_STARVATION_CAP_MS = 20_000
export const SOFIA_BATCH_MAINTENANCE_CADENCE_SECONDS = 2
export const SOFIA_BATCH_MAINTENANCE_CADENCE_MS = SOFIA_BATCH_MAINTENANCE_CADENCE_SECONDS * 1000

/**
 * ECMAScript WhiteSpace + LineTerminator code points, exactly the list the delivered SQL function
 * trims through its `regexp_replace` character class. Every entry is a BMP code point, so trimming
 * can safely operate on UTF-16 code units.
 */
export const SOFIA_PACE_TRIM_CODE_POINTS: readonly number[] = [
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003,
  0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  0xfeff,
]

function isSofiaPaceTrimCodeUnit(codeUnit: number): boolean {
  return SOFIA_PACE_TRIM_CODE_POINTS.includes(codeUnit)
}

/** Applies the ECMAScript trim white-space list without relying on the host `String#trim`. */
export function trimSofiaResponseText(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && isSofiaPaceTrimCodeUnit(text.charCodeAt(start))) start += 1
  while (end > start && isSofiaPaceTrimCodeUnit(text.charCodeAt(end - 1))) end -= 1
  return text.slice(start, end)
}

/** Counted pacing length: trimmed UTF-16 code units, clamped to the 500-unit scan limit. */
export function countSofiaResponseUtf16Units(text: string): number {
  return Math.min(trimSofiaResponseText(text).length, SOFIA_PACE_SCAN_LIMIT_UNITS)
}

/**
 * Deterministic minimum pause for a final response text.
 *
 * `min(6000, 2000 + min(units, 500) * 10)` — mirror of the delivered SQL function, with no jitter
 * and no clock observation.
 */
export function sofiaResponsePaceMinimumMs(text: string): number {
  const pacedUnits = countSofiaResponseUtf16Units(text)
  return Math.min(SOFIA_PACE_MAX_MS, SOFIA_PACE_BASE_MS + pacedUnits * SOFIA_PACE_STEP_MS)
}
