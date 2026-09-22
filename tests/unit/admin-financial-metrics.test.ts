import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: mocks.createAdminClient }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const startAt = '2026-08-01T00:00:00.000Z'
const endAt = '2026-08-31T00:00:00.000Z'
const operationalReport = {
  period: { start_at: startAt, end_at: endAt },
  orders: { created: 4, novo: 1, confirmado: 1, entregue: 1, cancelado: 1 },
  payments: { approved_events: 4, refunded_events: 2 },
  proof_funnel: { received: 0, admitted: 0, reconciled: 0, review: 0, quarantined: 0, duplicate: 0, purged: 0 },
  proof_sla: { admitted_within_60m: 0, admitted_over_60m: 0, open_0_to_60m: 0, open_61m_to_24h: 0, open_over_24h: 0 },
  channel: { web: 0, whatsapp: 0, telegram: 0 },
  operational_value_cents: { gross_approved: 24000, refunds: 4000, net: 20000 },
}
const financialReport = {
  period: { start_at: startAt, end_at: endAt },
  receivables: { opened_count: 3, opened_centavos: 12000, settled_count: 2, settled_centavos: 9000, open_count: 1, open_centavos: 3000 },
  cash: { sessions_opened: 2, sessions_closed: 1, opening_float_centavos: 1000, closing_difference_centavos: -50 },
  provider_settlements: { count: 2, gross_centavos: 11000, fees_centavos: 500, net_centavos: 10500, bank_reconciled_count: 1, bank_reconciled_centavos: 6000, bank_unreconciled_count: 1, bank_unreconciled_centavos: 4500 },
  refunds: { events: 1, centavos: 2000 },
  sales: { approved_order_count: 2, gross_approved_centavos: 12000, refunded_order_count: 1, refunds_centavos: 2000, net_operational_centavos: 10000 },
  scope: { operational_only: true, fiscal_accounting: false, double_entry: false, partial_or_combined_payments: false },
}

function operatorClient(role = 'admin') {
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'operator' } }, error: null }) },
    from: vi.fn(() => ({ select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: { funcao: role, ativo: true }, error: null }) })),
  }
}

describe('financial operational metrics', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fails closed when a report includes an unexpected field', async () => {
    const { parseFinancialOperationalMetrics } = await import('@/lib/admin/financial-metrics')
    expect(() => parseFinancialOperationalMetrics({ ...operationalReport, leaked_id: 'nope' }, financialReport, startAt, endAt)).toThrow('INVALID_FINANCIAL_METRICS')
  })

  it('fails closed when an unused RPC metric is corrupt', async () => {
    const { parseFinancialOperationalMetrics } = await import('@/lib/admin/financial-metrics')
    expect(() => parseFinancialOperationalMetrics({ ...operationalReport, proof_funnel: { ...operationalReport.proof_funnel, received: -1 } }, financialReport, startAt, endAt)).toThrow('INVALID_FINANCIAL_METRICS')
  })

  it('authorizes supervisors, calls both service RPCs, and returns normalized aggregates only', async () => {
    mocks.createClient.mockResolvedValue(operatorClient('supervisor'))
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: operationalReport, error: null })
      .mockResolvedValueOnce({ data: financialReport, error: null })
    mocks.createAdminClient.mockReturnValue({ rpc })
    const { obterMetricasFinanceirasOperacionais } = await import('@/app/actions/admin')

    await expect(obterMetricasFinanceirasOperacionais({ startAt, endAt })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        ordersCreated: 4,
        approvedSalesCount: 2,
        grossApprovedCents: 12000,
        refundsCents: 2000,
        netOperationalRevenueCents: 10000,
        averageApprovedTicketCents: 6000,
        providerFeesCents: 500,
        marginAvailable: false,
      }),
    }))
    expect(rpc).toHaveBeenCalledWith('get_operational_reporting', { p_start: startAt, p_end: endAt })
    expect(rpc).toHaveBeenCalledWith('get_financial_operational_reporting', { p_start: startAt, p_end: endAt })
  })

  it('fails closed when sales refunds disagree with canonical financial refunds', async () => {
    const { parseFinancialOperationalMetrics } = await import('@/lib/admin/financial-metrics')
    expect(() => parseFinancialOperationalMetrics(operationalReport, { ...financialReport, sales: { ...financialReport.sales, refunds_centavos: 1999 } }, startAt, endAt)).toThrow('INVALID_FINANCIAL_METRICS')
  })

  it('denies unauthorized operators before creating an admin client or calling reporting RPCs', async () => {
    mocks.createClient.mockResolvedValue(operatorClient('cliente'))
    const { obterMetricasFinanceirasOperacionais } = await import('@/app/actions/admin')

    await expect(obterMetricasFinanceirasOperacionais({ startAt, endAt })).resolves.toEqual({ success: false, error: 'ACESSO_NEGADO_PERMISSAO_INSUFICIENTE' })
    expect(mocks.createAdminClient).not.toHaveBeenCalled()
  })

  it('rejects an oversized client period before calling reporting RPCs', async () => {
    mocks.createClient.mockResolvedValue(operatorClient())
    const rpc = vi.fn()
    mocks.createAdminClient.mockReturnValue({ rpc })
    const { obterMetricasFinanceirasOperacionais } = await import('@/app/actions/admin')

    await expect(obterMetricasFinanceirasOperacionais({ startAt, endAt: '2027-08-03T00:00:00.000Z' })).resolves.toEqual({ success: false, error: 'PERIODO_INVALIDO' })
    expect(rpc).not.toHaveBeenCalled()
  })
})
