import type { BusinessProfile } from '@/lib/config/business-profile'

/**
 * Customer-facing Telegram copy helpers live here instead of in the webhook
 * route module. Next 16 generates route type validators that only accept HTTP
 * verb exports, so any extra export on `route.ts` breaks the production build.
 */
export function obterMensagemBoasVindasTelegram(profile: BusinessProfile): string {
  const brand = profile.shortName || profile.name
  const role = profile.personaRole || 'assistente virtual'
  return `*Olá! Seja bem-vindo(a) à ${brand}!*

Sou a Sofía, ${role} da ${profile.name} em ${profile.location}. 😊

Para continuar o atendimento e personalizar sua experiência, preciso que você compartilhe seu número de telefone. É rapidinho!

👇 *Toque no botão abaixo para compartilhar:*`
}

export function buildTelegramContactConfirmationMessage(contatoNome: string): string {
  return `✅ *Obrigado, ${contatoNome}!* Seu número foi registrado.

Como posso te ajudar hoje? 😊`
}
