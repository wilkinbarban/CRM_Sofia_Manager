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
          single: table === 'perfis' ? mocks.profileSingle : mocks.receiptSingle,
        }),
      }),
    }),
  }),
}))

import { GET } from '@/app/api/receipts/[id]/svg/route'

const snapshot = {
  order: { id: 'receipt-order' },
  customer: { name: '</text><script>alert(1)</script>' },
  line_items: [],
  charged_amount_centavos: 1234,
  payment: { status: 'aprovado', method: 'pix' },
  establishment: { name: 'Loja de Teste' },
  issuance: { issued_at: '2026-08-20T00:00:00.000Z', snapshot_version: 1 },
}

beforeEach(() => {
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'operator-1' } } })
  mocks.profileSingle.mockResolvedValue({ data: { funcao: 'vendedor', ativo: true } })
  mocks.receiptSingle.mockResolvedValue({ data: { snapshot }, error: null })
})

describe('authenticated receipt SVG route', () => {
  it('returns escaped private SVG with a truthful media contract', async () => {
    const response = await GET(new Request('http://localhost/api/receipts/receipt-1/svg'), {
      params: Promise.resolve({ id: 'receipt-1' }),
    })
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/svg+xml; charset=utf-8')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(body).toContain('&lt;/text&gt;&lt;script&gt;alert(1)&lt;/scrip')
    expect(body).not.toContain('</text><script>')
  })

  it('rejects unauthenticated and inactive users', async () => {
    mocks.getUser.mockResolvedValueOnce({ data: { user: null } })
    expect((await GET(new Request('http://localhost/api/receipts/x/svg'), {
      params: Promise.resolve({ id: 'x' }),
    })).status).toBe(401)

    mocks.profileSingle.mockResolvedValueOnce({ data: { funcao: 'vendedor', ativo: false } })
    expect((await GET(new Request('http://localhost/api/receipts/x/svg'), {
      params: Promise.resolve({ id: 'x' }),
    })).status).toBe(403)
  })
})
