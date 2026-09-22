import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260921010000_drop_retired_google_event_id.sql'),
  'utf8',
)
const currentAuthority = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260824163000_mercado_pago_refund_first_terminality.sql'),
  'utf8',
)
const harness = readFileSync(join(process.cwd(), 'supabase/tests/order_stock_lifecycle.sql'), 'utf8')

const sevenArgumentSignature = 'uuid,public.status_pagamento,text,text,text,uuid,text'

function authorityBody(source: string) {
  const start = source.indexOf('create or replace function public.registrar_status_pagamento(')
  const end = source.indexOf('end $$;', start)
  return source.slice(start, end + 'end $$;'.length)
}

function withoutRetiredField(body: string) {
  return body.replace(',google_event_id text)', ')').replace(/,\s*v_order\.google_event_id::text/g, '')
}

describe('retired google_event_id migration', () => {
  it('drops both historical authority signatures before recreating the seven argument one', () => {
    const sixArgumentDrop = migration.search(
      /drop function if exists public\.registrar_status_pagamento\(\s*uuid, public\.status_pagamento, text, text, text, uuid\s*\);/,
    )
    const sevenArgumentDrop = migration.search(
      /drop function if exists public\.registrar_status_pagamento\(\s*uuid, public\.status_pagamento, text, text, text, uuid, text\s*\);/,
    )
    const create = migration.search(/create or replace function public\.registrar_status_pagamento\(/)

    expect(sixArgumentDrop).toBeGreaterThan(-1)
    expect(sevenArgumentDrop).toBeGreaterThan(sixArgumentDrop)
    expect(create).toBeGreaterThan(sevenArgumentDrop)
  })

  it('recreates the authority without the retired field in its return shape or in any read of the order row', () => {
    expect(migration).toContain(
      ') returns table(pedido_id uuid,status_pagamento public.status_pagamento,idempotent boolean)',
    )
    expect(migration).not.toMatch(/returns table\([^)]*google_event_id/)
    expect(migration).not.toMatch(/return query select[^;]*google_event_id/)
    expect(migration).not.toMatch(/v_order\.google_event_id/)
    expect(authorityBody(migration)).not.toContain('google_event_id')
  })

  it('restores both grants on the seven argument signature', () => {
    expect(migration).toContain(`revoke all on function public.registrar_status_pagamento(
  ${sevenArgumentSignature}
) from public, anon;`)
    expect(migration).toContain(`grant execute on function public.registrar_status_pagamento(
  ${sevenArgumentSignature}
) to authenticated, service_role;`)

    const revoke = migration.search(/revoke all on function public\.registrar_status_pagamento\(/)
    const grant = migration.search(/grant execute on function public\.registrar_status_pagamento\(/)
    const dropColumn = migration.search(/drop column if exists google_event_id/)

    expect(revoke).toBeGreaterThan(-1)
    expect(grant).toBeGreaterThan(revoke)
    expect(dropColumn).toBeGreaterThan(grant)
  })

  it('drops the retired column last, after the authority body stopped referencing it', () => {
    const bodyEnd = migration.search(/end \$\$;/)
    const dropColumn = migration.search(/drop column if exists google_event_id/)

    expect(migration).toContain('alter table public.pedidos drop column if exists google_event_id;')
    expect(dropColumn).toBeGreaterThan(bodyEnd)
    expect(migration.match(/drop column if exists [a-z_]+/g)).toEqual(['drop column if exists google_event_id'])
    expect(migration.lastIndexOf('google_event_id')).toBe(migration.length - 'google_event_id;\n'.length)
  })

  it('keeps the recreated body identical to the current definition except for the retired field', () => {
    expect(currentAuthority).toContain(',google_event_id text)')
    expect(authorityBody(currentAuthority)).not.toBe(authorityBody(migration))
    expect(authorityBody(migration)).toBe(withoutRetiredField(authorityBody(currentAuthority)))
    expect(authorityBody(currentAuthority).match(/return query select/g)).toHaveLength(7)
    expect(authorityBody(migration).match(/return query select/g)).toHaveLength(7)
  })

  it('keeps the refund-first terminality and idempotency contract of the current definition', () => {
    for (const marker of [
      'provider_terminal_without_local_approval',
      'provider_approval_observed_after_reversal',
      'provider_reversal_duplicate_observation',
      'MERCADO_PAGO_DELIVERY_CONFLICT',
    ]) {
      expect(currentAuthority).toContain(marker)
      expect(migration).toContain(marker)
    }
    expect(migration).not.toContain('MERCADO_PAGO_REFUND_BEFORE_APPROVAL')
    expect(currentAuthority).not.toContain('MERCADO_PAGO_REFUND_BEFORE_APPROVAL')
  })

  it('moves the stock lifecycle boundary sentinel onto a column that survives the migration', () => {
    expect(harness).toContain("set mercado_pago_preferencia_id='order-stock-boundary-event'")
    expect(harness).toContain('select mercado_pago_preferencia_id from public.pedidos')
    expect(harness).toContain('unrelated order update missing')
    expect(harness).not.toContain('google_event_id')
  })
})
