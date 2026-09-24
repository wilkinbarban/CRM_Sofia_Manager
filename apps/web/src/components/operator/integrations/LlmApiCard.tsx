'use client'

import React, { useCallback, useEffect, useState } from 'react'
import {
  Bot,
  Key,
  Eye,
  EyeOff,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Sparkles,
  Cpu,
} from 'lucide-react'
import { IntegrationCardProps } from './types'
import {
  salvarConfiguracaoAdmin,
  listAuthorizedDeepSeekModels,
  testAuthorizedDeepSeekModel,
} from '@/app/actions/admin'

/** Safe `{ id, label }` projection returned by `listAuthorizedDeepSeekModels`. */
type DeepSeekModelOption = { id: string; label: string }

/**
 * Stable server error codes projected onto operator-facing copy.
 *
 * The dashboard never renders a provider body, a transport message or the key
 * itself: only these mapped strings cross back into the UI, and an unknown code
 * falls back to a generic message instead of leaking the raw value.
 */
const DEEPSEEK_ERROR_MESSAGES: Record<string, string> = {
  DEEPSEEK_NOT_CONFIGURED: 'Nenhuma chave DeepSeek válida está configurada no servidor.',
  DEEPSEEK_TIMEOUT: 'Tempo esgotado ao consultar a DeepSeek.',
  DEEPSEEK_HTTP_ERROR: 'A DeepSeek recusou a consulta de modelos. Verifique a chave configurada.',
  DEEPSEEK_INVALID_RESPONSE: 'A DeepSeek devolveu uma resposta inesperada ao listar modelos.',
  DEEPSEEK_REQUEST_FAILED: 'Falha de rede ao consultar a DeepSeek.',
  DEEPSEEK_MODEL_REQUIRED: 'Selecione um modelo DeepSeek antes de continuar.',
  DEEPSEEK_OPERATOR_FAILED: 'Erro interno ao consultar a DeepSeek.',
  ACESSO_NEGADO_NAO_AUTENTICADO: 'Sessão sem permissão de operador.',
  ACESSO_NEGADO_PERMISSAO_INSUFICIENTE: 'Sessão sem permissão de operador.',
}

const GENERIC_ERROR_MESSAGE = 'Não foi possível concluir a operação com a DeepSeek.'

function safeErrorMessage(code: string | undefined): string {
  if (!code) return GENERIC_ERROR_MESSAGE
  return DEEPSEEK_ERROR_MESSAGES[code] || GENERIC_ERROR_MESSAGE
}

