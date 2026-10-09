import React from 'react'
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { BrandLogo } from '@/components/ui/BrandLogo'
import { LogOut } from 'lucide-react'
import ClienteNav from '@/components/cliente/ClienteNav'
import { getBusinessProfile } from '@/lib/config/business-profile'

// Server Action for logout
async function handleLogout() {
  'use server'
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect('/')
}

export default async function ClienteLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const headersList = await headers()
  const pathname = headersList.get('x-pathname') || ''
  const isVerificarTelefone = pathname === '/cliente/verificar-telefone'

  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    redirect('/login')
  }

  // If user is on the verify phone page, render children directly without header navigation
  if (isVerificarTelefone) {
    return <>{children}</>
  }

  // Query customers table to check if phone is verified
  const { data: cliente, error: clienteError } = await supabase
    .from('clientes')
    .select('id')
    .eq('usuario_id', user.id)
    .single()

  if (clienteError || !cliente) {
    redirect('/cliente/verificar-telefone')
  }

  const businessProfile = await getBusinessProfile()

  return (
    <div className="h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans animate-in fade-in duration-300 overflow-hidden">
      {/* Header bar */}
      <header className="border-b border-zinc-900/90 bg-zinc-950/80 backdrop-blur-md sticky top-0 z-40">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center space-x-6">
            <BrandLogo
              size="md"
              href="/cliente/chat"
              brandName={businessProfile.name}
              subtitle={businessProfile.location}
            />

            {/* Navigation Tabs */}
            <ClienteNav />
          </div>

          <form action={handleLogout}>
            <button
              type="submit"
              className="flex items-center space-x-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 py-1.5 px-3 rounded-lg font-medium cursor-pointer"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>Sair</span>
            </button>
          </form>
        </div>
      </header>

      {/* Main content area */}
      <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {children}
      </main>
    </div>
  )
}
