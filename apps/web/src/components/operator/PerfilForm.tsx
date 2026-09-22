'use client'

import React, { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  User,
  Mail,
  Shield,
  Key,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Eye,
  EyeOff
} from 'lucide-react'
import { atualizarPerfilProprio, atualizarSenhaPropria } from '@/app/actions/perfil'
import { resolveBusinessProfileSync } from '@/lib/config/business-profile'

interface OperatorInfo {
  id: string
  nome: string
  email: string
  funcao: string
}

interface PerfilFormProps {
  operatorInfo: OperatorInfo
}

export default function PerfilForm({ operatorInfo }: PerfilFormProps) {
  const router = useRouter()

  // Form de Nome
  const [nome, setNome] = useState(operatorInfo.nome)
  const [salvandoNome, setSalvandoNome] = useState(false)

  // Form de Senha
  const [novaSenha, setNovaSenha] = useState('')
  const [confirmarSenha, setConfirmarSenha] = useState('')
  const [salvandoSenha, setSalvandoSenha] = useState(false)
  const [verSenha, setVerSenha] = useState(false)
  const [verConfirmarSenha, setVerConfirmarSenha] = useState(false)

  // Estado de Toast
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  const showToast = (type: 'success' | 'error', message: string) => {
    setToast({ type, message })
    setTimeout(() => {
      setToast(null)
    }, 4000)
  }

  // Validação e envio do nome
  const handleUpdateNome = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!nome.trim()) {
      showToast('error', 'O nome não pode estar em branco.')
      return
    }

    setSalvandoNome(true)
    try {
      const res = await atualizarPerfilProprio(nome)
      if (res.success) {
        showToast('success', 'Nome atualizado com sucesso!')
        router.refresh()
      } else {
        showToast('error', res.error || 'Erro ao atualizar o nome.')
      }
    } catch {
      showToast('error', 'Ocorreu um erro inesperado.')
    } finally {
      setSalvandoNome(false)
    }
  }

  // Validação e envio de senha
  const handleUpdateSenha = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!novaSenha) {
      showToast('error', 'Digite a nova senha.')
      return
    }
    if (novaSenha.length < 6) {
      showToast('error', 'A senha deve conter no mínimo 6 caracteres.')
      return
    }
    if (novaSenha !== confirmarSenha) {
      showToast('error', 'As senhas não coincidem.')
      return
    }

    setSalvandoSenha(true)
    try {
      const res = await atualizarSenhaPropria(novaSenha)
      if (res.success) {
        showToast('success', 'Senha redefinida com sucesso!')
        setNovaSenha('')
        setConfirmarSenha('')
      } else {
        showToast('error', res.error || 'Erro ao atualizar a senha.')
      }
    } catch {
      showToast('error', 'Ocorreu um erro inesperado.')
    } finally {
      setSalvandoSenha(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 md:py-8">
      {/* Toast Alert */}
      {toast && (
        <div
          className={`fixed right-6 top-6 z-[100] flex items-center gap-3 rounded-2xl border px-4 py-3.5 shadow-2xl backdrop-blur-md transition-all duration-300 transform scale-100 translate-y-0 ${
            toast.type === 'success'
              ? 'bg-zinc-900/95 border-emerald-500/30 text-emerald-400 shadow-emerald-950/20'
              : 'bg-zinc-900/95 border-rose-500/30 text-rose-400 shadow-rose-950/20'
          } animate-fade-in`}
        >
          <div className={`p-1.5 rounded-lg ${toast.type === 'success' ? 'bg-emerald-500/10' : 'bg-rose-500/10'}`}>
            {toast.type === 'success' ? (
              <CheckCircle2 className="h-4.5 w-4.5 shrink-0" />
            ) : (
              <AlertTriangle className="h-4.5 w-4.5 shrink-0" />
            )}
          </div>
          <span className="text-xs font-bold text-zinc-100 tracking-wide pr-2">{toast.message}</span>
        </div>
      )}

      <section className="mb-6 rounded-2xl border border-zinc-800 bg-gradient-to-br from-zinc-900/80 to-zinc-950/40 p-5 sm:p-6">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-zinc-100 md:text-3xl">
            Meu Perfil de Operador
          </h1>
          <p className="mt-1 text-xs text-zinc-400">
            Gerencie suas informações de acesso e configurações de segurança na {resolveBusinessProfileSync().name}.
          </p>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Coluna de informações estáticas (Leitura Apenas) */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-6 backdrop-blur">
          <div className="flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-500 shadow-inner">
              <User className="h-8 w-8" />
            </div>
            <h2 className="mt-4 font-bold text-zinc-200 truncate max-w-full">{operatorInfo.nome || 'Operador'}</h2>
            <span className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-500">
              <Shield className="h-3 w-3" />
              {operatorInfo.funcao}
            </span>
          </div>

          <div className="mt-8 space-y-4 border-t border-zinc-800/60 pt-6">
            <div>
              <label className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                E-mail de Acesso
              </label>
              <div className="mt-1 flex items-center gap-2 rounded-lg bg-zinc-950/40 px-3 py-2 text-xs text-zinc-300 border border-zinc-900">
                <Mail className="h-3.5 w-3.5 text-zinc-500 shrink-0" />
                <span className="truncate">{operatorInfo.email}</span>
              </div>
            </div>

            <div>
              <label className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                Função na Empresa
              </label>
              <div className="mt-1 flex items-center gap-2 rounded-lg bg-zinc-950/40 px-3 py-2 text-xs text-zinc-300 border border-zinc-900 capitalize">
                <Shield className="h-3.5 w-3.5 text-zinc-500 shrink-0" />
                <span>{operatorInfo.funcao}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Coluna de formulários editáveis */}
        <div className="space-y-6 lg:col-span-2">
          {/* Form Nome */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-6 backdrop-blur">
            <h3 className="flex items-center gap-2 font-bold text-zinc-200">
              <User className="h-4.5 w-4.5 text-amber-500" />
              Informações do Perfil
            </h3>
            <p className="mt-1 text-xs text-zinc-400">
              Atualize o nome pelo qual você é identificado nas conversas e relatórios.
            </p>

            <form onSubmit={handleUpdateNome} className="mt-6 space-y-4">
              <div>
                <label htmlFor="nome-input" className="text-xs font-bold text-zinc-300">
                  Nome Completo
                </label>
                <div className="mt-1.5 relative">
                  <input
                    id="nome-input"
                    type="text"
                    value={nome}
                    onChange={(e) => setNome(e.target.value)}
                    placeholder="Seu nome completo"
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-950/50 px-4 py-3 text-sm text-zinc-200 placeholder-zinc-600 focus:border-amber-500/50 focus:outline-none focus:ring-1 focus:ring-amber-500/30 transition-all"
                  />
                </div>
              </div>

              <div className="flex justify-end pt-2">
                <button
                  type="submit"
                  disabled={salvandoNome}
                  className="flex items-center justify-center gap-2 rounded-xl bg-amber-500 px-5 py-2.5 text-sm font-bold text-zinc-950 shadow-md shadow-amber-500/10 hover:bg-amber-600 active:scale-[0.98] transition-all disabled:opacity-50 cursor-pointer"
                >
                  {salvandoNome ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Salvando...
                    </>
                  ) : (
                    'Salvar Alterações'
                  )}
                </button>
              </div>
            </form>
          </div>

          {/* Form Senha */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-6 backdrop-blur">
            <h3 className="flex items-center gap-2 font-bold text-zinc-200">
              <Key className="h-4.5 w-4.5 text-amber-500" />
              Alterar Senha de Acesso
            </h3>
            <p className="mt-1 text-xs text-zinc-400">
              Altere sua senha periodicamente para manter a conta segura. Requer no mínimo 6 caracteres.
            </p>

            <form onSubmit={handleUpdateSenha} className="mt-6 space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="senha-input" className="text-xs font-bold text-zinc-300">
                    Nova Senha
                  </label>
                  <div className="mt-1.5 relative">
                    <input
                      id="senha-input"
                      type={verSenha ? 'text' : 'password'}
                      value={novaSenha}
                      onChange={(e) => setNovaSenha(e.target.value)}
                      placeholder="••••••••"
                      className="w-full rounded-xl border border-zinc-800 bg-zinc-950/50 pl-4 pr-10 py-3 text-sm text-zinc-200 placeholder-zinc-650 focus:border-amber-500/50 focus:outline-none focus:ring-1 focus:ring-amber-500/30 transition-all"
                    />
                    <button
                      type="button"
                      onClick={() => setVerSenha(!verSenha)}
                      className="absolute right-3 top-3.5 text-zinc-500 hover:text-zinc-300"
                    >
                      {verSenha ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label htmlFor="confirmar-senha-input" className="text-xs font-bold text-zinc-300">
                    Confirmar Nova Senha
                  </label>
                  <div className="mt-1.5 relative">
                    <input
                      id="confirmar-senha-input"
                      type={verConfirmarSenha ? 'text' : 'password'}
                      value={confirmarSenha}
                      onChange={(e) => setConfirmarSenha(e.target.value)}
                      placeholder="••••••••"
                      className="w-full rounded-xl border border-zinc-800 bg-zinc-950/50 pl-4 pr-10 py-3 text-sm text-zinc-200 placeholder-zinc-650 focus:border-amber-500/50 focus:outline-none focus:ring-1 focus:ring-amber-500/30 transition-all"
                    />
                    <button
                      type="button"
                      onClick={() => setVerConfirmarSenha(!verConfirmarSenha)}
                      className="absolute right-3 top-3.5 text-zinc-500 hover:text-zinc-300"
                    >
                      {verConfirmarSenha ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex justify-end pt-2">
                <button
                  type="submit"
                  disabled={salvandoSenha}
                  className="flex items-center justify-center gap-2 rounded-xl bg-amber-500 px-5 py-2.5 text-sm font-bold text-zinc-950 shadow-md shadow-amber-500/10 hover:bg-amber-600 active:scale-[0.98] transition-all disabled:opacity-50 cursor-pointer"
                >
                  {salvandoSenha ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Alterando Senha...
                    </>
                  ) : (
                    'Atualizar Senha'
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  )
}