export default function LlmApiCard({ initialConfigs, showToast }: IntegrationCardProps) {
  // The resolved effective model crosses the server boundary as a safe projection.
  // The credential never crosses, and its input starts blank by construction.
  const initialEffectiveModel = initialConfigs?.DEEPSEEK_MODEL?.trim() || ''

  const [apiKey, setApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [effectiveModel, setEffectiveModel] = useState(initialEffectiveModel)
  const [model, setModel] = useState('')
  const [isConfigured, setIsConfigured] = useState(initialConfigs?.DEEPSEEK_CONFIGURED === 'true')

  const [models, setModels] = useState<DeepSeekModelOption[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)

  const [saving, setSaving] = useState(false)
  const [testingModel, setTestingModel] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)

  // Models come from the authorized action only: the card never ships a
  // hard-coded catalog, so a provider-side change cannot desync the UI.
  const loadModels = useCallback(async () => {
    setLoadingModels(true)
    setModelsError(null)

    try {
      const res = await listAuthorizedDeepSeekModels()
      if (res.success && res.models.length > 0) {
        setModels(res.models)
        setModel((current) => {
          if (current && res.models.some((option) => option.id === current)) return current
          if (initialEffectiveModel && res.models.some((option) => option.id === initialEffectiveModel)) {
            return initialEffectiveModel
          }
          return res.models[0]?.id ?? ''
        })
      } else {
        setModels([])
        setModel('')
        if (!res.success) {
          setModelsError(safeErrorMessage(res.error))
        }
      }
    } catch {
      setModels([])
      setModel('')
      setModelsError(GENERIC_ERROR_MESSAGE)
    } finally {
      setLoadingModels(false)
    }
  }, [initialEffectiveModel])

  useEffect(() => {
    void loadModels()
  }, [loadModels])

  useEffect(() => {
    const next = initialConfigs?.DEEPSEEK_MODEL?.trim() || ''
    setEffectiveModel(next)
  }, [initialConfigs?.DEEPSEEK_MODEL])

  // Selectable options come from the authorized server action only: the stored
  // or effective model is rendered separately as a badge/label and never
  // mutates the select options or becomes a locally invented option.
  const modelOptions: DeepSeekModelOption[] = models
  const isEffectiveModelInCatalog = models.some((option) => option.id === effectiveModel)

  const handleTestModel = async () => {
    const trimmedModel = model.trim()
    if (!trimmedModel || modelOptions.length === 0) {
      showToast('error', 'Selecione um modelo DeepSeek antes de testar.')
      return
    }

    setTestingModel(true)
    setTestResult(null)

    try {
      // The probe receives the model only: the server resolves the key.
      const res = await testAuthorizedDeepSeekModel(trimmedModel)
      if (res.success) {
        setTestResult({ success: true, message: `Modelo ${res.model} respondeu com sucesso.` })
        showToast('success', 'Modelo DeepSeek validado com sucesso!')
      } else {
        setTestResult({ success: false, message: safeErrorMessage(res.error) })
        showToast('error', 'Falha ao testar o modelo DeepSeek.')
      }
    } catch {
      setTestResult({ success: false, message: GENERIC_ERROR_MESSAGE })
      showToast('error', 'Erro ao testar o modelo DeepSeek.')
    } finally {
      setTestingModel(false)
    }
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()

    const trimmedKey = apiKey.trim()
    const trimmedModel = modelOptions.length === 0 ? '' : model.trim()

    if (!trimmedKey && !trimmedModel) {
      showToast('error', 'Informe a chave da DeepSeek ou selecione um modelo antes de salvar.')
      return
    }

    setSaving(true)

    try {
      // A blank credential input means "keep the stored key": the server action
      // already preserves secrets on blank, and skipping the call keeps the
      // write path free of empty-secret writes.
      const results: { success: boolean }[] = []
      if (trimmedKey) results.push(await salvarConfiguracaoAdmin('DEEPSEEK_API_KEY', trimmedKey))
      if (trimmedModel) results.push(await salvarConfiguracaoAdmin('DEEPSEEK_MODEL', trimmedModel))

      if (results.some((result) => !result.success)) {
        showToast('error', 'Falha ao salvar as configurações da DeepSeek.')
        return
      }

      if (trimmedKey) {
        setApiKey('')
        setIsConfigured(true)
      }
      if (trimmedModel) {
        setEffectiveModel(trimmedModel)
      }

      showToast('success', 'Configurações da DeepSeek salvas com sucesso!')

      // A freshly stored key changes what the server can list, so refresh.
      if (trimmedKey) await loadModels()
    } catch {
      showToast('error', 'Erro ao salvar as configurações da DeepSeek.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      onSubmit={handleSave}
      className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6 space-y-6 shadow-xl"
    >
      {/* Header com Badge de Status */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-800 pb-5">
        <div className="flex items-center gap-3.5">
          <div className="p-2.5 rounded-xl bg-sky-500/10 border border-sky-500/20 text-sky-400">
            <Cpu className="h-6 w-6" />
          </div>
          <div>
            <h3 className="font-bold text-zinc-100 text-base">DeepSeek — Provedor de IA da Sofía</h3>
            <p className="text-xs text-zinc-400 mt-0.5">
              Chave de API e modelo autorizado, resolvidos e guardados somente no servidor.
            </p>
          </div>
        </div>

        <div>
          {isConfigured ? (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              DeepSeek configurada
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/30">
              <span className="h-2 w-2 rounded-full bg-amber-400" />
              DeepSeek não configurada
            </span>
          )}
        </div>
      </div>

      {/* Credencial write-only */}
      <div className="space-y-1.5">
        <label
          htmlFor="deepseek-api-key"
          className="text-xs font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5"
        >
          <Key className="h-3.5 w-3.5 text-zinc-500" />
          DEEPSEEK_API_KEY (chave de API)
        </label>
        <div className="relative">
          <input
            id="deepseek-api-key"
            type={showApiKey ? 'text' : 'password'}
            placeholder="sk-..."
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="w-full pl-4 pr-11 py-2.5 bg-zinc-950/60 border border-zinc-800 focus:border-sky-500/80 rounded-xl text-sm text-zinc-200 placeholder-zinc-600 outline-none transition-all focus:ring-1 focus:ring-sky-500/30 font-mono text-xs"
          />
          <button
            type="button"
            onClick={() => setShowApiKey(!showApiKey)}
            aria-label={showApiKey ? 'Ocultar chave' : 'Mostrar chave'}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
          >
            {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <p className="text-[11px] text-zinc-500">
          Enviada apenas para o servidor e nunca reexibida: deixe em branco para manter a chave já
          configurada.
        </p>
      </div>

      {/* Modelo autorizado */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <label
            htmlFor="deepseek-model"
            className="text-xs font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5"
          >
            <Bot className="h-3.5 w-3.5 text-sky-500" />
            DEEPSEEK_MODEL (modelo autorizado)
          </label>
          <button
            type="button"
            onClick={() => void loadModels()}
            disabled={loadingModels}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 text-[11px] font-semibold border border-zinc-700 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {loadingModels ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            Recarregar modelos
          </button>
        </div>

        {effectiveModel && (
          <div className="flex items-center gap-2">
            <span
              data-testid="deepseek-effective-model-badge"
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border ${
                !loadingModels && models.length > 0 && !isEffectiveModelInCatalog
                  ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                  : 'bg-zinc-800/60 text-zinc-300 border-zinc-700/60'
              }`}
            >
              <span className="text-zinc-400">Modelo efetivo:</span>
              <span className="font-mono font-semibold text-zinc-100">{effectiveModel}</span>
              {!loadingModels && models.length > 0 && !isEffectiveModelInCatalog && (
                <span className="text-[10px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40">
                  Fora do catálogo
                </span>
              )}
            </span>
          </div>
        )}

        <select
          id="deepseek-model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          disabled={loadingModels || modelOptions.length === 0}
          className="w-full px-3 py-2.5 bg-zinc-950/60 border border-zinc-800 focus:border-sky-500/80 rounded-xl text-xs text-zinc-200 outline-none cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {modelOptions.length === 0 ? (
            <option value="">Nenhum modelo disponível</option>
          ) : (
            modelOptions.map((option) => (
              <option key={option.id} value={option.id} className="bg-zinc-950">
                {option.label}
              </option>
            ))
          )}
        </select>

        {loadingModels && (
          <p className="flex items-center gap-1.5 text-[11px] text-zinc-400">
            <Loader2 className="h-3 w-3 animate-spin" />
            Carregando modelos autorizados...
          </p>
        )}

        {!loadingModels && modelsError && (
          <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-950/20 border border-amber-500/30 text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <p className="text-[11px]">{modelsError}</p>
          </div>
        )}

        {!loadingModels && !modelsError && modelOptions.length === 0 && (
          <div className="flex items-start gap-2 p-3 rounded-xl bg-zinc-950/60 border border-zinc-800 text-zinc-400">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <p className="text-[11px]">
              Nenhum modelo autorizado foi retornado para a chave configurada. Recarregue a lista
              após salvar uma chave válida.
            </p>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 pt-1">
          <p className="text-[11px] text-zinc-500">
            A lista vem da conta DeepSeek configurada no servidor.
          </p>
          <button
            type="button"
            onClick={() => void handleTestModel()}
            disabled={testingModel || loadingModels || model.trim() === '' || modelOptions.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-500/10 hover:bg-sky-500/20 text-sky-400 text-xs font-semibold border border-sky-500/30 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {testingModel ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="h-3 w-3" />
            )}
            Testar modelo
          </button>
        </div>
      </div>

      {/* Resultado do teste do modelo */}
      {testResult && (
        <div
          className={`p-4 rounded-xl border flex items-start gap-2 ${
            testResult.success
              ? 'bg-emerald-950/20 border-emerald-500/30 text-emerald-300'
              : 'bg-rose-950/20 border-rose-500/30 text-rose-300'
          }`}
        >
          {testResult.success ? (
            <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-emerald-400" />
          ) : (
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-rose-400" />
          )}
          <span className="text-xs font-medium">{testResult.message}</span>
        </div>
      )}

      {/* Salvar */}
      <div className="pt-3 border-t border-zinc-800 flex justify-end">
        <button
          type="submit"
          disabled={saving}
          className="flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl bg-sky-500 hover:bg-sky-600 font-bold text-zinc-950 text-xs shadow-lg shadow-sky-500/10 hover:shadow-sky-500/20 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed active:scale-95"
        >
          {saving ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Salvando configurações...
            </>
          ) : (
            'Salvar configurações da DeepSeek'
          )}
        </button>
      </div>
    </form>
  )
}
