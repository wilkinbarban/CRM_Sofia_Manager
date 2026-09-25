import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const previous = readFileSync(join(process.cwd(), 'supabase/migrations/20260824160000_jd3_security_authorities.sql'), 'utf8')
const migration = readFileSync(join(process.cwd(), 'supabase/migrations/20260925010000_receipt_business_name_fallback.sql'), 'utf8')
const harness = readFileSync(join(process.cwd(), 'supabase/tests/sales_receipt_issuance.sql'), 'utf8')

const functionBody = (sql: string) => sql.match(/create or replace function public\.emitir_comprovante_venda\([\s\S]*?end \$\$;/i)?.[0]

describe('receipt business name fallback migration', () => {
  it('replaces only the establishment name source in the latest protected issuance authority', () => {
    const original = functionBody(previous)
    const replacement = functionBody(migration)
    expect(original).toBeDefined()
    expect(replacement).toBeDefined()
    const oldName = "coalesce(nullif(current_setting('app.establishment_name',true),''),'Asados')"
    const newName = "coalesce((select nullif(btrim(valor),'') from public.configuracoes_sistema where chave='BUSINESS_NAME'),'CRM Sofia Manager')"
    expect(original).toContain(oldName)
    expect(replacement).toBe(original?.replace(oldName, newName))
    expect(migration).toContain('revoke all on function public.emitir_comprovante_venda(uuid,uuid) from public,anon;')
    expect(migration).toContain('grant execute on function public.emitir_comprovante_venda(uuid,uuid) to authenticated;')
  })

  it('leaves fixture cleanup to rollback after pgTAP finish, without deleting referenced parents', () => {
    expect(harness).toMatch(/select \* from finish\(\);\s*rollback;\s*$/i)
    const afterAssertions = harness.split("select pass('receipt runtime proves")[1]
    expect(afterAssertions).toBeDefined()
    expect(afterAssertions).not.toMatch(/delete\s+from\s+public\.(?:clientes|pedidos|comprovantes_venda)\b/i)
    expect(afterAssertions).not.toMatch(/alter\s+table\s+public\.comprovantes_venda\s+disable\s+trigger/i)
  })

  it('exercises configured, blank, absent and immutable reissue names in the database harness', () => {
    expect(harness).toContain('configured business name was not captured')
    expect(harness).toContain('blank business name did not fall back')
    expect(harness).toContain('absent business name did not fall back')
    expect(harness).toContain('receipt reissue changed persisted snapshot bytes')
  })
})
