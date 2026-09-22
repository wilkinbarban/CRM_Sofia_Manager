import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { getBusinessProfile } from '@/lib/config/business-profile'

export default async function ProdutosLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()

  // 1. Verificar sessão do usuário ativo
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    redirect('/login')
  }

  // 2. Buscar perfil e validar se está ativo e se possui papel de admin/supervisor
  const { data: perfil, error: perfilError } = await supabase
    .from('perfis')
    .select('funcao, ativo')
    .eq('id', user.id)
    .single()

  if (perfilError || !perfil || !perfil.ativo) {
    redirect('/login')
  }

  const funcoesAutorizadas = ['admin', 'supervisor']
  if (!funcoesAutorizadas.includes(perfil.funcao)) {
    redirect('/atendimento')
  }

  const profile = await getBusinessProfile()
  const initialLetter = (profile.shortName || profile.name || 'A').charAt(0).toUpperCase()

  return (
    <div className="flex h-screen w-full flex-col bg-zinc-950 text-zinc-50 overflow-hidden font-sans">
      {/* Cabeçalho Unificado do Operador */}
      <header className="flex h-16 items-center justify-between border-b border-zinc-800 bg-zinc-900/30 px-6 shrink-0 backdrop-blur-md z-10">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded bg-amber-500 font-bold text-zinc-950 shadow-md shadow-amber-500/10 select-none">
            {initialLetter}
          </div>
          <span className="font-semibold text-zinc-100 tracking-tight font-sans">Console de Atendimento {profile.shortName}</span>
        </div>

        {/* Ações / Perfil no Cabeçalho */}
        <div className="flex items-center gap-4">
          <Link
            href="/atendimento"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-zinc-100 border border-zinc-800 hover:border-zinc-700 rounded-lg text-xs font-semibold transition-all cursor-pointer select-none"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Voltar ao Chat
          </Link>
          
          <div className="h-4 w-[1px] bg-zinc-800"></div>

          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500"></span>
            </span>
            <span className="text-xs text-zinc-400 font-medium capitalize">
              {perfil.funcao}
            </span>
          </div>
        </div>
      </header>

      {/* Container Principal */}
      <main className="flex-1 overflow-hidden flex flex-col">
        {children}
      </main>
    </div>
  )
}
