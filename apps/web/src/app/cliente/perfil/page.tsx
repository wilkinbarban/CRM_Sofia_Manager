'use client'

import React, { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/client'
import ClientFactsSection from '@/components/cliente/ClientFactsSection'
import { 
  User, Mail, Home, Phone, Lock, Loader2, 
  Save, CheckCircle2, AlertCircle, X, KeyRound, RefreshCw 
} from 'lucide-react'

// Validation schemas using Zod
const perfilSchema = z.object({
  nome: z.string().min(3, 'O nome deve ter pelo menos 3 caracteres'),
  endereco: z.string().min(5, 'O endereço deve ser detalhado (mínimo 5 caracteres)'),
  senha: z.string().optional().refine(
    (val) => {
      if (!val) return true // Optional field
      return val.length >= 8 && /[A-Z]/.test(val) && /[a-z]/.test(val) && /[0-9]/.test(val)
    },
    { message: 'A nova senha deve ter no mínimo 8 caracteres, contendo letra maiúscula, minúscula e número' }
  )
})

const telefoneSchema = z.string().refine(
  (val) => {
    const sanitized = val.replace(/\D/g, '')
    return /^419[0-9]{8}$/.test(sanitized)
  },
  { message: 'Telefone inválido. Deve ser um celular de Curitiba com DDD 41 (ex: 41 9XXXX-XXXX)' }
)

export default function PerfilPage() {
  const { push } = useRouter()
  const [supabase] = useState(createClient)

  // Session & User State
  const [userId, setUserId] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [originalTelefone, setOriginalTelefone] = useState('')
  // Sem registro em `clientes` nao existe proprietario de fatos: a secao nao chega a montar, e o
  // gate de verificacao de telefone continua sendo exatamente o mesmo (push para verificar-telefone).
  const [possuiCadastro, setPossuiCadastro] = useState(false)

  // Form Fields
  const [nome, setNome] = useState('')
  const [endereco, setEndereco] = useState('')
  const [telefone, setTelefone] = useState('')
  const [senha, setSenha] = useState('')

  // UI States
  const [isPageLoading, setIsPageLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<'nome' | 'endereco' | 'senha' | 'telefone', string>>>({})

  // OTP Modal States (for phone changes)
  const [showOtpModal, setShowOtpModal] = useState(false)
  const [newTelefoneToVerify, setNewTelefoneToVerify] = useState('')
  const [otpCodes, setOtpCodes] = useState<string[]>(Array(6).fill(''))
  const [isOtpLoading, setIsOtpLoading] = useState(false)
  const [otpError, setOtpError] = useState<string | null>(null)
  const [resendTimer, setResendTimer] = useState(0)
  
  const otpRefs = useRef<(HTMLInputElement | null)[]>([])

  // Format phone to (XX) 9XXXX-XXXX
  const formatPhone = (value: string) => {
    let numbers = value.replace(/\D/g, '')
    // Remove BR country code if present at the start (55)
    if (numbers.length === 13 && numbers.startsWith('55')) {
      numbers = numbers.slice(2)
    }
    const truncated = numbers.slice(0, 11)

    let formatted = ''
    if (truncated.length > 0) {
      formatted = `(${truncated.slice(0, 2)}`
    }
    if (truncated.length > 2) {
      formatted += `) ${truncated.slice(2, 3)}`
    }
    if (truncated.length > 3) {
      formatted += ` ${truncated.slice(3, 7)}`
    }
    if (truncated.length > 7) {
      formatted += `-${truncated.slice(7)}`
    }
    return formatted
  }

  // Decrement OTP resend timer
  useEffect(() => {
    if (resendTimer > 0) {
      const timer = setTimeout(() => setResendTimer(resendTimer - 1), 1000)
      return () => clearTimeout(timer)
    }
  }, [resendTimer])

  // Load user data on mount
  useEffect(() => {
    async function fetchUserData() {
      setIsPageLoading(true)
      try {
        const { data: { user }, error: userError } = await supabase.auth.getUser()

        if (userError || !user) {
          push('/login?erro=nao-autorizado')
          return
        }

        setUserId(user.id)
        setEmail(user.email || '')

        // Fetch profiles
        const { data: perfil } = await supabase
          .from('perfis')
          .select('nome')
          .eq('id', user.id)
          .single()

        if (perfil) {
          setNome(perfil.nome)
        }

        // Fetch clientes (phone, address)
        const { data: cliente } = await supabase
          .from('clientes')
          .select('telefone, endereco')
          .eq('usuario_id', user.id)
          .single()

        if (cliente) {
          const formattedPhone = formatPhone(cliente.telefone)
          setTelefone(formattedPhone)
          setOriginalTelefone(formattedPhone)
          setEndereco(cliente.endereco || '')
          setPossuiCadastro(true)
        } else {
          setPossuiCadastro(false)
          // If no client record exists, redirect to verify phone page
          push('/cliente/verificar-telefone')
        }
      } catch (err) {
        console.error('Erro ao buscar dados do cliente:', err)
        setErrorMsg('Erro ao carregar as informações do seu perfil.')
      } finally {
        setIsPageLoading(false)
      }
    }

    fetchUserData()
  }, [push, supabase])

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTelefone(formatPhone(e.target.value))
    setFieldErrors((prev) => ({ ...prev, telefone: undefined }))
  }

  // Main Submit Handler (Profile save)
  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault()
    setSuccessMsg(null)
    setErrorMsg(null)
    setFieldErrors({})
    setIsSaving(true)

    // 1. Zod profile validation
    const profileValidation = perfilSchema.safeParse({ nome, endereco, senha })
    if (!profileValidation.success) {
      const errors: any = {}
      profileValidation.error.issues.forEach((issue) => {
        errors[issue.path[0]] = issue.message
      })
      setFieldErrors(errors)
      setIsSaving(false)
      return
    }

    // 2. Validate phone format if changed
    const phoneChanged = telefone !== originalTelefone
    let sanitizedNewPhone = ''

    if (phoneChanged) {
      sanitizedNewPhone = telefone.replace(/\D/g, '')
      const phoneValidation = telefoneSchema.safeParse(sanitizedNewPhone)
      if (!phoneValidation.success) {
        setFieldErrors((prev) => ({ ...prev, telefone: phoneValidation.error.issues[0].message }))
        setIsSaving(false)
        return
      }
    }

    try {
      if (!userId) return

      // A) Update base user profile name
      const { error: updatePerfilError } = await supabase
        .from('perfis')
        .update({ nome })
        .eq('id', userId)

      if (updatePerfilError) throw updatePerfilError

      // B) Update client record (except phone if changed)
      const { error: updateClienteError } = await supabase
        .from('clientes')
        .update({
          nome,
          endereco,
        })
        .eq('usuario_id', userId)

      if (updateClienteError) throw updateClienteError

      // C) Update password if provided
      if (senha) {
        const { error: updatePasswordError } = await supabase.auth.updateUser({
          password: senha,
        })
        if (updatePasswordError) throw updatePasswordError
        setSenha('') // Clear password field on success
      }

      // D) Check if phone needs validation modal
      if (phoneChanged) {
        // Trigger OTP flow for the new number
        setNewTelefoneToVerify(sanitizedNewPhone)
        
        // Trigger API to send verification code
        const res = await fetch('/api/auth/otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ telefone: sanitizedNewPhone }),
        })

        const data = await res.json()
        if (!res.ok) {
          setErrorMsg(data.error || 'Erro ao iniciar a validação do novo telefone.')
          setIsSaving(false)
          return
        }

        // Open OTP Verification Modal
        setOtpCodes(Array(6).fill(''))
        setOtpError(null)
        setResendTimer(60)
        setShowOtpModal(true)
        
        setTimeout(() => {
          otpRefs.current[0]?.focus()
        }, 100)
      } else {
        setSuccessMsg('Configurações salvas com sucesso!')
      }

    } catch (err: any) {
      console.error('Erro ao atualizar perfil:', err)
      setErrorMsg(err.message || 'Ocorreu um erro ao salvar as alterações.')
    } finally {
      setIsSaving(false)
    }
  }

  // OTP Modal functions
  const handleOtpChange = (index: number, value: string) => {
    const cleanValue = value.replace(/\D/g, '').slice(-1)
    const newOtpCodes = [...otpCodes]
    newOtpCodes[index] = cleanValue
    setOtpCodes(newOtpCodes)
    setOtpError(null)

    if (cleanValue !== '' && index < 5) {
      otpRefs.current[index + 1]?.focus()
    }

    const fullOtp = newOtpCodes.join('')
    if (fullOtp.length === 6 && index === 5) {
      handleVerifyNewPhone(newOtpCodes.join(''))
    }
  }

  const handleOtpKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      if (otpCodes[index] === '' && index > 0) {
        const newOtpCodes = [...otpCodes]
        newOtpCodes[index - 1] = ''
        setOtpCodes(newOtpCodes)
        otpRefs.current[index - 1]?.focus()
      } else {
        const newOtpCodes = [...otpCodes]
        newOtpCodes[index] = ''
        setOtpCodes(newOtpCodes)
      }
      setOtpError(null)
    }
  }

  const handleOtpPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault()
    const pastedData = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
    
    if (pastedData.length === 6) {
      const newOtpCodes = pastedData.split('')
      setOtpCodes(newOtpCodes)
      otpRefs.current[5]?.focus()
      handleVerifyNewPhone(pastedData)
    }
  }

  // Resend OTP in modal
  const handleResendOtp = async () => {
    setOtpError(null)
    setIsOtpLoading(true)

    try {
      const res = await fetch('/api/auth/otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telefone: newTelefoneToVerify }),
      })

      const data = await res.json()
      if (!res.ok) {
        setOtpError(data.error || 'Erro ao reenviar o código.')
      } else {
        setResendTimer(60)
      }
    } catch {
      setOtpError('Erro de conexão ao reenviar código.')
    } finally {
      setIsOtpLoading(false)
    }
  }

  // Verify the OTP code for the new phone
  const handleVerifyNewPhone = async (codeToSubmit?: string) => {
    const code = codeToSubmit || otpCodes.join('')
    if (code.length !== 6) {
      setOtpError('Digite todos os 6 dígitos do código.')
      return
    }

    setIsOtpLoading(true)
    setOtpError(null)

    try {
      const res = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telefone: newTelefoneToVerify,
          codigo: code,
          endereco: endereco
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        setOtpError(data.error || 'Código incorreto ou expirado.')
      } else {
        setShowOtpModal(false)
        const formattedNewPhone = formatPhone(newTelefoneToVerify)
        setOriginalTelefone(formattedNewPhone)
        setTelefone(formattedNewPhone)
        setSuccessMsg('Número de telefone atualizado e verificado com sucesso!')
      }
    } catch (err) {
      console.error(err)
      setOtpError('Erro ao verificar o código.')
    } finally {
      setIsOtpLoading(false)
    }
  }

  if (isPageLoading) {
    return (
      <div className="flex-1 bg-zinc-950 flex items-center justify-center p-8">
        <div className="flex flex-col items-center space-y-4">
          <Loader2 className="h-10 w-10 text-amber-500 animate-spin" />
          <p className="text-sm text-zinc-400">Carregando configurações de perfil...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 max-w-2xl w-full mx-auto px-4 py-8 md:py-12 overflow-y-auto">
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-white">Minhas Configurações</h2>
          <p className="text-sm text-zinc-400 mt-1">
            Gerencie seus dados cadastrais, endereço de entrega e senha
          </p>
        </div>

        <div className="backdrop-blur-md bg-zinc-900/30 border border-zinc-900 rounded-2xl p-6 md:p-8 shadow-xl">
          <form onSubmit={handleSaveProfile} className="space-y-6">
            {/* Success notifications */}
            {successMsg && (
              <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm rounded-xl font-medium flex items-start space-x-2 animate-in fade-in duration-300">
                <CheckCircle2 className="h-5 w-5 shrink-0 mt-0.5" />
                <span>{successMsg}</span>
              </div>
            )}

            {/* Error notification */}
            {errorMsg && (
              <div className="p-4 bg-red-500/10 border border-red-500/20 text-red-400 text-sm rounded-xl font-medium flex items-start space-x-2 animate-in fade-in duration-300">
                <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
                <span>{errorMsg}</span>
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
                  className="w-full pl-10 pr-4 py-3 bg-zinc-950/80 border border-zinc-900 focus:border-amber-500 rounded-xl text-sm text-white placeholder-zinc-500 focus:outline-hidden focus:ring-2 focus:ring-amber-500/20 transition-all font-medium"
                />
              </div>
              {fieldErrors.nome && (
                <p className="text-xs text-red-500 mt-1 font-medium">{fieldErrors.nome}</p>
              )}
            </div>

            {/* Email (Read Only) */}
            <div className="space-y-2">
              <label className="text-xs uppercase tracking-wider text-zinc-500 font-semibold block" htmlFor="email">
                E-mail (Não modificável)
              </label>
              <div className="relative">
                <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-zinc-600">
                  <Mail className="h-4 w-4" />
                </span>
                <input
                  id="email"
                  type="email"
                  disabled
                  value={email}
                  className="w-full pl-10 pr-4 py-3 bg-zinc-950/40 border border-zinc-950 text-zinc-500 rounded-xl text-sm font-medium cursor-not-allowed select-none"
                />
              </div>
            </div>

            {/* Curitiba Phone field with dynamic verification validation */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs uppercase tracking-wider text-zinc-400 font-semibold block" htmlFor="telefone">
                  Telefone WhatsApp (Curitiba)
                </label>
                {telefone !== originalTelefone && (
                  <span className="text-[10px] bg-amber-500/10 text-amber-500 font-bold px-2 py-0.5 rounded-full uppercase tracking-wider animate-pulse">
                    Requer validação
                  </span>
                )}
              </div>
              <div className="relative">
                <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-zinc-500">
                  <Phone className="h-4 w-4" />
                </span>
                <input
                  id="telefone"
                  type="text"
                  required
                  value={telefone}
                  onChange={handlePhoneChange}
                  placeholder="(41) 98888-8888"
                  className="w-full pl-10 pr-4 py-3 bg-zinc-950/80 border border-zinc-900 focus:border-amber-500 rounded-xl text-sm text-white placeholder-zinc-500 focus:outline-hidden focus:ring-2 focus:ring-amber-500/20 transition-all font-semibold"
                />
              </div>
              {fieldErrors.telefone && (
                <p className="text-xs text-red-500 mt-1 font-medium">{fieldErrors.telefone}</p>
              )}
              <p className="text-[10px] text-zinc-500">
                Alterações no telefone disparam a validação OTP. O número anterior permanecerá ativo no banco de dados até a conclusão.
              </p>
            </div>

            {/* Delivery Address Field */}
            <div className="space-y-2">
              <label className="text-xs uppercase tracking-wider text-zinc-400 font-semibold block" htmlFor="endereco">
                Endereço de Entrega
              </label>
              <div className="relative">
                <span className="absolute top-3.5 left-3 text-zinc-500">
                  <Home className="h-4 w-4" />
                </span>
                <textarea
                  id="endereco"
                  required
                  rows={3}
                  value={endereco}
                  onChange={(e) => setEndereco(e.target.value)}
                  placeholder="Rua, número, complemento e bairro (Curitiba)"
                  className="w-full pl-10 pr-4 py-3 bg-zinc-950/80 border border-zinc-900 focus:border-amber-500 rounded-xl text-sm text-white placeholder-zinc-500 focus:outline-hidden focus:ring-2 focus:ring-amber-500/20 transition-all font-medium resize-none"
                />
              </div>
              {fieldErrors.endereco && (
                <p className="text-xs text-red-500 mt-1 font-medium">{fieldErrors.endereco}</p>
              )}
            </div>

            {/* Password update (optional) */}
            <div className="space-y-2 border-t border-zinc-900 pt-6">
              <label className="text-xs uppercase tracking-wider text-zinc-400 font-semibold block" htmlFor="senha">
                Alterar Senha (Opcional)
              </label>
              <div className="relative">
                <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-zinc-500">
                  <Lock className="h-4 w-4" />
                </span>
                <input
                  id="senha"
                  type="password"
                  value={senha}
                  onChange={(e) => setSenha(e.target.value)}
                  placeholder="Preencha apenas se quiser alterar a senha"
                  className="w-full pl-10 pr-4 py-3 bg-zinc-950/80 border border-zinc-900 focus:border-amber-500 rounded-xl text-sm text-white placeholder-zinc-500 focus:outline-hidden focus:ring-2 focus:ring-amber-500/20 transition-all font-medium"
                />
              </div>
              {fieldErrors.senha && (
                <p className="text-xs text-red-500 mt-1 font-medium">{fieldErrors.senha}</p>
              )}
            </div>

            {/* Submit button */}
            <button
              type="submit"
              disabled={isSaving}
              className="w-full py-3 bg-linear-to-r from-red-600 to-amber-500 hover:from-red-500 hover:to-amber-400 disabled:opacity-50 text-white rounded-xl text-sm font-semibold shadow-lg shadow-red-600/10 hover:shadow-red-600/20 active:scale-[0.98] transition-all flex items-center justify-center cursor-pointer"
            >
              {isSaving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Salvando alterações...
                </>
              ) : (
                <>
                  <Save className="h-4 w-4 mr-2" />
                  Salvar Alterações
                </>
              )}
            </button>
          </form>
        </div>

        {possuiCadastro && <ClientFactsSection />}
      </div>

      {/* OTP VALIDATION MODAL */}
      {showOtpModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs animate-in fade-in duration-300">
          <div className="w-full max-w-md bg-zinc-950 border border-zinc-900 rounded-2xl p-6 md:p-8 shadow-2xl relative animate-in zoom-in-95 duration-200">
            {/* Close button */}
            <button
              onClick={() => setShowOtpModal(false)}
              className="absolute top-4 right-4 text-zinc-500 hover:text-zinc-300 transition-colors p-1 cursor-pointer"
            >
              <X className="h-5 w-5" />
            </button>

            <div className="mb-6 flex flex-col items-center text-center">
              <div className="h-12 w-12 bg-amber-500/10 text-amber-500 rounded-full flex items-center justify-center mb-3">
                <KeyRound className="h-6 w-6" />
              </div>
              <h3 className="text-xl font-bold text-white">Validar Novo Telefone</h3>
              <p className="text-xs text-zinc-400 mt-1 max-w-[280px]">
                Enviamos o código OTP para confirmar a alteração para <span className="text-amber-500 font-semibold">{formatPhone(newTelefoneToVerify)}</span>
              </p>
            </div>

            <div className="space-y-6">
              {otpError && (
                <div className="p-4 bg-red-500/10 border border-red-500/20 text-red-400 text-sm rounded-xl font-medium text-center">
                  {otpError}
                </div>
              )}

              {/* 6 Digit Input boxes */}
              <div className="flex justify-between items-center gap-2">
                {otpCodes.map((digit, idx) => (
                  <input
                    key={idx}
                    ref={(el) => { otpRefs.current[idx] = el }}
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={1}
                    value={digit}
                    onChange={(e) => handleOtpChange(idx, e.target.value)}
                    onKeyDown={(e) => handleOtpKeyDown(idx, e)}
                    onPaste={idx === 0 ? handleOtpPaste : undefined}
                    className="w-12 h-14 bg-zinc-900 border border-zinc-800 focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 text-center text-xl font-bold rounded-xl text-white focus:outline-hidden transition-all"
                  />
                ))}
              </div>

              {/* Resend timer */}
              <div className="flex flex-col items-center space-y-3">
                {resendTimer > 0 ? (
                  <p className="text-xs text-zinc-500">
                    Reenviar código em <span className="text-amber-500 font-bold">{resendTimer}s</span>
                  </p>
                ) : (
                  <button
                    onClick={handleResendOtp}
                    disabled={isOtpLoading}
                    className="flex items-center space-x-1.5 text-xs text-amber-500 hover:text-amber-400 disabled:opacity-50 transition-colors font-semibold py-1.5 px-3 bg-amber-500/5 hover:bg-amber-500/10 rounded-lg border border-amber-500/10 cursor-pointer"
                  >
                    <RefreshCw className={`h-3 w-3 ${isOtpLoading ? 'animate-spin' : ''}`} />
                    <span>Reenviar código</span>
                  </button>
                )}
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setShowOtpModal(false)}
                  className="flex-1 py-3 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 rounded-xl text-sm font-semibold transition-colors cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  onClick={() => handleVerifyNewPhone()}
                  disabled={isOtpLoading || otpCodes.some((d) => d === '')}
                  className="flex-1 py-3 bg-linear-to-r from-red-600 to-amber-500 hover:from-red-500 hover:to-amber-400 disabled:opacity-50 text-white rounded-xl text-sm font-semibold shadow-lg shadow-red-600/10 active:scale-[0.98] transition-all flex items-center justify-center cursor-pointer"
                >
                  {isOtpLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    'Confirmar'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
