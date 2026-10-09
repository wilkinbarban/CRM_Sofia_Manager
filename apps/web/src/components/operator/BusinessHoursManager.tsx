'use client'

import React, { useState, useEffect, useMemo } from 'react'
import { Clock, Loader2, CheckCircle2, AlertTriangle, Save } from 'lucide-react'
import { listarHorarios, salvarHorarioDia, salvarMensagemForaHorario, obterMensagemForaHorario } from '@/app/actions/horarios'
import { formatarMensagemForaHorario } from '@/lib/horarios/formatar'

interface HorarioDia {
  dia_semana: number
  dia_nome: string
  hora_abertura: string
  hora_fechamento: string
  ativo: boolean
}

const HORA_PATTERN = /^\d{2}:\d{2}(:\d{2})?$/

// Edição fluida: o valor digitado vive no rascunho local e só é persistido
// quando o usuário confirma (blur ou Enter), para que cada tecla não dispare um
// salvamento nem desabilite o campo no meio da digitação.
function TimeField({
  label,
  value,
  onCommit,
}: {
  label: string
  value: string
  onCommit: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)
  // Último valor realmente confirmado neste campo: evita reenviar o mesmo
  // rascunho enquanto o salvamento ainda não confirmou (ou foi recusado).
  const [lastCommitted, setLastCommitted] = useState(value)

  useEffect(() => {
    setDraft(value)
    setLastCommitted(value)
  }, [value])

  const commit = () => {
    if (draft === lastCommitted) return
    if (!HORA_PATTERN.test(draft)) {
      setDraft(lastCommitted)
      return
    }
    setLastCommitted(draft)
    onCommit(draft)
  }

  return (
    <input
      type="time"
      aria-label={label}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        }
      }}
      className="w-full px-2 py-1.5 bg-zinc-950 border border-zinc-800 focus:border-amber-500/80 rounded-lg text-xs text-zinc-200 outline-none transition-all disabled:opacity-50"
    />
  )
}

