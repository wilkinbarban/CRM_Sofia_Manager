'use client'

import React, { useState } from 'react'
import { Key, Server, Eye, EyeOff, Loader2, CheckCircle2, AlertTriangle, MessageSquare, QrCode } from 'lucide-react'
import { IntegrationCardProps } from './types'
import { 
  salvarConfiguracaoAdmin, 
  testarConexaoMeta, 
  testarConexaoEvolution, 
  obterQrCodeEvolution 
} from '@/app/actions/admin'

interface WhatsAppCardProps extends IntegrationCardProps {
  provedorAtivo: 'meta' | 'evolution'
  onProvedorChange: (provider: 'meta' | 'evolution') => void
}

export default function WhatsAppCard({ 
  initialConfigs, 
  showToast, 
  provedorAtivo, 
  onProvedorChange 
}: WhatsAppCardProps) {
  // Meta state
  const [accessToken, setAccessToken] = useState(initialConfigs?.WHATSAPP_ACCESS_TOKEN || '')
  const [phoneNumberId, setPhoneNumberId] = useState(initialConfigs?.WHATSAPP_PHONE_NUMBER_ID || '')
  const [appSecret, setAppSecret] = useState(initialConfigs?.WHATSAPP_APP_SECRET || '')
  const [verifyToken, setVerifyToken] = useState(initialConfigs?.WHATSAPP_VERIFY_TOKEN || '')
  
  const [showAccessToken, setShowAccessToken] = useState(false)
  const [showAppSecret, setShowAppSecret] = useState(false)
  const [showVerifyToken, setShowVerifyToken] = useState(false)

  // Evolution state
  const [apiUrl, setApiUrl] = useState(initialConfigs?.EVOLUTION_API_URL || '')
  const [apiKey, setApiKey] = useState(initialConfigs?.EVOLUTION_API_KEY || '')
  const [instanceName, setInstanceName] = useState(initialConfigs?.EVOLUTION_INSTANCE_NAME || '')
  const [showApiKey, setShowApiKey] = useState(false)

  // Meta connection test states
  const [testingMeta, setTestingMeta] = useState(false)
  const [metaTestResult, setMetaTestResult] = useState<{ success: boolean; message: string } | null>(null)

  // Evolution connection test states
  const [testingEvolution, setTestingEvolution] = useState(false)
  const [evolutionTestResult, setEvolutionTestResult] = useState<{ success: boolean; message: string } | null>(null)
  
  // QR Code states
  const [generatingQr, setGeneratingQr] = useState(false)
  const [qrCodeData, setQrCodeData] = useState<string | null>(null)

  // General state
  const [saving, setSaving] = useState(false)

  const handleToggleProvider = async (newProvider: 'meta' | 'evolution') => {
    if (newProvider === provedorAtivo) return
    try {
      const res = await salvarConfiguracaoAdmin('WHATSAPP_PROVIDER', newProvider)
      if (res.success) {
        onProvedorChange(newProvider)
        showToast('success', `Provedor de WhatsApp alterado para: ${newProvider === 'meta' ? 'Meta Cloud API' : 'Evolution API'}`)
      } else {
        showToast('error', 'Falha ao salvar a alteração de provedor no banco.')
      }
    } catch (err) {
      console.error(err)
      showToast('error', 'Erro ao processar alteração de provedor.')
    }
  }

  const handleTestMeta = async () => {
    if (!accessToken || accessToken.trim() === '') {
      showToast('error', 'Por favor, insira o WHATSAPP_ACCESS_TOKEN antes de testar.')
      return
    }
    if (!phoneNumberId || phoneNumberId.trim() === '') {
      showToast('error', 'Por favor, insira o WHATSAPP_PHONE_NUMBER_ID antes de testar.')
      return
    }
    setTestingMeta(true)
    setMetaTestResult(null)
    try {
      const res = await testarConexaoMeta(accessToken, phoneNumberId)
      if (res.success) {
        setMetaTestResult({
          success: true,
          message: `Conexão OK! Telefone: ${res.display_phone_number} | Nome: ${res.verified_name}`
        })
        showToast('success', 'Conexão com Meta verificada com sucesso!')
      } else {
        setMetaTestResult({
          success: false,
          message: res.error || 'Erro na verificação do token ou ID de telefone.'
        })
        showToast('error', 'Falha ao conectar com a Graph API.')
      }
    } catch (err: any) {
      console.error(err)
      setMetaTestResult({
        success: false,
        message: 'Erro interno de conexão no teste.'
      })
      showToast('error', 'Erro ao testar API do WhatsApp.')
    } finally {
      setTestingMeta(false)
    }
  }

  const handleTestEvolution = async () => {
    if (!apiUrl || apiUrl.trim() === '') {
      showToast('error', 'Por favor, insira a URL da API antes de testar.')
      return
    }
    if (!apiKey || apiKey.trim() === '') {
      showToast('error', 'Por favor, insira a API Key antes de testar.')
      return
    }
    if (!instanceName || instanceName.trim() === '') {
      showToast('error', 'Por favor, insira o nome da instância antes de testar.')
      return
    }

    setTestingEvolution(true)
    setEvolutionTestResult(null)
    try {
      const res = await testarConexaoEvolution(apiUrl, apiKey, instanceName)
      if (res.success) {
        setEvolutionTestResult({
          success: true,
          message: `Conexão bem-sucedida! Instância: "${instanceName}" está ativa/conectada.`
        })
        showToast('success', 'Instância conectada com sucesso!')
      } else {
        setEvolutionTestResult({
          success: false,
          message: res.error || 'Não foi possível se conectar à instância. Verifique se está ativa no Docker.'
        })
        showToast('error', 'Falha na conexão com a instância.')
      }
    } catch (err: any) {
      console.error(err)
      setEvolutionTestResult({
        success: false,
        message: 'Erro interno de conexão ao testar Evolution API.'
      })
      showToast('error', 'Erro ao testar a Evolution API.')
    } finally {
      setTestingEvolution(false)
    }
  }

  const handleGetQrCode = async () => {
    if (!apiUrl || apiUrl.trim() === '') {
      showToast('error', 'Insira a URL do Evolution API.')
      return
    }
    if (!apiKey || apiKey.trim() === '') {
      showToast('error', 'Insira a API Key.')
      return
    }
    if (!instanceName || instanceName.trim() === '') {
      showToast('error', 'Insira o nome da instância.')
      return
    }

    setGeneratingQr(true)
    setQrCodeData(null)
    try {
      const res = await obterQrCodeEvolution(apiUrl, apiKey, instanceName)
      if (res.success && res.qrcode) {
        setQrCodeData(res.qrcode)
        showToast('success', 'QR Code gerado com sucesso! Escaneie no WhatsApp.')
      } else {
        showToast('error', res.error || 'Erro ao gerar QR Code. Certifique-se de que a instância não está conectada.')
      }
    } catch (err) {
      console.error(err)
      showToast('error', 'Erro interno ao obter QR Code.')
    } finally {
      setGeneratingQr(false)
    }
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    const entries = provedorAtivo === 'meta'
      ? [
          ['WHATSAPP_ACCESS_TOKEN', accessToken],
          ['WHATSAPP_PHONE_NUMBER_ID', phoneNumberId],
          ['WHATSAPP_APP_SECRET', appSecret],
          ['WHATSAPP_VERIFY_TOKEN', verifyToken],
        ] as const
      : [
          ['EVOLUTION_API_URL', apiUrl],
          ['EVOLUTION_API_KEY', apiKey],
          ['EVOLUTION_INSTANCE_NAME', instanceName],
        ] as const
    try {
      const results = await Promise.all(entries.map(([key, value]) => salvarConfiguracaoAdmin(key, value)))
      if (results.some(result => !result.success)) {
        showToast('error', `Falha ao salvar a configuração da ${provedorAtivo === 'meta' ? 'Meta' : 'Evolution'}.`)
      } else {
        showToast('success', `Configuração da ${provedorAtivo === 'meta' ? 'Meta' : 'Evolution'} salva com sucesso!`)
      }
    } catch (err) {
      console.error(err)
      showToast('error', 'Erro ao salvar as configurações no servidor.')
    } finally {
      setSaving(false)
    }
  }

  const isMetaActive = provedorAtivo === 'meta'
  const isEvolutionActive = provedorAtivo === 'evolution'

  return (
    <form onSubmit={handleSave} className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-6 space-y-6 transition-all hover:border-zinc-700/50">
      <div className="flex items-center justify-between border-b border-zinc-800 pb-4">
        <div className="flex items-center gap-3">
          <MessageSquare className="h-6 w-6 text-amber-500" />
          <div>
            <h3 className="font-bold text-zinc-200">WhatsApp Integration</h3>
            <p className="text-xs text-zinc-500 mt-0.5">Configure e gerencie o envio de mensagens do sistema via Meta Cloud API ou Evolution API.</p>
          </div>
        </div>
      </div>

      {/* Provedor Ativo Switcher */}
      <div className="bg-zinc-950/40 p-4 rounded-xl border border-zinc-800 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-300">Canal de Envio Ativo</h4>
          <p className="text-xs text-zinc-500 mt-0.5">Selecione qual infraestrutura de WhatsApp deve ser usada pelo sistema.</p>
        </div>
        <div role="radiogroup" aria-label="Provedor ativo do WhatsApp" className="flex items-center bg-zinc-900 p-1.5 rounded-lg border border-zinc-800 shrink-0 select-none">
          <button
            type="button"
            role="radio"
            aria-checked={isMetaActive}
            onClick={() => handleToggleProvider('meta')}
            className={`px-3 py-1.5 rounded text-xs font-semibold transition-all cursor-pointer ${
              isMetaActive ? 'bg-amber-500 text-zinc-950 shadow' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Meta Cloud API
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={isEvolutionActive}
            onClick={() => handleToggleProvider('evolution')}
            className={`px-3 py-1.5 rounded text-xs font-semibold transition-all cursor-pointer ${
              isEvolutionActive ? 'bg-amber-500 text-zinc-950 shadow' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Evolution API
          </button>
        </div>
      </div>

      <div className="space-y-8">
        {isMetaActive && <section className="space-y-4" aria-labelledby="meta-config-title">
          <div className="flex items-center gap-2 border-b border-zinc-800/50 pb-2">
            <span className={`h-2 w-2 rounded-full ${isMetaActive ? 'bg-amber-500 animate-pulse' : 'bg-zinc-600'}`} />
            <h4 id="meta-config-title" className="text-sm font-bold text-zinc-300">Configuração da Meta Cloud API</h4>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2 md:col-span-2">
              <label htmlFor="meta-access-token" className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                <Key className="h-3 w-3 text-zinc-500" />
                Token de acesso da Meta
              </label>
              <div className="relative">
                <input
                  id="meta-access-token"
                  type={showAccessToken ? 'text' : 'password'}
                  placeholder="EAA..."
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  className="w-full pl-4 pr-10 py-2 bg-zinc-900/40 border border-zinc-850 focus:border-amber-500/80 rounded-xl text-xs text-zinc-200 placeholder-zinc-700 outline-none transition-all focus:ring-1 focus:ring-amber-500/30 disabled:cursor-not-allowed"
                />
                <button
                  type="button"
                  onClick={() => setShowAccessToken(!showAccessToken)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-50"
                >
                  {showAccessToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="meta-phone-number-id" className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                <Server className="h-3 w-3 text-zinc-500" />
                ID do número de telefone
              </label>
              <input
                  id="meta-phone-number-id"
                type="text"
                placeholder="Ex: 1092837465"
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
                className="w-full px-4 py-2 bg-zinc-900/40 border border-zinc-850 focus:border-amber-500/80 rounded-xl text-xs text-zinc-200 placeholder-zinc-700 outline-none transition-all focus:ring-1 focus:ring-amber-500/30 disabled:cursor-not-allowed"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="meta-app-secret" className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                <Key className="h-3 w-3 text-zinc-500" />
                Segredo do aplicativo Meta
              </label>
              <div className="relative">
                <input
                  id="meta-app-secret"
                  type={showAppSecret ? 'text' : 'password'}
                  placeholder="Chave secreta do app Meta"
                  value={appSecret}
                  onChange={(e) => setAppSecret(e.target.value)}
                  className="w-full pl-4 pr-10 py-2 bg-zinc-900/40 border border-zinc-850 focus:border-amber-500/80 rounded-xl text-xs text-zinc-200 placeholder-zinc-700 outline-none transition-all focus:ring-1 focus:ring-amber-500/30 disabled:cursor-not-allowed"
                />
                <button
                  type="button"
                  onClick={() => setShowAppSecret(!showAppSecret)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-50"
                >
                  {showAppSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div className="space-y-2 md:col-span-2">
              <label htmlFor="meta-verify-token" className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                <Key className="h-3 w-3 text-zinc-500" />
                Token de verificação do webhook
              </label>
              <div className="relative">
                <input
                  id="meta-verify-token"
                  type={showVerifyToken ? 'text' : 'password'}
                  placeholder="Token de verificação do Webhook"
                  value={verifyToken}
                  onChange={(e) => setVerifyToken(e.target.value)}
                  className="w-full pl-4 pr-10 py-2 bg-zinc-900/40 border border-zinc-850 focus:border-amber-500/80 rounded-xl text-xs text-zinc-200 placeholder-zinc-700 outline-none transition-all focus:ring-1 focus:ring-amber-500/30 disabled:cursor-not-allowed"
                />
                <button
                  type="button"
                  onClick={() => setShowVerifyToken(!showVerifyToken)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-50"
                >
                  {showVerifyToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {/* Test connection for Meta */}
            <div className="md:col-span-2 flex flex-col sm:flex-row items-stretch sm:items-center gap-4 bg-zinc-950/20 p-3 rounded-xl border border-zinc-850">
              <button
                type="button"
                onClick={handleTestMeta}
                disabled={testingMeta}
                className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-zinc-900 hover:bg-zinc-850 text-amber-500 hover:text-amber-400 font-semibold text-xs border border-zinc-800 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {testingMeta ? <Loader2 className="h-3 w-3 animate-spin" /> : <Server className="h-3 w-3" />}
                Testar Conexão Meta
              </button>

              {metaTestResult && (
                <div className={`text-xs font-medium flex items-center gap-1.5 ${metaTestResult.success ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {metaTestResult.success ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
                  <span>{metaTestResult.message}</span>
                </div>
              )}
            </div>
          </div>
        </section>}

        {isEvolutionActive && <section className="space-y-4" aria-labelledby="evolution-config-title">
          <div className="flex items-center gap-2 border-b border-zinc-800/50 pb-2">
            <span className={`h-2 w-2 rounded-full ${isEvolutionActive ? 'bg-amber-500 animate-pulse' : 'bg-zinc-600'}`} />
            <h4 id="evolution-config-title" className="text-sm font-bold text-zinc-300">Configuração da Evolution API</h4>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2 md:col-span-2">
              <label htmlFor="evolution-api-url" className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                <Server className="h-3 w-3 text-zinc-500" />
                URL da Evolution API
              </label>
              <input
                  id="evolution-api-url"
                type="text"
                placeholder="Ex: http://localhost:8080 ou https://sua-api.com/evolution"
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                className="w-full px-4 py-2 bg-zinc-900/40 border border-zinc-850 focus:border-amber-500/80 rounded-xl text-xs text-zinc-200 placeholder-zinc-700 outline-none transition-all focus:ring-1 focus:ring-amber-500/30 disabled:cursor-not-allowed"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="evolution-api-key" className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                <Key className="h-3 w-3 text-zinc-500" />
                Chave da Evolution API
              </label>
              <div className="relative">
                <input
                  id="evolution-api-key"
                  type={showApiKey ? 'text' : 'password'}
                  placeholder="Chave global configurada na Evolution API"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="w-full pl-4 pr-10 py-2 bg-zinc-900/40 border border-zinc-850 focus:border-amber-500/80 rounded-xl text-xs text-zinc-200 placeholder-zinc-700 outline-none transition-all focus:ring-1 focus:ring-amber-500/30 disabled:cursor-not-allowed"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-50"
                >
                  {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="evolution-instance-name" className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                <Server className="h-3 w-3 text-zinc-500" />
                Nome da instância
              </label>
              <input
                  id="evolution-instance-name"
                type="text"
                placeholder="Ex: sofia-instance"
                value={instanceName}
                onChange={(e) => setInstanceName(e.target.value)}
                className="w-full px-4 py-2 bg-zinc-900/40 border border-zinc-855 focus:border-amber-500/80 rounded-xl text-xs text-zinc-200 placeholder-zinc-700 outline-none transition-all focus:ring-1 focus:ring-amber-500/30 disabled:cursor-not-allowed"
              />
            </div>

            {/* Test and QR connection for Evolution */}
            <div className="md:col-span-2 flex flex-col items-stretch gap-4 bg-zinc-950/20 p-3 rounded-xl border border-zinc-850">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleTestEvolution}
                  disabled={testingEvolution || generatingQr}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-900 hover:bg-zinc-850 text-amber-500 hover:text-amber-400 font-semibold text-xs border border-zinc-800 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {testingEvolution ? <Loader2 className="h-3 w-3 animate-spin" /> : <Server className="h-3 w-3" />}
                  Testar Conexão Evolution
                </button>
                <button
                  type="button"
                  onClick={handleGetQrCode}
                  disabled={generatingQr || testingEvolution}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-900 hover:bg-zinc-850 text-zinc-300 hover:text-zinc-200 font-semibold text-xs border border-zinc-800 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {generatingQr ? <Loader2 className="h-3 w-3 animate-spin" /> : <QrCode className="h-3 w-3" />}
                  Obter QR Code
                </button>
              </div>

              {evolutionTestResult && (
                <div className={`text-xs font-medium flex items-center gap-1.5 ${evolutionTestResult.success ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {evolutionTestResult.success ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
                  <span>{evolutionTestResult.message}</span>
                </div>
              )}

              {qrCodeData && (
                <div className="bg-zinc-950 p-3 rounded-lg border border-zinc-800 flex flex-col items-center gap-2">
                  <span className="text-[10px] text-zinc-400 font-medium">Escaneie o QR Code abaixo com o seu WhatsApp Web:</span>
                  <div className="p-2 bg-white rounded-lg">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={qrCodeData.startsWith('data:') ? qrCodeData : `data:image/png;base64,${qrCodeData}`}
                      alt="QR Code"
                      className="w-40 h-40 block"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setQrCodeData(null)}
                    className="text-[10px] text-zinc-500 hover:text-zinc-400 underline transition-colors"
                  >
                    Ocultar QR Code
                  </button>
                </div>
              )}
            </div>
          </div>
        </section>}
      </div>

      {/* Save configurations button */}
      <div className="pt-4 border-t border-zinc-800 flex justify-end">
        <button
          type="submit"
          disabled={saving}
          className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 font-bold text-zinc-950 text-xs shadow-lg shadow-amber-500/10 hover:shadow-amber-500/20 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed active:scale-95"
        >
          {saving ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Salvando...
            </>
          ) : (
            provedorAtivo === 'meta' ? 'Salvar configuração da Meta' : 'Salvar configuração da Evolution'
          )}
        </button>
      </div>
    </form>
  )
}
