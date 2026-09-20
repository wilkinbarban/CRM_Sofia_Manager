'use client'

import React, { useState, useEffect, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/client'
import { Eye, EyeOff, Loader2, Mail, Lock, Phone, KeyRound, CheckCircle2 } from 'lucide-react'
import { BrandLogo } from '@/components/ui/BrandLogo'
import { getRoleRedirectPath, safeInternalRedirect } from '@/lib/auth/safe-redirect'

// Schema do Login Cliente (Phone-First)
const clientLoginSchema = z.object({
  telefone: z.string().min(10, 'Insira um celular de Curitiba com DDD 41'),
  senha: z.string().min(1, 'A senha é obrigatória'),
})

// Schema do Login Operador (E-mail corporativo)
const operatorLoginSchema = z.object({
  email: z.string().email('Insira um e-mail válido'),
  senha: z.string().min(1, 'A senha é obrigatória'),
})

function LoginContent() {
  const searchParams = useSearchParams()
  const supabase = createClient()

  // Tabs: 'cliente' | 'operador'
  const [tipoLogin, setTipoLogin] = useState<'cliente' | 'operador'>('cliente')

  // Form states
  const [telefone, setTelefone] = useState('')
  const [email, setEmail] = useState('')
  const [senha, setSenha] = useState('')

  // Recovery modal states
  const [isRecoveryOpen, setIsRecoveryOpen] = useState(false)
  const [recoveryStep, setRecoveryStep] = useState<'request' | 'reset' | 'success'>('request')
  const [recoveryPhone, setRecoveryPhone] = useState('')
  const [recoveryChallengeId, setRecoveryChallengeId] = useState<string | null>(null)
  const [recoveryOtp, setRecoveryOtp] = useState('')
  const [recoveryNewPassword, setRecoveryNewPassword] = useState('')
  const [recoveryCooldown, setRecoveryCooldown] = useState(0)

  // UI States
  const [showPassword, setShowPassword] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [apiError, setApiError] = useState<string | null>(null)
  const [infoMessage, setInfoMessage] = useState<string | null>(null)

  useEffect(() => {
    const errorParam = searchParams.get('erro')
    const registeredParam = searchParams.get('cadastrado')

    if (errorParam === 'inativo') {
      setApiError('Esta conta foi desativada pelo administrador. Entre em contato para mais informações.')
    } else if (errorParam === 'nao-autorizado') {
      setApiError('Você precisa fazer login para acessar esta página.')
    }

    if (registeredParam === 'true') {
      setInfoMessage('Cadastro realizado com sucesso! Faça login para continuar.')
    }
  }, [searchParams])

  useEffect(() => {
    if (recoveryCooldown <= 0) return
    const timer = setInterval(() => setRecoveryCooldown((prev) => prev - 1), 1000)
    return () => clearInterval(timer)
  }, [recoveryCooldown])

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>, setter: (v: string) => void) => {
    let raw = e.target.value.replace(/\D/g, '')
    if (raw.startsWith('55')) raw = raw.slice(2)
    if (raw.length > 11) raw = raw.slice(0, 11)

    let formatted = raw
    if (raw.length > 2) {
      formatted = `(${raw.slice(0, 2)}) ${raw.slice(2)}`
    }
    if (raw.length > 7) {
      formatted = `(${raw.slice(0, 2)}) ${raw.slice(2, 7)}-${raw.slice(7)}`
    }
    setter(formatted)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setApiError(null)
    setInfoMessage(null)
    setIsLoading(true)

    try {
      if (tipoLogin === 'cliente') {
        const result = clientLoginSchema.safeParse({ telefone, senha })
        if (!result.success) {
          setApiError(result.error.issues[0].message)
          setIsLoading(false)
          return
        }

        const canonicalPhone = telefone.replace(/\D/g, '').length === 11
          ? `55${telefone.replace(/\D/g, '')}`
          : telefone.replace(/\D/g, '')

        const { data, error } = await supabase.auth.signInWithPassword({
          phone: canonicalPhone,
          password: senha,
        })

        if (error || !data.user) {
          setApiError('Telefone ou senha incorretos. Verifique suas credenciais e tente novamente.')
          setIsLoading(false)
          return
        }

        const nextParam = searchParams.get('next')
        const destination = safeInternalRedirect(nextParam, '/cliente/chat')
        window.location.href = destination
      } else {
        // Operador flow (Email + Senha)
        const result = operatorLoginSchema.safeParse({ email, senha })
        if (!result.success) {
          setApiError(result.error.issues[0].message)
          setIsLoading(false)
          return
        }

        const { data, error } = await supabase.auth.signInWithPassword({
          email,
          password: senha,
        })

        if (error || !data.user) {
          setApiError('E-mail ou senha incorretos. Verifique suas credenciais e tente novamente.')
          setIsLoading(false)
          return
        }

        // Buscar perfil para redirecionamento apropriado
        const { data: perfil } = await supabase
          .from('perfis')
          .select('funcao, ativo')
          .eq('id', data.user.id)
          .single()

        if (perfil?.ativo === false) {
          await supabase.auth.signOut()
          setApiError('Esta conta foi desativada pelo administrador.')
          setIsLoading(false)
          return
        }

        const nextParam = searchParams.get('next')
        let destination = '/cliente/chat'
        if (perfil?.funcao && ['admin', 'supervisor', 'vendedor'].includes(perfil.funcao)) {
          destination = getRoleRedirectPath(perfil.funcao)
        }
        if (nextParam) {
          destination = safeInternalRedirect(nextParam, destination)
        }

        window.location.href = destination
      }
    } catch {
      setApiError('Ocorreu um erro inesperado ao tentar fazer login.')
    } finally {
      setIsLoading(false)
    }
  }

  // Solicitar recuperação de senha
  const handleRequestRecovery = async (e: React.FormEvent) => {
    e.preventDefault()
    setApiError(null)
    setIsLoading(true)

    try {
      const res = await fetch('/api/client-auth/recovery/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telefone: recoveryPhone })
      })

      const data = await res.json()
      if (res.ok && data.success) {
        setRecoveryChallengeId(data.challengeId)
        setRecoveryCooldown(60)
        setRecoveryStep('reset')
      } else {
        setApiError(data.error || 'Erro ao solicitar código de recuperação.')
      }
    } catch {
      setApiError('Erro ao conectar ao servidor.')
    } finally {
      setIsLoading(false)
    }
  }

  // Redefinir senha com OTP
  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!recoveryChallengeId || recoveryOtp.length !== 6) {
      setApiError('Insira o código de 6 dígitos.')
      return
    }

    setApiError(null)
    setIsLoading(true)

    try {
      const res = await fetch('/api/client-auth/recovery/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challengeId: recoveryChallengeId,
          telefone: recoveryPhone,
          codigo: recoveryOtp,
          novaSenha: recoveryNewPassword
        })
      })

      const data = await res.json()
      if (res.ok && data.success) {
        setRecoveryStep('success')
        setTimeout(() => {
          setIsRecoveryOpen(false)
          setRecoveryStep('request')
          setInfoMessage('Senha atualizada com sucesso! Você já pode entrar com sua nova senha.')
        }, 2000)
      } else {
        setApiError(data.error || 'Código inválido ou senha não atende aos requisitos.')
      }
    } catch {
      setApiError('Erro ao redefinir a senha.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <main className="min-h-screen w-full flex items-center justify-center bg-radial from-zinc-900 via-zinc-950 to-black p-4 relative overflow-hidden font-sans">
      <div className="absolute top-0 -right-4 w-96 h-96 bg-red-600/10 rounded-full blur-3xl" />
      <div className="absolute bottom-0 -left-4 w-96 h-96 bg-amber-600/10 rounded-full blur-3xl" />

      <div className="w-full max-w-md z-10 transition-all duration-300">
        {/* Header com Logo */}
        <div className="flex flex-col items-center mb-8 text-center">
          <BrandLogo size="xl" showSubtitle={false} className="flex-col !gap-3" />
          <span className="mt-1.5 inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-0.5 text-xs font-bold tracking-widest text-amber-400 uppercase">
            CRM Sofia Manager
          </span>
          <p className="text-sm text-zinc-400 mt-2">
            Acesse sua conta para pedir seu combo ou gerenciar o atendimento
          </p>
        </div>

        {/* Modal de Recuperação de Senha */}
        {isRecoveryOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-2xl space-y-4">
              <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
                <div className="flex items-center space-x-2 text-white font-bold">
                  <KeyRound className="h-5 w-5 text-amber-500" />
                  <span>Recuperação de Senha</span>
                </div>
                <button
                  type="button"
                  onClick={() => setIsRecoveryOpen(false)}
                  className="text-zinc-500 hover:text-zinc-300 text-sm font-semibold"
                >
                  ✕
                </button>
              </div>

              {apiError && (
                <div className="p-3 bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-xl font-medium">
                  {apiError}
                </div>
              )}

              {recoveryStep === 'request' && (
                <form onSubmit={handleRequestRecovery} className="space-y-4">
                  <p className="text-xs text-zinc-400">
                    Informe seu celular de Curitiba para enviarmos um código de recuperação via WhatsApp ou Telegram.
                  </p>
                  <div className="space-y-1.5">
                    <label className="text-xs uppercase tracking-wider text-zinc-400 font-semibold block" htmlFor="recoveryPhone">
                      Celular (DDD 41)
                    </label>
                    <input
                      id="recoveryPhone"
                      type="tel"
                      required
                      value={recoveryPhone}
                      onChange={(e) => handlePhoneChange(e, setRecoveryPhone)}
                      placeholder="(41) 98888-7777"
                      className="w-full px-4 py-2.5 bg-zinc-950 border border-zinc-800 focus:border-amber-500 rounded-xl text-sm text-white placeholder-zinc-500 focus:outline-hidden"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isLoading}
                    className="w-full py-2.5 bg-amber-500 hover:bg-amber-400 text-zinc-950 font-bold rounded-xl text-sm transition-all"
                  >
                    {isLoading ? 'Enviando código...' : 'Enviar Código'}
                  </button>
                </form>
              )}

              {recoveryStep === 'reset' && (
                <form onSubmit={handleResetPassword} className="space-y-4">
                  <p className="text-xs text-zinc-400">
                    Insira o código de 6 dígitos enviado para <strong className="text-zinc-200">{recoveryPhone}</strong> e sua nova senha.
                  </p>
                  <div className="space-y-1.5">
                    <label className="text-xs uppercase tracking-wider text-zinc-400 font-semibold block" htmlFor="recoveryOtp">
                      Código OTP (6 dígitos)
                    </label>
                    <input
                      id="recoveryOtp"
                      type="text"
                      maxLength={6}
                      required
                      value={recoveryOtp}
                      onChange={(e) => setRecoveryOtp(e.target.value.replace(/\D/g, ''))}
                      placeholder="000000"
                      className="w-full py-2.5 px-4 text-center tracking-widest text-lg font-mono bg-zinc-950 border border-zinc-800 focus:border-amber-500 rounded-xl text-white font-bold"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs uppercase tracking-wider text-zinc-400 font-semibold block" htmlFor="recoveryNewPassword">
                      Nova Senha (Mín. 8 caracteres)
                    </label>
                    <input
                      id="recoveryNewPassword"
                      type="password"
                      required
                      value={recoveryNewPassword}
                      onChange={(e) => setRecoveryNewPassword(e.target.value)}
                      placeholder="Nova senha segura"
                      className="w-full px-4 py-2.5 bg-zinc-950 border border-zinc-800 focus:border-amber-500 rounded-xl text-sm text-white focus:outline-hidden"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isLoading || recoveryOtp.length !== 6}
                    className="w-full py-2.5 bg-linear-to-r from-red-600 to-amber-500 text-white font-bold rounded-xl text-sm transition-all"
                  >
                    {isLoading ? 'Redefinindo...' : 'Salvar Nova Senha'}
                  </button>
                </form>
              )}

              {recoveryStep === 'success' && (
                <div className="text-center py-4 space-y-2">
                  <CheckCircle2 className="h-10 w-10 text-emerald-400 mx-auto" />
                  <h3 className="text-white font-bold">Senha Redefinida!</h3>
                  <p className="text-xs text-zinc-400">Você já pode fazer login com a nova senha.</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Card Principal */}
        <div className="backdrop-blur-md bg-zinc-900/50 border border-zinc-800 rounded-2xl p-6 md:p-8 shadow-2xl transition-all duration-300">
          {/* Alternador de tipo de login */}
          <div className="flex bg-zinc-950/80 p-1 rounded-xl border border-zinc-800 mb-6">
            <button
              type="button"
              onClick={() => { setTipoLogin('cliente'); setApiError(null); }}
              className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-all ${tipoLogin === 'cliente' ? 'bg-amber-500 text-zinc-950 shadow-md font-bold' : 'text-zinc-400 hover:text-zinc-200'}`}
            >
              Sou Cliente
            </button>
            <button
              type="button"
              onClick={() => { setTipoLogin('operador'); setApiError(null); }}
              className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-all ${tipoLogin === 'operador' ? 'bg-amber-500 text-zinc-950 shadow-md font-bold' : 'text-zinc-400 hover:text-zinc-200'}`}
            >
              Equipe / Operador
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            {apiError && (
              <div className="p-4 bg-red-500/10 border border-red-500/20 text-red-400 text-sm rounded-xl font-medium">
                {apiError}
              </div>
            )}

            {infoMessage && (
              <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm rounded-xl font-medium">
                {infoMessage}
              </div>
            )}

            {tipoLogin === 'cliente' ? (
              /* Campo Telefone do Cliente */
              <div className="space-y-2">
                <label className="text-xs uppercase tracking-wider text-zinc-400 font-semibold block" htmlFor="telefone">
                  Celular de Curitiba (DDD 41)
                </label>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-zinc-500">
                    <Phone className="h-4 w-4" />
                  </span>
                  <input
                    id="telefone"
                    type="tel"
                    required
                    value={telefone}
                    onChange={(e) => handlePhoneChange(e, setTelefone)}
                    placeholder="(41) 98888-7777"
                    className="w-full pl-10 pr-4 py-3 bg-zinc-950/80 border border-zinc-800 focus:border-amber-500 rounded-xl text-sm text-white placeholder-zinc-500 focus:outline-hidden focus:ring-2 focus:ring-amber-500/20 transition-all font-medium"
                  />
                </div>
              </div>
            ) : (
              /* Campo Email do Operador */
              <div className="space-y-2">
                <label className="text-xs uppercase tracking-wider text-zinc-400 font-semibold block" htmlFor="email">
                  E-mail Corporativo
                </label>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-zinc-500">
                    <Mail className="h-4 w-4" />
                  </span>
                  <input
                    id="email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="operador@crmsofiamanager.com.br"
                    className="w-full pl-10 pr-4 py-3 bg-zinc-950/80 border border-zinc-800 focus:border-amber-500 rounded-xl text-sm text-white placeholder-zinc-500 focus:outline-hidden focus:ring-2 focus:ring-amber-500/20 transition-all font-medium"
                  />
                </div>
              </div>
            )}

            {/* Campo Senha */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs uppercase tracking-wider text-zinc-400 font-semibold block" htmlFor="senha">
                  Senha
                </label>
                <button
                  type="button"
                  onClick={() => { setIsRecoveryOpen(true); setApiError(null); }}
                  className="text-xs text-amber-500 hover:text-amber-400 transition-colors font-medium"
                >
                  Esqueceu a senha?
                </button>
              </div>
              <div className="relative">
                <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-zinc-500">
                  <Lock className="h-4 w-4" />
                </span>
                <input
                  id="senha"
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={senha}
                  onChange={(e) => setSenha(e.target.value)}
                  placeholder="Sua senha de acesso"
                  className="w-full pl-10 pr-10 py-3 bg-zinc-950/80 border border-zinc-800 focus:border-amber-500 rounded-xl text-sm text-white placeholder-zinc-500 focus:outline-hidden focus:ring-2 focus:ring-amber-500/20 transition-all font-medium"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {/* Botão de Entrar */}
            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-3 bg-linear-to-r from-red-600 to-amber-500 hover:from-red-500 hover:to-amber-400 disabled:opacity-50 text-white rounded-xl text-sm font-semibold shadow-lg shadow-red-600/20 hover:shadow-red-600/35 active:scale-[0.98] transition-all flex items-center justify-center cursor-pointer"
            >
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Entrando...
                </>
              ) : (
                'Entrar na Conta'
              )}
            </button>

            {/* Link de Cadastro */}
            <div className="text-center text-xs text-zinc-500 mt-4">
              Ainda não tem conta?{' '}
              <Link href="/cadastro" className="text-amber-500 hover:text-amber-400 transition-colors font-semibold">
                Cadastre-se com seu celular
              </Link>
            </div>
          </form>
        </div>
      </div>
    </main>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen w-full flex items-center justify-center bg-black text-white">
        <Loader2 className="h-8 w-8 animate-spin text-amber-500" />
      </div>
    }>
      <LoginContent />
    </Suspense>
  )
}
