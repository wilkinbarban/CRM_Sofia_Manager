'use server'

import { getBusinessProfile } from '@/lib/config/business-profile'

export type PerfilPublico = {
  name: string
  shortName: string
  location: string
}

// Somente dados de marca públicos: nenhuma configuração sensível cruza esta borda.
export async function obterPerfilPublico(): Promise<PerfilPublico> {
  const profile = await getBusinessProfile()
  if (!profile || typeof profile.name !== 'string' || !profile.name.trim()) {
    throw new Error('perfil de empresa indisponível')
  }
  return {
    name: profile.name,
    shortName: profile.shortName?.trim() || profile.name,
    location: profile.location?.trim() || '',
  }
}
