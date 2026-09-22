import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

type LocalEnvironment = Record<string, string>

function loadLocalEnvironment(): LocalEnvironment {
  return Object.fromEntries(
    readFileSync(join(process.cwd(), 'ops/supabase/.env'), 'utf8')
      .split(/\r?\n/)
      .flatMap((line) => {
        const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
        return match ? [[match[1], match[2]]] : []
      }),
  )
}

describe('Mercado Pago approved background runtime', () => {
  it.skipIf(process.env.RUN_LOCAL_MP_RUNTIME !== '1')('commits the audited payment approval and leaves the order lifecycle unchanged', async () => {
    const environment = loadLocalEnvironment()
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:8000'
    process.env.SUPABASE_SERVICE_ROLE_KEY = environment.SERVICE_ROLE_KEY

    const { processarPagamentoBackground } = await import('@/app/api/webhooks/mercadopago/route')
    const { createAdminClient } = await import('@/lib/supabase/admin')
    const pedidoId = '33333333-3333-4333-8333-333333333311'

    await processarPagamentoBackground('mp-runtime-approved-333', null, {
      resolvePayment: async () => ({ status: 'approved', pedidoId }),
    })

    const admin = createAdminClient()
    const { data: order, error: orderError } = await admin
      .from('pedidos')
      .select('status,status_pagamento')
      .eq('id', pedidoId)
      .single()
    expect(orderError).toBeNull()
    expect(order).toEqual({ status: 'confirmado', status_pagamento: 'aprovado' })

    const { data: audit, error: auditError } = await admin
      .from('pedido_payment_events')
      .select('source,external_reference,target_status')
      .eq('pedido_id', pedidoId)
      .single()
    expect(auditError).toBeNull()
    expect(audit).toEqual({
      source: 'mercado_pago',
      external_reference: 'mp-runtime-approved-333',
      target_status: 'aprovado',
    })

    await admin.from('pedido_payment_events').delete().eq('pedido_id', pedidoId)
    await admin.from('pedidos').delete().eq('id', pedidoId)
    await admin.from('clientes').delete().eq('id', '33333333-3333-4333-8333-333333333310')
  }, 15_000)
})
