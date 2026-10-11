import { describe, expect, it } from 'vitest'
import { getRoleRedirectPath } from '@/lib/auth/safe-redirect'

// Runner opt-in is a safety check, not proof of authentication.
if (
  process.env.LOCAL_SUPABASE_SERVICE_RUNNER !== '1' ||
  process.env.NEXT_PUBLIC_SUPABASE_URL !== 'http://127.0.0.1:55321' ||
  process.env.SUPABASE_INTERNAL_URL !== 'http://127.0.0.1:55321' ||
  !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  !process.env.SUPABASE_SERVICE_ROLE_KEY
) {
  throw new Error('Use npm run test:unit:supabase with the disposable local stack.')
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const { createClient } = await import('@supabase/supabase-js')

describe('End-to-End Roles Authentication & Authorization Suite', () => {
  it('authenticates admin and resolves admin role redirect', async () => {
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
    })

    const { data, error } = await supabase.auth.signInWithPassword({
      email: 'admin@crmsofiamanager.com.br',
      password: 'SenhaAdmin123',
    })

    expect(error).toBeNull()
    expect(data.user).toBeDefined()
    expect(data.user?.id).toBe('a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1')

    const { data: profile, error: profileError } = await supabase
      .from('perfis')
      .select('funcao, ativo')
      .eq('id', data.user!.id)
      .single()

    expect(profileError).toBeNull()
    expect(profile?.funcao).toBe('admin')
    expect(profile?.ativo).toBe(true)

    const destination = getRoleRedirectPath(profile?.funcao)
    expect(destination).toBe('/atendimento/admin')
  })

  it('authenticates supervisor and resolves operator redirect', async () => {
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
    })

    const { data, error } = await supabase.auth.signInWithPassword({
      email: 'supervisor@crmsofiamanager.com.br',
      password: 'SenhaSupervisor123',
    })

    expect(error).toBeNull()
    expect(data.user?.id).toBe('7c7c7c7c-7c7c-7c7c-7c7c-7c7c7c7c7c7c')

    const { data: profile, error: profileError } = await supabase
      .from('perfis')
      .select('funcao, ativo')
      .eq('id', data.user!.id)
      .single()

    expect(profileError).toBeNull()
    expect(profile?.funcao).toBe('supervisor')
    expect(profile?.ativo).toBe(true)

    const destination = getRoleRedirectPath(profile?.funcao)
    expect(destination).toBe('/atendimento')
  })

  it('authenticates vendedor and resolves operator redirect', async () => {
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
    })

    const { data, error } = await supabase.auth.signInWithPassword({
      email: 'vendedor@crmsofiamanager.com.br',
      password: 'SenhaVendedor123',
    })

    expect(error).toBeNull()
    expect(data.user?.id).toBe('b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2')

    const { data: profile, error: profileError } = await supabase
      .from('perfis')
      .select('funcao, ativo')
      .eq('id', data.user!.id)
      .single()

    expect(profileError).toBeNull()
    expect(profile?.funcao).toBe('vendedor')
    expect(profile?.ativo).toBe(true)

    const destination = getRoleRedirectPath(profile?.funcao)
    expect(destination).toBe('/atendimento')
  })

  it('authenticates cliente web and resolves client chat redirect', async () => {
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
    })

    const { data, error } = await supabase.auth.signInWithPassword({
      phone: '5541988888888',
      password: 'SenhaCliente123',
    })

    expect(error).toBeNull()
    expect(data.user?.id).toBe('c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3')

    const { data: profile, error: profileError } = await supabase
      .from('perfis')
      .select('funcao, ativo')
      .eq('id', data.user!.id)
      .single()

    expect(profileError).toBeNull()
    expect(profile?.funcao).toBe('cliente')

    const { data: clientRecord, error: clientError } = await supabase
      .from('clientes')
      .select('id')
      .eq('usuario_id', data.user!.id)
      .maybeSingle()

    expect(clientError).toBeNull()
    expect(clientRecord).toBeDefined()

    const destination = getRoleRedirectPath(profile?.funcao, Boolean(clientRecord))
    expect(destination).toBe('/cliente/chat')
  })

  it('authenticates phone-first cliente and resolves client chat redirect', async () => {
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
    })

    const { data, error } = await supabase.auth.signInWithPassword({
      phone: '5541999998888',
      password: 'SenhaCliente123',
    })

    expect(error).toBeNull()
    expect(data.user?.phone).toBe('5541999998888')

    const { data: profile } = await supabase
      .from('perfis')
      .select('funcao, ativo')
      .eq('id', data.user!.id)
      .single()

    expect(profile?.funcao).toBe('cliente')

    const { data: clientRecord } = await supabase
      .from('clientes')
      .select('id')
      .eq('usuario_id', data.user!.id)
      .maybeSingle()

    expect(clientRecord).toBeDefined()

    const destination = getRoleRedirectPath(profile?.funcao, Boolean(clientRecord))
    expect(destination).toBe('/cliente/chat')
  })
})