export default function BusinessHoursManager() {
  const [horarios, setHorarios] = useState<HorarioDia[]>([])
  const [rawMensagem, setRawMensagem] = useState('')
  const [loading, setLoading] = useState(true)
  const [savingMensagem, setSavingMensagem] = useState(false)
  const [savingDays, setSavingDays] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const [horariosRes, mensagemRes] = await Promise.all([
          listarHorarios(),
          obterMensagemForaHorario()
        ])

        if (horariosRes.success && horariosRes.data) {
          setHorarios(horariosRes.data)
        } else {
          setError(horariosRes.error || 'Erro ao carregar horários')
        }

        if (mensagemRes.success && mensagemRes.data) {
          setRawMensagem(mensagemRes.data)
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Erro inesperado ao carregar dados')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const handleToggleDay = async (dia: HorarioDia) => {
    const novoAtivo = !dia.ativo
    const newSaving = new Set(savingDays)
    newSaving.add(dia.dia_semana)
    setSavingDays(newSaving)

    const res = await salvarHorarioDia(dia.dia_semana, dia.hora_abertura, dia.hora_fechamento, novoAtivo)

    if (res.success) {
      setHorarios(prev =>
        prev.map(h => h.dia_semana === dia.dia_semana ? { ...h, ativo: novoAtivo } : h)
      )
    } else {
      setError(res.error || 'Erro ao salvar horário')
    }

    const remaining = new Set(newSaving)
    remaining.delete(dia.dia_semana)
    setSavingDays(remaining)
  }

  const handleTimeChange = async (dia: HorarioDia, field: 'hora_abertura' | 'hora_fechamento', value: string) => {
    const updated = horarios.map(h =>
      h.dia_semana === dia.dia_semana ? { ...h, [field]: value } : h
    )
    setHorarios(updated)

    const updatedDay = updated.find(h => h.dia_semana === dia.dia_semana)!
    const newSaving = new Set(savingDays)
    newSaving.add(dia.dia_semana)
    setSavingDays(newSaving)

    const res = await salvarHorarioDia(updatedDay.dia_semana, updatedDay.hora_abertura, updatedDay.hora_fechamento, updatedDay.ativo)

    if (!res.success) {
      setError(res.error || 'Erro ao salvar horário')
    }

    const remaining = new Set(newSaving)
    remaining.delete(dia.dia_semana)
    setSavingDays(remaining)
  }

  const handleSaveMensagem = async () => {
    setSavingMensagem(true)
    setError(null)
    try {
      const res = await salvarMensagemForaHorario(rawMensagem)
      if (res.success) {
        setSuccessMsg('Mensagem salva com sucesso!')
        setTimeout(() => setSuccessMsg(null), 3000)
      } else {
        setError(res.error || 'Erro ao salvar mensagem')
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Erro inesperado')
    } finally {
      setSavingMensagem(false)
    }
  }

  const previewMensagem = useMemo(() => {
    return formatarMensagemForaHorario(rawMensagem, horarios)
  }, [horarios, rawMensagem])

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-20">
        <Loader2 className="h-8 w-8 text-amber-500 animate-spin mb-3" />
        <p className="text-sm text-zinc-400">Carregando horários...</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto space-y-6 p-1">
      <div>
        <h2 className="text-2xl font-bold text-zinc-100 tracking-tight flex items-center gap-2">
          <Clock className="h-6 w-6 text-amber-500" />
          Horário do Atendimento
        </h2>
        <p className="text-sm text-zinc-400 mt-1">
          Configure os dias e horários de funcionamento do atendimento.
        </p>
      </div>

      {error && (
        <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center gap-2.5 text-xs text-red-400 shrink-0">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            className="ml-auto text-red-400 hover:text-red-300 cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      {successMsg && (
        <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg flex items-center gap-2.5 text-xs text-emerald-400 shrink-0">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {horarios.map((dia) => {
          const isSaving = savingDays.has(dia.dia_semana)
          return (
            <div
              key={dia.dia_semana}
              className={`rounded-xl border p-4 transition-all duration-200 ${
                dia.ativo
                  ? 'border-zinc-800 bg-zinc-900/40'
                  : 'border-zinc-800/40 bg-zinc-900/20 opacity-60'
              }`}
            >
              <div className="flex items-center justify-between mb-3">
                <span className={`text-xs font-bold uppercase tracking-wider ${
                  dia.ativo ? 'text-zinc-200' : 'text-zinc-500'
                }`}>
                  {dia.dia_nome}
                </span>

                <div className="relative">
                  {isSaving && (
                    <Loader2 className="absolute -left-5 top-0.5 h-3 w-3 animate-spin text-amber-500" />
                  )}
                  <button
                    type="button"
                    onClick={() => handleToggleDay(dia)}
                    disabled={isSaving}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed ${
                      dia.ativo ? 'bg-emerald-500' : 'bg-zinc-800'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-zinc-950 shadow-lg ring-0 transition duration-200 ease-in-out ${
                        dia.ativo ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
              </div>

              {dia.ativo && (
                <div className="space-y-2">
                  <div>
                    <label className="block text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-1">
                      Abertura
                    </label>
                    <TimeField
                      label="Abertura"
                      value={dia.hora_abertura}
                      onCommit={(value) => handleTimeChange(dia, 'hora_abertura', value)}
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-1">
                      Fechamento
                    </label>
                    <TimeField
                      label="Fechamento"
                      value={dia.hora_fechamento}
                      onCommit={(value) => handleTimeChange(dia, 'hora_fechamento', value)}
                    />
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="border-t border-zinc-800 pt-6 space-y-4 shrink-0">
        <div>
          <h3 className="text-lg font-bold text-zinc-100 mb-1">Mensagem Fora de Horário</h3>
          <p className="text-xs text-zinc-400">
            Esta mensagem é enviada automaticamente quando um cliente tenta contato fora do horário de atendimento.
            Use os placeholders: <code className="text-amber-500 bg-zinc-900 px-1 rounded">{'{grade_horarios}'}</code> (escala detalhada),{' '}
            <code className="text-amber-500 bg-zinc-900 px-1 rounded">{'{grade_horarios_inline}'}</code> (escala em linha),{' '}
            <code className="text-amber-500 bg-zinc-900 px-1 rounded">{'{dias_semana}'}</code>,{' '}
            <code className="text-amber-500 bg-zinc-900 px-1 rounded">{'{horario_inicio}'}</code> e{' '}
            <code className="text-amber-500 bg-zinc-900 px-1 rounded">{'{horario_fim}'}</code>.
          </p>
        </div>
 
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-stretch">
          {/* Coluna 1: Edição da Mensagem */}
          <div className="flex flex-col justify-between space-y-3">
            <textarea
              value={rawMensagem}
              onChange={(e) => setRawMensagem(e.target.value)}
              className="w-full flex-1 min-h-[120px] px-3 py-2 bg-zinc-900/40 border border-zinc-800 focus:border-amber-500/80 rounded-xl text-sm text-zinc-200 placeholder-zinc-600 outline-none transition-all resize-none"
              placeholder="Ex: Olá! Nosso horário de atendimento é:\n{grade_horarios}..."
            />
            <div className="flex justify-end">
              <button
                onClick={handleSaveMensagem}
                disabled={savingMensagem}
                className="flex items-center gap-1.5 px-4.5 py-2.5 bg-amber-500 hover:bg-amber-600 active:scale-95 text-zinc-950 font-bold rounded-xl text-xs transition-all shadow-md shadow-amber-500/10 cursor-pointer disabled:opacity-50"
              >
                {savingMensagem ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Salvando...
                  </>
                ) : (
                  <>
                    <Save className="h-3.5 w-3.5" />
                    Salvar Mensagem
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Coluna 2: Preview da Mensagem */}
          <div className="flex flex-col">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 p-5 flex-1 flex flex-col justify-between">
              <div>
                <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider border-b border-zinc-800/60 pb-2 mb-2 block select-none">
                  Preview da Resposta
                </span>
                <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">
                  {previewMensagem || <span className="text-zinc-600 italic">Escreva uma mensagem para ver o preview...</span>}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
