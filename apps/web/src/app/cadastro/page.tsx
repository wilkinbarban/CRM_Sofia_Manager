'use client'

import React, { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/client'
import { Eye, EyeOff, Loader2, CheckCircle2, User, Phone, Lock, ArrowRight, RefreshCw, KeyRound } from 'lucide-react'
import { BrandLogo } from '@/components/ui/BrandLogo'

// Schema de validação Phone-First
const cadastroSchema = z.object({
  nome: z.string().min(3, 'O nome deve ter pelo menos 3 caracteres'),
  telefone: z
    .string()
    .min(10, 'Insira um celular de Curitiba com DDD 41')
    .refine((val) => {
      const digits = val.replace(/\D/g, '')
      return digits.length === 11 && digits.startsWith('419') || (digits.length === 13 && digits.startsWith('55419'))
    }, 'O telefone deve ser um celular de Curitiba (ex: 41 9XXXX-XXXX)'),
  senha: z
    .string()
    .min(8, 'A senha deve ter no mínimo 8 caracteres')
    .regex(/[A-Z]/, 'A senha deve conter pelo menos uma letra maiúscula')
    .regex(/[a-z]/, 'A senha deve conter pelo menos uma letra minúscula')
    .regex(/[0-9]/, 'A senha deve conter pelo menos um número'),
})

type CadastroForm = z.infer<typeof cadastroSchema>

export default function CadastroPage() {
  const router = useRouter()
  const supabase = createClient()

  // Form states
  const [nome, setNome] = useState('')
  const [telefone, setTelefone] = useState('')
  const [senha, setSenha] = useState('')
  const [codigoOtp, setCodigoOtp] = useState('')

  // Flow & UI states
  const [etapa, setEtapa] = useState<'formulario' | 'verificacao' | 'sucesso'>('formulario')
  const [challengeId, setChallengeId] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [canalEnvio, setCanalEnvio] = useState<string>('whatsapp')
  const [cooldown, setCooldown] = useState(0)

  const [showPassword, setShowPassword] = useState(false)
  const [errors, setErrors] = useState<Partial<Record<keyof CadastroForm, string>>>({})
  const [isLoading, setIsLoading] = useState(false)
  const [apiError, setApiError] = useState<string | null>(null)

  // Password rules validation
  const hasMinLength = senha.length >= 8
  const hasUppercase = /[A-Z]/.test(senha)
  const hasLowercase = /[a-z]/.test(senha)
  const hasNumber = /[0-9]/.test(senha)

  // Formatador dinâmico de telefone brasileiro para Curitiba (41) 9XXXX-XXXX
  const handleTelefoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
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
    setTelefone(formatted)
  }

  // Timer de cooldown para reenvio
  useEffect(() => {
    if (cooldown <= 0) return
    const timer = setInterval(() => setCooldown((prev) => prev - 1), 1000)
    return () => clearInterval(timer)
  }, [cooldown])

  // Submeter cadastro inicial (Etapa 1)
  const handleSolicitarCadastro = async (e: React.FormEvent) => {
    e.preventDefault()
    setErrors({})
    setApiError(null)
    setIsLoading(true)

    const result = cadastroSchema.safeParse({ nome, telefone, senha })
    if (!result.success) {
      const fieldErrors: Partial<Record<keyof CadastroForm, string>> = {}
      result.error.issues.forEach((issue) => {
        const path = issue.path[0] as keyof CadastroForm
        fieldErrors[path] = issue.message
      })
      setErrors(fieldErrors)
      setIsLoading(false)
      return
    }

    try {
      const res = await fetch('/api/client-auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome, telefone, senha })
      })

      const data = await res.json()

      if (data.continuation === 'CHECK_YOUR_EXISTING_SIGNUP_OR_RECOVER_ACCOUNT') {
        setChallengeId(null)
        setUserId(null)
        setEtapa('formulario')
        setApiError('Se você já possui uma conta, recupere o acesso para continuar.')
      } else if (!res.ok || !data.success) {
        setApiError(data.error || 'Erro ao realizar cadastro.')
      } else {
        setChallengeId(data.challengeId)
        setUserId(data.userId)
        setCanalEnvio(data.channel || 'whatsapp')
        setCooldown(60)
        setEtapa('verificacao')
      }
    } catch {
      setApiError('Ocorreu um erro ao conectar ao servidor. Tente novamente.')
    } finally {
      setIsLoading(false)
    }
  }

  // Verificar OTP e confirmar cadastro (Etapa 2)
  const handleVerificarOtp = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!challengeId || !userId || codigoOtp.length !== 6) {
      setApiError('Insira o código de 6 dígitos enviado.')
      return
    }

    setApiError(null)
    setIsLoading(true)

    try {
      const res = await fetch('/api/client-auth/verify-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challengeId,
          telefone,
          codigo: codigoOtp,
          nome
        })
      })

      const data = await res.json()

      if (!res.ok || !data.success) {
        setApiError(data.error || 'Código incorreto ou expirado.')
      } else {
        // Autenticar automaticamente
        await supabase.auth.signInWithPassword({
          phone: telefone.replace(/\D/g, '').length === 11 ? `55${telefone.replace(/\D/g, '')}` : telefone.replace(/\D/g, ''),
          password: senha
        })

        setEtapa('sucesso')
        setTimeout(() => {
          router.push('/cliente/chat')
        }, 2000)
      }
    } catch {
      setApiError('Erro ao validar código. Tente novamente.')
    } finally {
      setIsLoading(false)
    }
  }

  // Reenviar OTP
  const handleReenviarOtp = async () => {
    if (cooldown > 0 || isLoading) return
    setIsLoading(true)
    setApiError(null)

    try {
      const res = await fetch('/api/client-auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome, telefone, senha })
      })

      const data = await res.json()
      if (res.ok && data.success) {
        setChallengeId(data.challengeId)
        setCooldown(60)
      } else {
        setApiError(data.error || 'Não foi possível reenviar o código.')
      }
    } catch {
      setApiError('Erro ao reenviar código.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <main className="min-h-screen w-full flex items-center justify-center bg-radial from-zinc-900 via-zinc-950 to-black p-4 relative overflow-hidden">
      <div className="absolute top-0 -left-4 w-96 h-96 bg-red-600/10 rounded-full blur-3xl" />
      <div className="absolute bottom-0 -right-4 w-96 h-96 bg-amber-600/10 rounded-full blur-3xl" />

      <div className="w-full max-w-md z-10 transition-all duration-300">
        {/* Brand header */}
        <div className="flex flex-col items-center mb-8 text-center">
          <BrandLogo size="xl" showSubtitle={false} className="flex-col !gap-3" />
          <p className="text-xs text-amber-500 font-bold tracking-widest uppercase mt-1">
            Ambiente de demonstração com dados de teste
          </p>
          <p className="text-sm text-zinc-400 mt-2">
            Crie sua conta em poucos segundos com seu celular de Curitiba
          </p>
        </div>

        {/* ETAPA 3: Sucesso */}
        {etapa === 'sucesso' && (
          <div className="backdrop-blur-md bg-zinc-900/50 border border-zinc-800 rounded-2xl p-8 shadow-2xl flex flex-col items-center text-center animate-in fade-in zoom-in-95 duration-300">
            <div className="h-16 w-16 bg-emerald-500/10 text-emerald-400 rounded-full flex items-center justify-center mb-4">
              <CheckCircle2 className="h-10 w-10 animate-bounce" />
            </div>
            <h2 className="text-2xl font-bold text-white mb-2">Telefone verificado!</h2>
            <p className="text-zinc-300 mb-6">
              Sua conta foi ativada com sucesso. Redirecionando para o cardápio...
            </p>
            <Link
              href="/cliente/chat"
              className="text-sm text-amber-500 hover:text-amber-400 underline font-medium"
            >
              Ir para o atendimento agora
            </Link>
          </div>
        )}

        {/* ETAPA 2: Validação OTP */}
        {etapa === 'verificacao' && (
          <div className="backdrop-blur-md bg-zinc-900/50 border border-zinc-800 rounded-2xl p-6 md:p-8 shadow-2xl transition-all duration-300 animate-in fade-in slide-in-from-right-4 duration-300">
            <div className="text-center mb-6">
              <div className="inline-flex p-3 bg-amber-500/10 text-amber-400 rounded-2xl mb-3">
                <KeyRound className="h-6 w-6" />
              </div>
              <h2 className="text-xl font-bold text-white">Confirme seu Telefone</h2>
              <p className="text-xs text-zinc-400 mt-1">
                Enviamos um código de 6 dígitos via{' '}
                <span className="font-semibold text-amber-400 capitalize">{canalEnvio}</span> para{' '}
                <strong className="text-zinc-200">{telefone}</strong>.
              </p>
            </div>

            <form onSubmit={handleVerificarOtp} className="space-y-5">
              {apiError && (
                <div className="p-4 bg-red-500/10 border border-red-500/20 text-red-400 text-sm rounded-xl font-medium">
                  {apiError}
                </div>
              )}

              <div className="space-y-2">
                <label className="text-xs uppercase tracking-wider text-zinc-400 font-semibold block text-center" htmlFor="codigoOtp">
                  Código de 6 dígitos
                </label>
                <input
                  id="codigoOtp"
                  type="text"
                  maxLength={6}
                  required
                  autoFocus
                  value={codigoOtp}
                  onChange={(e) => setCodigoOtp(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                  className="w-full py-3 px-4 text-center tracking-[0.5em] text-2xl font-mono bg-zinc-950/80 border border-zinc-800 focus:border-amber-500 rounded-xl text-white placeholder-zinc-700 focus:outline-hidden focus:ring-2 focus:ring-amber-500/20 transition-all font-bold"
                />
              </div>

              <button
                type="submit"
                disabled={isLoading || codigoOtp.length !== 6}
                className="w-full py-3 bg-linear-to-r from-red-600 to-amber-500 hover:from-red-500 hover:to-amber-400 disabled:opacity-50 text-white rounded-xl text-sm font-semibold shadow-lg shadow-red-600/20 hover:shadow-red-600/35 active:scale-[0.98] transition-all flex items-center justify-center cursor-pointer"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Validando código...
                  </>
                ) : (
                  <>
                    Confirmar e Entrar
                    <ArrowRight className="h-4 w-4 ml-2" />
                  </>
                )}
              </button>

              <div className="flex items-center justify-between text-xs pt-2">
                <button
                  type="button"
                  onClick={() => setEtapa('formulario')}
                  className="text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  ← Alterar número
                </button>
                <button
                  type="button"
                  disabled={cooldown > 0 || isLoading}
                  onClick={handleReenviarOtp}
                  className="text-amber-500 hover:text-amber-400 disabled:text-zinc-600 transition-colors font-medium flex items-center gap-1"
                >
                  <RefreshCw className="h-3 w-3" />
                  {cooldown > 0 ? `Reenviar em ${cooldown}s` : 'Reenviar código'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* ETAPA 1: Formulário de Cadastro */}
        {etapa === 'formulario' && (
          <div className="backdrop-blur-md bg-zinc-900/50 border border-zinc-800 rounded-2xl p-6 md:p-8 shadow-2xl transition-all duration-300">
            <form onSubmit={handleSolicitarCadastro} className="space-y-5">
              {apiError && (
                <div className="p-4 bg-red-500/10 border border-red-500/20 text-red-400 text-sm rounded-xl font-medium">
                  {apiError}
                </div>
              )}

              {/* Name Field */}
              <div className="space-y-2">
                <label className="text-xs uppercase tracking-wider text-zinc-400 font-semibold block" htmlFor="nome">
                  Nome Completo
                </label>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-zinc-500">
                    <User className="h-4 w-4" />
                  </span>
                  <input
                    id="nome"
                    type="text"
                    required
                    value={nome}
                    onChange={(e) => setNome(e.target.value)}
                    placeholder="Seu nome completo"
                    className="w-full pl-10 pr-4 py-3 bg-zinc-950/80 border border-zinc-800 focus:border-amber-500 rounded-xl text-sm text-white placeholder-zinc-500 focus:outline-hidden focus:ring-2 focus:ring-amber-500/20 transition-all font-medium"
                  />
                </div>
                {errors.nome && (
                  <p className="text-xs text-red-500 mt-1 font-medium">{errors.nome}</p>
                )}
              </div>

              {/* Phone Field */}
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
                    onChange={handleTelefoneChange}
                    placeholder="(41) 98888-7777"
                    className="w-full pl-10 pr-4 py-3 bg-zinc-950/80 border border-zinc-800 focus:border-amber-500 rounded-xl text-sm text-white placeholder-zinc-500 focus:outline-hidden focus:ring-2 focus:ring-amber-500/20 transition-all font-medium"
                  />
                </div>
                {errors.telefone && (
                  <p className="text-xs text-red-500 mt-1 font-medium">{errors.telefone}</p>
                )}
              </div>

              {/* Password Field */}
              <div className="space-y-2">
                <label className="text-xs uppercase tracking-wider text-zinc-400 font-semibold block" htmlFor="senha">
                  Senha de Acesso
                </label>
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
                    placeholder="Mínimo de 8 caracteres"
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
                {errors.senha && (
                  <p className="text-xs text-red-500 mt-1 font-medium">{errors.senha}</p>
                )}

                {/* Live Password Strength Indicator */}
                {senha.length > 0 && (
                  <div className="mt-3 p-3 bg-zinc-950/50 rounded-xl border border-zinc-800 space-y-1.5 animate-in fade-in duration-200">
                    <p className="text-[10px] text-zinc-500 uppercase tracking-wider font-bold">Requisitos de Segurança</p>
                    <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                      <div className="flex items-center space-x-1.5 text-xs">
                        <span className={`h-1.5 w-1.5 rounded-full ${hasMinLength ? 'bg-emerald-500' : 'bg-zinc-700'}`} />
                        <span className={hasMinLength ? 'text-emerald-400 font-medium' : 'text-zinc-500'}>Mín. 8 dígitos</span>
                      </div>
                      <div className="flex items-center space-x-1.5 text-xs">
                        <span className={`h-1.5 w-1.5 rounded-full ${hasUppercase ? 'bg-emerald-500' : 'bg-zinc-700'}`} />
                        <span className={hasUppercase ? 'text-emerald-400 font-medium' : 'text-zinc-500'}>Maiúscula</span>
                      </div>
                      <div className="flex items-center space-x-1.5 text-xs">
                        <span className={`h-1.5 w-1.5 rounded-full ${hasLowercase ? 'bg-emerald-500' : 'bg-zinc-700'}`} />
                        <span className={hasLowercase ? 'text-emerald-400 font-medium' : 'text-zinc-500'}>Minúscula</span>
                      </div>
                      <div className="flex items-center space-x-1.5 text-xs">
                        <span className={`h-1.5 w-1.5 rounded-full ${hasNumber ? 'bg-emerald-500' : 'bg-zinc-700'}`} />
                        <span className={hasNumber ? 'text-emerald-400 font-medium' : 'text-zinc-500'}>Um número</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Submit Button */}
              <button
                type="submit"
                disabled={isLoading}
                className="w-full py-3 bg-linear-to-r from-red-600 to-amber-500 hover:from-red-500 hover:to-amber-400 disabled:opacity-50 text-white rounded-xl text-sm font-semibold shadow-lg shadow-red-600/20 hover:shadow-red-600/35 active:scale-[0.98] transition-all flex items-center justify-center cursor-pointer"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Enviando código de verificação...
                  </>
                ) : (
                  'Continuar para Verificação'
                )}
              </button>

              <div className="text-center text-xs text-zinc-500 mt-4">
                Já possui uma conta?{' '}
                <Link href="/login" className="text-amber-500 hover:text-amber-400 transition-colors font-semibold">
                  Faça login
                </Link>
              </div>
            </form>
          </div>
        )}
      </div>
    </main>
  )
}
