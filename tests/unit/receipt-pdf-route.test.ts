import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  profileSingle: vi.fn(),
  receiptSingle: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ single: mocks.receiptSingle }),
          single: table === 'perfis' ? mocks.profileSingle : mocks.receiptSingle,
        }),
      }),
    }),
  }),
}))

import { GET } from '@/app/api/receipts/[id]/pdf/route'

const snapshot = {
  order: { id: 'receipt-order' }, customer: { name: 'Ada' }, line_items: [],
  charged_amount_centavos: 1234, payment: { status: 'aprovado', method: 'pix' },
  establishment: { name: 'Loja de Teste' }, issuance: { issued_at: '2026-08-20T00:00:00.000Z', snapshot_version: 1 },
}

beforeEach(() => {
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'operator-1' } } })
  mocks.profileSingle.mockResolvedValue({ data: { funcao: 'vendedor', ativo: true } })
  mocks.receiptSingle.mockResolvedValue({ data: { snapshot }, error: null })
})

describe('authenticated receipt PDF route', () => {
  it('returns a private two-copy PDF generated only from the persisted snapshot', async () => {
    const response = await GET(new Request('http://localhost/api/receipts/receipt-1/pdf'), { params: Promise.resolve({ id: 'receipt-1' }) })

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/pdf')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    const pdf = new TextDecoder().decode(await response.arrayBuffer())
    expect(pdf).toContain('VIA CLIENTE')
    expect(pdf).toContain('VIA ESTABELECIMENTO')
    expect(pdf).toMatch(/Valor pago: R\$\s*12,34/)
  })

  it('rejects unauthenticated requests before querying a receipt', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } })
    const response = await GET(new Request('http://localhost/api/receipts/receipt-1/pdf'), { params: Promise.resolve({ id: 'receipt-1' }) })
    expect(response.status).toBe(401)
  })
})
