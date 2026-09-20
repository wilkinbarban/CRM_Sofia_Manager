import { getSupabaseServerUrl } from '@/lib/supabase/url'

export const dynamic = 'force-dynamic'

const readinessTimeoutMs = 3_000

async function dependencyIsReady(url: string, init?: RequestInit): Promise<boolean> {
  try {
    const response = await fetch(url, {
      ...init,
      cache: 'no-store',
      signal: AbortSignal.timeout(readinessTimeoutMs),
    })
    return response.ok
  } catch {
    return false
  }
}

export async function GET() {
  const [supabaseReady, evolutionReady] = await Promise.all([
    dependencyIsReady(`${getSupabaseServerUrl().replace(/\/$/, '')}/auth/v1/health`, {
      headers: {
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
        Authorization: `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''}`,
      },
    }),
    dependencyIsReady('http://evolution-api:8080/', {
      headers: { Origin: 'https://crmsofiamanager.duckdns.org' },
    }),
  ])

  const ready = supabaseReady && evolutionReady
  return Response.json(
    { status: ready ? 'ready' : 'unavailable' },
    {
      status: ready ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    },
  )
}
