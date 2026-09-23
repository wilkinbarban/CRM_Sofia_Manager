'use client'

import React, { useState } from 'react'
import {
  Building2,
  MapPin,
  Bot,
  FileText,
  Loader2,
  CheckCircle2,
  RotateCcw,
  Sparkles,
  Store,
  Info,
} from 'lucide-react'
import { salvarConfiguracaoAdmin } from '@/app/actions/admin'
import {
  BUSINESS_PROFILE_CONFIG_KEYS,
  DEFAULT_BUSINESS_PROFILE,
  type BusinessProfile,
} from '@/lib/config/business-profile'

export interface BusinessProfileCardProps {
  initialConfigs?: Record<string, string>
  showToast: (type: 'success' | 'error', msg: string) => void
  onProfileSaved?: (profile: BusinessProfile) => void
}

export default function BusinessProfileCard({
  initialConfigs,
  showToast,
  onProfileSaved,
}: BusinessProfileCardProps) {
  const [name, setName] = useState(
    initialConfigs?.[BUSINESS_PROFILE_CONFIG_KEYS.name]?.trim() || DEFAULT_BUSINESS_PROFILE.name,
  )
  const [shortName, setShortName] = useState(
    initialConfigs?.[BUSINESS_PROFILE_CONFIG_KEYS.shortName]?.trim() || DEFAULT_BUSINESS_PROFILE.shortName,
  )
  const [location, setLocation] = useState(
    initialConfigs?.[BUSINESS_PROFILE_CONFIG_KEYS.location]?.trim() || DEFAULT_BUSINESS_PROFILE.location,
  )
  const [pickupAddress, setPickupAddress] = useState(
    initialConfigs?.[BUSINESS_PROFILE_CONFIG_KEYS.pickupAddress]?.trim() || DEFAULT_BUSINESS_PROFILE.pickupAddress,
  )
  const [description, setDescription] = useState(
    initialConfigs?.[BUSINESS_PROFILE_CONFIG_KEYS.description]?.trim() || DEFAULT_BUSINESS_PROFILE.description,
  )
  const [personaRole, setPersonaRole] = useState(
    initialConfigs?.[BUSINESS_PROFILE_CONFIG_KEYS.personaRole]?.trim() || DEFAULT_BUSINESS_PROFILE.personaRole,
  )

  const [saving, setSaving] = useState(false)
  const [lastSavedProfile, setLastSavedProfile] = useState<BusinessProfile | null>(null)

  const handleResetToDefaults = () => {
    setName(DEFAULT_BUSINESS_PROFILE.name)
    setShortName(DEFAULT_BUSINESS_PROFILE.shortName)
    setLocation(DEFAULT_BUSINESS_PROFILE.location)
    setPickupAddress(DEFAULT_BUSINESS_PROFILE.pickupAddress)
    setDescription(DEFAULT_BUSINESS_PROFILE.description)
    setPersonaRole(DEFAULT_BUSINESS_PROFILE.personaRole)
    showToast('success', 'Valores restaurados para o padrão de fábrica.')
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    const trimmedName = name.trim() || DEFAULT_BUSINESS_PROFILE.name
    const trimmedShortName = shortName.trim() || DEFAULT_BUSINESS_PROFILE.shortName
    const trimmedLocation = location.trim() || DEFAULT_BUSINESS_PROFILE.location
    const trimmedPickupAddress = pickupAddress.trim() || DEFAULT_BUSINESS_PROFILE.pickupAddress
    const trimmedDescription = description.trim() || DEFAULT_BUSINESS_PROFILE.description
    const trimmedPersonaRole = personaRole.trim() || DEFAULT_BUSINESS_PROFILE.personaRole

    setSaving(true)

    try {
      const results = await Promise.all([
        salvarConfiguracaoAdmin(BUSINESS_PROFILE_CONFIG_KEYS.name, trimmedName),
        salvarConfiguracaoAdmin(BUSINESS_PROFILE_CONFIG_KEYS.shortName, trimmedShortName),
        salvarConfiguracaoAdmin(BUSINESS_PROFILE_CONFIG_KEYS.location, trimmedLocation),
        salvarConfiguracaoAdmin(BUSINESS_PROFILE_CONFIG_KEYS.pickupAddress, trimmedPickupAddress),
        salvarConfiguracaoAdmin(BUSINESS_PROFILE_CONFIG_KEYS.description, trimmedDescription),
        salvarConfiguracaoAdmin(BUSINESS_PROFILE_CONFIG_KEYS.personaRole, trimmedPersonaRole),
      ])

      const failed = results.find((res) => !res.success)
      if (failed) {
        showToast('error', failed.error || 'Erro ao salvar configurações da empresa.')
        return
      }

      const updatedProfile: BusinessProfile = {
        name: trimmedName,
        shortName: trimmedShortName,
        location: trimmedLocation,
        pickupAddress: trimmedPickupAddress,
        description: trimmedDescription,
        personaRole: trimmedPersonaRole,
      }

      setLastSavedProfile(updatedProfile)
      onProfileSaved?.(updatedProfile)
      showToast('success', 'Perfil da empresa salvo com sucesso!')
    } catch (err: any) {
      showToast('error', err?.message || 'Falha inesperada ao salvar configurações.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto space-y-6 max-w-5xl">
      {/* Header do Card */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-800/80 pb-5">
        <div className="flex items-start gap-3.5">
          <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-2xl text-amber-400 shrink-0">
            <Building2 className="h-6 w-6" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-zinc-100 flex items-center gap-2">
              Perfil da Empresa & Identidade Comercial
              <span className="rounded-full bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 text-[10px] font-bold text-amber-400 uppercase tracking-wider">
                Operação
              </span>
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Personalize o nome fantasia, marca, endereço de retirada e o papel da assistente virtual em todos os canais de atendimento.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleResetToDefaults}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs font-semibold text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 transition-colors cursor-pointer disabled:opacity-50"
            title="Preenche os campos com os valores padrão pré-configurados"
          >
            <RotateCcw className="h-3.5 w-3.5 text-zinc-400" />
            <span>Restaurar Padrões</span>
          </button>
        </div>
      </div>

      {/* Live Preview / Resumo Atual */}
      <div className="rounded-2xl border border-zinc-800 bg-gradient-to-br from-zinc-900/70 via-zinc-900/30 to-zinc-950 p-5 backdrop-blur-sm">
        <div className="flex items-center justify-between gap-2 mb-3">
          <span className="text-[11px] font-bold uppercase tracking-wider text-amber-400/90 flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5" />
            Prévia da Identidade em Produção
          </span>
          {lastSavedProfile && (
            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400 font-medium">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Sincronizado
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
          <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-3">
            <span className="text-zinc-500 font-medium text-[11px] block">Nome & Marca</span>
            <span className="font-bold text-zinc-200 mt-1 block truncate">
              {name || DEFAULT_BUSINESS_PROFILE.name}
            </span>
            <span className="text-amber-400 font-semibold text-[11px]">
              ({shortName || DEFAULT_BUSINESS_PROFILE.shortName})
            </span>
          </div>

          <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-3">
            <span className="text-zinc-500 font-medium text-[11px] block">Localização & Balcão</span>
            <span className="font-bold text-zinc-200 mt-1 block truncate">
              {location || DEFAULT_BUSINESS_PROFILE.location}
            </span>
            <span className="text-zinc-400 text-[11px] block truncate">
              {pickupAddress || DEFAULT_BUSINESS_PROFILE.pickupAddress}
            </span>
          </div>

          <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-3">
            <span className="text-zinc-500 font-medium text-[11px] block">Identidade Sofía</span>
            <span className="font-bold text-zinc-200 mt-1 block truncate">
              Sofía (Assistente IA)
            </span>
            <span className="text-zinc-400 text-[11px] block truncate">
              {personaRole || DEFAULT_BUSINESS_PROFILE.personaRole}
            </span>
          </div>
        </div>
      </div>

      {/* Regra de Validação Regional (Informativo) */}
      <div className="rounded-xl bg-amber-500/5 border border-amber-500/20 p-3.5 flex items-start gap-3">
        <Info className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
        <div className="text-xs text-zinc-300 leading-relaxed">
          <span className="font-semibold text-amber-300">Validação Regional Preservada:</span>{' '}
          A validação de telefones dos clientes e operadores continua restrita aos números de Curitiba e Região Metropolitana (DDD 41, formato <code>55419XXXXXXXX</code>), garantindo conformidade com a regra de banco <code>chk_telefone_curitiba</code>.
        </div>
      </div>

      {/* Formulário de Edição */}
      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Nome do Estabelecimento */}
          <div className="space-y-1.5">
            <label htmlFor="businessName" className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
              <Store className="h-3.5 w-3.5 text-amber-400" />
              Nome do Estabelecimento / Razão Social
            </label>
            <input
              id="businessName"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex: CRM Sofia Manager"
              required
              className="w-full rounded-xl border border-zinc-800 bg-zinc-900/60 px-3.5 py-2.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-amber-500 focus:outline-none transition-colors"
            />
            <p className="text-[11px] text-zinc-500">
              Nome completo exibido em comprovantes oficiais (PDF/SVG), cabeçalhos de tela e faturas.
            </p>
          </div>

          {/* Nome Curto / Marca */}
          <div className="space-y-1.5">
            <label htmlFor="businessShortName" className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-amber-400" />
              Nome Curto (Marca)
            </label>
            <input
              id="businessShortName"
              type="text"
              value={shortName}
              onChange={(e) => setShortName(e.target.value)}
              placeholder="Ex: Sofia CRM"
              required
              className="w-full rounded-xl border border-zinc-800 bg-zinc-900/60 px-3.5 py-2.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-amber-500 focus:outline-none transition-colors"
            />
            <p className="text-[11px] text-zinc-500">
              Usado em saudações de WhatsApp, mensagens de código OTP e canais onde o texto é compacto.
            </p>
          </div>

          {/* Localização / Praça */}
          <div className="space-y-1.5">
            <label htmlFor="businessLocation" className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
              <MapPin className="h-3.5 w-3.5 text-amber-400" />
              Localização / Cidade Base
            </label>
            <input
              id="businessLocation"
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Ex: Curitiba - PR"
              required
              className="w-full rounded-xl border border-zinc-800 bg-zinc-900/60 px-3.5 py-2.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-amber-500 focus:outline-none transition-colors"
            />
            <p className="text-[11px] text-zinc-500">
              Cidade ou praça comercial utilizada para contextualizar a IA e saudações aos clientes.
            </p>
          </div>

          {/* Endereço de Retirada */}
          <div className="space-y-1.5">
            <label htmlFor="businessPickupAddress" className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
              <Building2 className="h-3.5 w-3.5 text-amber-400" />
              Endereço de Retirada (Balcão)
            </label>
            <input
              id="businessPickupAddress"
              type="text"
              value={pickupAddress}
              onChange={(e) => setPickupAddress(e.target.value)}
              placeholder="Ex: Balcão Principal - Rua Central, 100"
              required
              className="w-full rounded-xl border border-zinc-800 bg-zinc-900/60 px-3.5 py-2.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-amber-500 focus:outline-none transition-colors"
            />
            <p className="text-[11px] text-zinc-500">
              Endereço físico informado ao cliente para retirada dos pedidos no balcão da loja.
            </p>
          </div>
        </div>

        {/* Papel da Persona Sofia */}
        <div className="space-y-1.5">
          <label htmlFor="sofiaPersonaRole" className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
            <Bot className="h-3.5 w-3.5 text-amber-400" />
            Papel da Persona Sofía
          </label>
          <input
            id="sofiaPersonaRole"
            type="text"
            value={personaRole}
            onChange={(e) => setPersonaRole(e.target.value)}
            placeholder="Ex: consultora gastronômica virtual e anfitriã de atendimento"
            required
            className="w-full rounded-xl border border-zinc-800 bg-zinc-900/60 px-3.5 py-2.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-amber-500 focus:outline-none transition-colors"
          />
          <p className="text-[11px] text-zinc-500">
            Define institucionalmente o papel da atendente virtual no início do Master System Prompt da IA.
          </p>
        </div>

        {/* Objeto Social / Descrição */}
        <div className="space-y-1.5">
          <label htmlFor="businessDescription" className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
            <FileText className="h-3.5 w-3.5 text-amber-400" />
            Objeto Social / Descrição do Negócio
          </label>
          <textarea
            id="businessDescription"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Ex: Plataforma omnichannel de atendimento inteligente e gestão de pedidos."
            required
            className="w-full rounded-xl border border-zinc-800 bg-zinc-900/60 px-3.5 py-2.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-amber-500 focus:outline-none transition-colors resize-none"
          />
          <p className="text-[11px] text-zinc-500">
            Resumo das operações e propósito do negócio para registro operacional.
          </p>
        </div>

        {/* Botão de Salvar */}
        <div className="flex justify-end pt-4 border-t border-zinc-800/80">
          <button
            type="submit"
            disabled={saving}
            className="flex items-center gap-2 rounded-xl bg-amber-500 hover:bg-amber-600 text-zinc-950 px-6 py-2.5 text-xs font-bold shadow-lg shadow-amber-500/10 active:scale-95 transition-all cursor-pointer disabled:opacity-50"
          >
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin text-zinc-950" />
                <span>Salvando Configurações...</span>
              </>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4 text-zinc-950" />
                <span>Salvar Perfil da Empresa</span>
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  )
}
