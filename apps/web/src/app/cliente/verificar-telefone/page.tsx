'use client'

import React, { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { z } from 'zod'
import { Loader2, Smartphone, KeyRound, MessageSquare, ArrowLeft, RefreshCw, CheckCircle } from 'lucide-react'
import { BrandLogo } from '@/components/ui/BrandLogo'
import { resolveBusinessProfileSync } from '@/lib/config/business-profile'

// Phone validation regex for Curitiba DDD 41, prefix 9, and 8 digits (e.g. 55419XXXXXXXX)
// On client, sanitized phone format will be validated
const phoneValidationSchema = z.string()
  .refine(
    (val) => {
      const sanitized = val.replace(/\D/g, '')
      // We allow standard 11 digits: 419XXXXXXXX (will be sent to API)
      return /^419[0-9]{8}$/.test(sanitized)
    },
    { message: 'O telefone deve ser um celular de Curitiba com DDD 41 (ex: 41 9XXXX-XXXX)' }
  )

export default function VerificarTelefonePage() {
  const router = useRouter()
  // Steps: 'phone' | 'otp' | 'verified'
  const [step, setStep] = useState<'phone' | 'otp' | 'verified'>('phone')

  // Inputs
  const [rawPhone, setRawPhone] = useState('')
  const [otpCodes, setOtpCodes] = useState<string[]>(Array(6).fill(''))
  
  // Canal de envio detectado pelo backend ('whatsapp' | 'telegram')
  const [canalEnvio, setCanalEnvio] = useState<'whatsapp' | 'telegram'>('whatsapp')
  
  // States
  const [phoneError, setPhoneError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [apiError, setApiError] = useState<string | null>(null)
  const [resendTimer, setResendTimer] = useState(0)
  
  // Refs for OTP inputs auto-focus movement
  const otpRefs = useRef<(HTMLInputElement | null)[]>([])

  // Decrement resend timer
  useEffect(() => {
    if (resendTimer > 0) {
      const timer = setTimeout(() => setResendTimer(resendTimer - 1), 1000)
      return () => clearTimeout(timer)
    }
  }, [resendTimer])

  // Real-time phone masking: (XX) 9XXXX-XXXX
  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    const numbers = value.replace(/\D/g, '')
    const truncated = numbers.slice(0, 11)

    // Formatter logic
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

    setRawPhone(formatted)
    setPhoneError(null)
    setApiError(null)
  }

  // Send OTP handler
  const handleSendOtp = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    setPhoneError(null)
    setApiError(null)
    setIsLoading(true)

    const sanitized = rawPhone.replace(/\D/g, '')

    // Frontend validation
    const validationResult = phoneValidationSchema.safeParse(sanitized)
    if (!validationResult.success) {
      setPhoneError(validationResult.error.issues[0].message)
      setIsLoading(false)
      return
    }

    try {
      // Call api/auth/otp
      const res = await fetch('/api/auth/otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telefone: sanitized }),
      })

      const data = await res.json()

      if (!res.ok) {
        setApiError(data.error || 'Erro ao enviar o código OTP.')
      } else {
        setCanalEnvio(data.canal || 'whatsapp')
        setStep('otp')
        setResendTimer(60) // 60s cooldown
        // Focus first OTP input on transition
        setTimeout(() => {
          otpRefs.current[0]?.focus()
        }, 100)
      }
    } catch (err) {
      console.error(err)
      setApiError('Não foi possível conectar ao servidor. Tente novamente.')
    } finally {
      setIsLoading(false)
    }
  }

  // OTP inputs key navigation and handling
  const handleOtpChange = (index: number, value: string) => {
    const cleanValue = value.replace(/\D/g, '').slice(-1) // only take last numeric digit
    const newOtpCodes = [...otpCodes]
    newOtpCodes[index] = cleanValue
    setOtpCodes(newOtpCodes)
    setApiError(null)

    // Move focus forward if value entered
    if (cleanValue !== '' && index < 5) {
      otpRefs.current[index + 1]?.focus()
    }

    // Auto submit if all filled
    const fullOtp = newOtpCodes.join('')
    if (fullOtp.length === 6 && index === 5) {
      handleVerifyOtp(newOtpCodes.join(''))
    }
  }

  const handleOtpKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      if (otpCodes[index] === '' && index > 0) {
        // Move focus backward on backspace if current is empty
        const newOtpCodes = [...otpCodes]
        newOtpCodes[index - 1] = ''
        setOtpCodes(newOtpCodes)
        otpRefs.current[index - 1]?.focus()
      } else {
        // Clear current index
        const newOtpCodes = [...otpCodes]
        newOtpCodes[index] = ''
        setOtpCodes(newOtpCodes)
      }
      setApiError(null)
    }
  }

  const handleOtpPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault()
    const pastedData = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
    
    if (pastedData.length === 6) {
      const newOtpCodes = pastedData.split('')
      setOtpCodes(newOtpCodes)
      // Focus last input
      otpRefs.current[5]?.focus()
      handleVerifyOtp(pastedData)
    }
  }

  // Verify OTP handler
  const handleVerifyOtp = async (codeToSubmit?: string) => {
    const code = codeToSubmit || otpCodes.join('')
    if (code.length !== 6) {
      setApiError('Por favor, preencha todos os 6 dígitos do código.')
      return
    }

    setIsLoading(true)
    setApiError(null)

    const sanitizedPhone = rawPhone.replace(/\D/g, '')

    try {
      const res = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telefone: sanitizedPhone,
          codigo: code,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        setApiError(data.error || 'Código incorreto ou inválido.')
      } else {
        setStep('verified')
        // Redirect to chat after 2 seconds
        setTimeout(() => {
          router.push('/cliente/chat')
        }, 2000)
      }
    } catch (err) {
      console.error(err)
      setApiError('Erro de conexão ao verificar o código.')
    } finally {
      setIsLoading(false)
    }
  }

  const handleBackToPhone = () => {
    setStep('phone')
    setOtpCodes(Array(6).fill(''))
    setApiError(null)
  }

  return (
    <main className="min-h-screen w-full flex items-center justify-center bg-radial from-zinc-900 via-zinc-950 to-black p-4 relative overflow-hidden font-sans">
      {/* Glow decorative spheres */}
      <div className="absolute top-0 -left-4 w-96 h-96 bg-red-600/10 rounded-full blur-3xl" />
      <div className="absolute bottom-0 -right-4 w-96 h-96 bg-amber-600/10 rounded-full blur-3xl" />

      <div className="w-full max-w-md z-10 transition-all duration-300">
        {/* Brand header */}
        <div className="flex flex-col items-center mb-8 text-center">
          <BrandLogo size="xl" showSubtitle={false} className="flex-col !gap-3" />
          <p className="text-xs text-amber-500 font-bold tracking-widest uppercase mt-1">
            Verificação segura de acesso
          </p>
          <p className="text-sm text-zinc-400 mt-2 text-center">
            Validação de segurança de celular para clientes de Curitiba
          </p>
        </div>

        {/* STEP 1: Phone input */}
        {step === 'phone' && (
          <div className="backdrop-blur-md bg-zinc-900/50 border border-zinc-800 rounded-2xl p-6 md:p-8 shadow-2xl transition-all duration-300 animate-in fade-in slide-in-from-bottom-5 duration-300">
            <div className="mb-6 flex flex-col items-center text-center">
              <div className="h-12 w-12 bg-amber-500/10 text-amber-500 rounded-full flex items-center justify-center mb-3">
                <Smartphone className="h-6 w-6" />
              </div>
              <h2 className="text-xl font-bold text-white">Número de Telefone</h2>
              <p className="text-xs text-zinc-400 mt-1 max-w-[280px]">
                Enviaremos um código OTP de 6 dígitos para seu número de Curitiba para concluir seu cadastro.
              </p>
            </div>

            <form onSubmit={handleSendOtp} className="space-y-5">
              {apiError && (
                <div className="p-4 bg-red-500/10 border border-red-500/20 text-red-400 text-sm rounded-xl font-medium">
                  {apiError}
                </div>
              )}

              <div className="space-y-2">
                <label className="text-xs uppercase tracking-wider text-zinc-400 font-semibold block" htmlFor="telefone">
                  Celular (Curitiba)
                </label>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-zinc-500 font-medium text-sm">
                    BR
                  </span>
                  <input
                    id="telefone"
                    type="text"
                    required
                    value={rawPhone}
                    onChange={handlePhoneChange}
                    placeholder="(41) 98888-8888"
                    className="w-full pl-10 pr-4 py-3 bg-zinc-950/80 border border-zinc-800 focus:border-amber-500 rounded-xl text-sm text-white placeholder-zinc-500 focus:outline-hidden focus:ring-2 focus:ring-amber-500/20 transition-all font-semibold tracking-wide"
                  />
                </div>
                {phoneError && (
                  <p className="text-xs text-red-500 mt-1 font-medium">{phoneError}</p>
                )}
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full py-3 bg-linear-to-r from-red-600 to-amber-500 hover:from-red-500 hover:to-amber-400 disabled:opacity-50 text-white rounded-xl text-sm font-semibold shadow-lg shadow-red-600/20 hover:shadow-red-600/35 active:scale-[0.98] transition-all flex items-center justify-center cursor-pointer"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Enviando código...
                  </>
                ) : (
                  <>
                    <MessageSquare className="h-4 w-4 mr-2" />
                    Enviar Código
                  </>
                )}
              </button>
            </form>
          </div>
        )}

        {/* STEP 2: OTP input with 6 numeric fields and countdown */}
        {step === 'otp' && (
          <div className="backdrop-blur-md bg-zinc-900/50 border border-zinc-800 rounded-2xl p-6 md:p-8 shadow-2xl transition-all duration-300 animate-in fade-in slide-in-from-bottom-5 duration-300">
            <button
              onClick={handleBackToPhone}
              className="flex items-center space-x-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors mb-6 font-medium cursor-pointer"
            >
              <ArrowLeft className="h-3 w-3" />
              <span>Alterar telefone ({rawPhone})</span>
            </button>

            <div className="mb-6 flex flex-col items-center text-center">
              <div className="h-12 w-12 bg-red-500/10 text-red-500 rounded-full flex items-center justify-center mb-3">
                <KeyRound className="h-6 w-6" />
              </div>
              <h2 className="text-xl font-bold text-white">Insira o código OTP</h2>
              <p className="text-xs text-zinc-400 mt-1 max-w-[280px]">
                Enviamos o código de 6 dígitos{canalEnvio === 'telegram' ? ' via Telegram' : ' via WhatsApp'} para <span className="text-amber-500 font-semibold">{rawPhone}</span>
              </p>
            </div>

            <div className="space-y-6">
              {apiError && (
                <div className="p-4 bg-red-500/10 border border-red-500/20 text-red-400 text-sm rounded-xl font-medium text-center">
                  {apiError}
                </div>
              )}

              {/* 6 Digit Numeric Inputs */}
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
                    className="w-12 h-14 bg-zinc-950/80 border border-zinc-800 focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 text-center text-xl font-bold rounded-xl text-white focus:outline-hidden transition-all"
                  />
                ))}
              </div>

              {/* Countdown timer & resend button */}
              <div className="flex flex-col items-center space-y-3">
                {resendTimer > 0 ? (
                  <p className="text-xs text-zinc-500">
                    Reenviar código em <span className="text-amber-500 font-bold">{resendTimer}s</span>
                  </p>
                ) : (
                  <button
                    onClick={() => handleSendOtp()}
                    disabled={isLoading}
                    className="flex items-center space-x-1.5 text-xs text-amber-500 hover:text-amber-400 disabled:opacity-50 transition-colors font-semibold py-1.5 px-3 bg-amber-500/5 hover:bg-amber-500/10 rounded-lg border border-amber-500/10 cursor-pointer"
                  >
                    <RefreshCw className={`h-3 w-3 ${isLoading ? 'animate-spin' : ''}`} />
                    <span>Reenviar código agora</span>
                  </button>
                )}
              </div>

              <button
                onClick={() => handleVerifyOtp()}
                disabled={isLoading || otpCodes.some((d) => d === '')}
                className="w-full py-3 bg-linear-to-r from-red-600 to-amber-500 hover:from-red-500 hover:to-amber-400 disabled:opacity-50 text-white rounded-xl text-sm font-semibold shadow-lg shadow-red-600/20 active:scale-[0.98] transition-all flex items-center justify-center cursor-pointer"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Validando código...
                  </>
                ) : (
                  'Verificar Código'
                )}
              </button>
            </div>
          </div>
        )}

        {/* STEP 3: Verified Success Animation */}
        {step === 'verified' && (
          <div className="backdrop-blur-md bg-zinc-900/50 border border-zinc-800 rounded-2xl p-8 shadow-2xl flex flex-col items-center text-center animate-in fade-in zoom-in-95 duration-300">
            <div className="h-16 w-16 bg-emerald-500/10 text-emerald-400 rounded-full flex items-center justify-center mb-4">
              <CheckCircle className="h-10 w-10 animate-bounce text-emerald-400" />
            </div>
            <h2 className="text-2xl font-bold text-white mb-2">{canalEnvio === 'telegram' ? 'Telegram' : 'WhatsApp'} Verificado!</h2>
            <p className="text-zinc-300 max-w-[280px]">
              Seu telefone foi vinculado com sucesso à sua conta da {resolveBusinessProfileSync().name}.
            </p>
            <p className="text-xs text-zinc-500 mt-6">
              Carregando suas configurações de cliente...
            </p>
          </div>
        )}
      </div>
    </main>
  )
}
