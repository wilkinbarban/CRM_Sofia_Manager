import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const dir = join(process.cwd(), 'supabase/migrations')
const migrationName = '20261018010000_sofia_silence_window_10s_cap_20s.sql'
const migrationPath = join(dir, migrationName)
const harnessPath = join(process.cwd(), 'supabase/tests/sofia_silence_window_10s_cap_20s.sql')

describe('Sofia silence window 10s and 20s cap migration', () => {
  it('is sequenced as a forward-only migration after notification_outbox_channel_filter', () => {
    expect(existsSync(migrationPath)).toBe(true)
    const migrations = readdirSync(dir).filter((file) => file.endsWith('.sql')).sort()
    const currentIndex = migrations.indexOf(migrationName)
    expect(currentIndex).toBeGreaterThan(0)
    expect(migrations[currentIndex - 1]).toBe('20261002030000_notification_outbox_channel_filter.sql')
  })

  it('tightens the check constraint on sofia_inbound_batches to 20 seconds starvation cap', () => {
    const sql = readFileSync(migrationPath, 'utf8')
    expect(sql).toMatch(/scheduled_process_at <= first_message_at \+ interval ''?20 seconds''?/i)
    expect(sql).toMatch(/alter table public\.sofia_inbound_batches drop constraint/i)
    expect(sql).toMatch(/alter table public\.sofia_inbound_batches add constraint/i)
    expect(sql).not.toContain("interval '60 seconds'")
  })

  it('updates enqueue_sofia_inbound_message with 10s sliding window and 20s hard cap', () => {
    const sql = readFileSync(migrationPath, 'utf8')
    expect(sql).toContain('create or replace function public.enqueue_sofia_inbound_message(')
    expect(sql).toContain("v_admitted_at + interval '10 seconds'")
    expect(sql).toContain("least(v_admitted_at + interval '10 seconds', b.first_message_at + interval '20 seconds')")
    expect(sql).not.toContain("v_admitted_at + interval '25 seconds'")
    expect(sql).not.toContain("b.first_message_at + interval '60 seconds'")
    expect(sql).toContain('revoke all on function public.enqueue_sofia_inbound_message(uuid,uuid,text,text,text,text,timestamptz) from public, anon, authenticated;')
    expect(sql).toContain('grant execute on function public.enqueue_sofia_inbound_message(uuid,uuid,text,text,text,text,timestamptz) to service_role;')
  })

  it('updates attach_sofia_inbound_message with 10s sliding window and 20s hard cap', () => {
    const sql = readFileSync(migrationPath, 'utf8')
    expect(sql).toContain('create or replace function public.attach_sofia_inbound_message(')
    expect(sql).toContain("v_admitted_at+interval '10 seconds'")
    expect(sql).toContain("least(v_admitted_at+interval '10 seconds',b.first_message_at+interval '20 seconds')")
    expect(sql).toContain('revoke all on function public.attach_sofia_inbound_message(uuid,uuid,uuid,text) from public,anon,authenticated;')
    expect(sql).toContain('grant execute on function public.attach_sofia_inbound_message(uuid,uuid,uuid,text) to service_role;')
  })

  it('preserves web idempotency content conflict safety and conversational closed guards', () => {
    const sql = readFileSync(migrationPath, 'utf8')
    expect(sql).toContain('SOFIA_BATCH_DELIVERY_CONTENT_CONFLICT')
    expect(sql).toContain('SOFIA_BATCH_CONVERSA_FECHADA')
    expect(sql).toContain("p_canal = 'web'")
    expect(sql).toContain('sofia-web:')
  })

  it('provides a hermetic pgTAP verification harness with clean rollback', () => {
    expect(existsSync(harnessPath)).toBe(true)
    const harness = readFileSync(harnessPath, 'utf8')
    expect(harness).toMatch(/select plan\(\d+\);/i)
    expect(harness).toContain("enqueue_sofia_inbound_message sets 10s initial schedule")
    expect(harness).toContain("renewed admission caps schedule at 20s from first message")
    expect(harness).toMatch(/select \* from finish\(\);\s*rollback;\s*$/i)
  })
})
