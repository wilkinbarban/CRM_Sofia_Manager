import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  createServerClient: vi.fn(),
  exchangeCodeForSession: vi.fn(),
}))

vi.mock('next/headers', () => ({
  cookies: mocks.cookies,
}))

vi.mock('@supabase/ssr', () => ({
  createServerClient: (...args: unknown[]) => mocks.createServerClient(...args),
}))

import { GET } from '@/app/api/auth/callback/route'

describe('authentication callback redirects', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.cookies.mockResolvedValue({ getAll: () => [], set: vi.fn() })
    mocks.exchangeCodeForSession.mockResolvedValue({ error: null })
    mocks.createServerClient.mockReturnValue({
      auth: { exchangeCodeForSession: mocks.exchangeCodeForSession },
    })
  })

  it('preserves a safe internal destination after a successful exchange', async () => {
    const response = await GET(new Request('https://asados.test/api/auth/callback?code=code-1&next=%2Fatendimento%3Ftab%3Dinbox'))

    expect(mocks.createServerClient).toHaveBeenCalled()
    expect(mocks.exchangeCodeForSession).toHaveBeenCalledWith('code-1')
    expect(response.headers.get('location')).toBe('https://asados.test/verificar-email?sucesso=true&next=%2Fatendimento%3Ftab%3Dinbox')
  })

  it('drops an external destination after a successful exchange', async () => {
    const response = await GET(new Request('https://asados.test/api/auth/callback?code=code-1&next=https%3A%2F%2Fattacker.example'))

    expect(mocks.createServerClient).toHaveBeenCalled()
    expect(mocks.exchangeCodeForSession).toHaveBeenCalledWith('code-1')
    expect(response.headers.get('location')).toBe('https://asados.test/verificar-email?sucesso=true')
  })
})
