import { afterEach, describe, expect, it } from 'vitest'
import { getSupabasePublicUrl, getSupabaseServerUrl } from '@/lib/supabase/url'

const originalEnvironment = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnvironment }
})

describe('Supabase URL resolution', () => {
  it('uses the public URL in browser-facing configuration', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://crmsofiamanager.duckdns.org'
    process.env.SUPABASE_INTERNAL_URL = 'http://api-gw:8000'

    expect(getSupabasePublicUrl()).toBe('https://crmsofiamanager.duckdns.org')
  })

  it('prefers the private Docker URL for server-side traffic', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://crmsofiamanager.duckdns.org'
    process.env.SUPABASE_INTERNAL_URL = 'http://api-gw:8000'

    expect(getSupabaseServerUrl()).toBe('http://api-gw:8000')
  })

  it('falls back to the public URL outside the production network', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321'
    delete process.env.SUPABASE_INTERNAL_URL

    expect(getSupabaseServerUrl()).toBe('http://127.0.0.1:54321')
  })
})
