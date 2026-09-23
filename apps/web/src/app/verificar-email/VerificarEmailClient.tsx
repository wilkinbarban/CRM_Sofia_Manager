'use client'

import React from 'react'
import Link from 'next/link'
import { CheckCircle2, XCircle, Mail, ArrowRight } from 'lucide-react'
import { BrandLogo } from '@/components/ui/BrandLogo'
import { safeInternalRedirect } from '@/lib/auth/safe-redirect'

interface VerificarEmailClientProps {
  sucesso: string | null
  next: string | null
}

export default function VerificarEmailClient({ sucesso, next }: VerificarEmailClientProps) {
  const redirectTo = safeInternalRedirect(next, '/cliente/chat')

  return (
    <main className="min-h-screen w-full flex items-center justify-center bg-zinc-950 p-4 relative overflow-hidden font-sans">
      {/* Background glow effects */}
      <div className="absolute top-0 -right-4 w-96 h-96 bg-amber-500/5 rounded-full blur-3xl" />
      <div className="absolute bottom-0 -left-4 w-96 h-96 bg-amber-500/5 rounded-full blur-3xl" />

      <div className="w-full max-w-md z-10">
        {/* Brand header */}
        <div className="flex flex-col items-center mb-8 text-center">
          <BrandLogo size="xl" showSubtitle={false} className="flex-col !gap-3" />
          <p className="text-xs text-amber-500 font-bold tracking-widest uppercase mt-1">
            Confirmação segura de acesso
          </p>
        </div>

        {/* Verification Card */}
        <div className="backdrop-blur-md bg-zinc-900/40 border border-zinc-800 rounded-2xl p-6 md:p-8 shadow-2xl text-center">
          {sucesso === 'true' && (
            <div className="space-y-6">
              <div className="flex justify-center">
                <div className="h-16 w-16 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
                  <CheckCircle2 className="h-10 w-10" />
                </div>
              </div>
              
              <div className="space-y-2">
                <h2 className="text-2xl font-bold text-zinc-100">E-mail Confirmado!</h2>
                <p className="text-zinc-400 text-sm">
                  Seu endereço de e-mail foi verificado com sucesso. Agora você tem acesso aos recursos do CRM.
                </p>
              </div>

              <Link
                href={redirectTo}
                className="w-full py-3 bg-amber-500 hover:bg-amber-600 text-zinc-950 rounded-xl text-sm font-semibold shadow-lg shadow-amber-500/10 active:scale-[0.98] transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                Continuar
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          )}

          {sucesso === 'false' && (
            <div className="space-y-6">
              <div className="flex justify-center">
                <div className="h-16 w-16 rounded-full bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400">
                  <XCircle className="h-10 w-10" />
                </div>
              </div>
              
              <div className="space-y-2">
                <h2 className="text-2xl font-bold text-zinc-100">Erro de Verificação</h2>
                <p className="text-zinc-400 text-sm">
                  Não foi possível verificar seu e-mail. O link pode ter expirado ou já ter sido utilizado.
                </p>
              </div>

              <Link
                href="/login"
                className="w-full py-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-100 rounded-xl text-sm font-semibold transition-all flex items-center justify-center cursor-pointer"
              >
                Voltar ao Login
              </Link>
            </div>
          )}

          {sucesso !== 'true' && sucesso !== 'false' && (
            <div className="space-y-6">
              <div className="flex justify-center animate-pulse">
                <div className="h-16 w-16 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
                  <Mail className="h-10 w-10" />
                </div>
              </div>
              
              <div className="space-y-2">
                <h2 className="text-2xl font-bold text-zinc-100">Verifique seu E-mail</h2>
                <p className="text-zinc-400 text-sm">
                  Enviamos um link de ativação para seu e-mail. Confirme sua conta clicando no link enviado.
                </p>
              </div>

              <Link
                href="/login"
                className="w-full py-3 bg-amber-500 hover:bg-amber-600 text-zinc-950 rounded-xl text-sm font-semibold shadow-lg shadow-amber-500/10 active:scale-[0.98] transition-all flex items-center justify-center cursor-pointer"
              >
                Voltar ao Login
              </Link>
            </div>
          )}
        </div>
      </div>
    </main>
  )
}
