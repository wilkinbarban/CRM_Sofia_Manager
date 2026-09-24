import { describe, expect, it } from 'vitest'
import * as telegramRoute from '@/app/api/webhooks/telegram/route'
import {
  buildTelegramContactConfirmationMessage,
  obterMensagemBoasVindasTelegram,
} from '@/lib/telegram/messages'
import {
  buildTelegramCatalogCard,
  buildTelegramCatalogPromptMessage,
} from '@/lib/telegram/catalog'
import type { ProdutoCardapio } from '@/lib/cardapio/formatar'
import {
  DEFAULT_BUSINESS_PROFILE,
  type BusinessProfile,
} from '@/lib/config/business-profile'

describe('Telegram webhook route export surface', () => {
  it('exposes only the POST handler so Next route-type validation stays valid', () => {
    // Next 16 generates .next/types/.../route.ts, which asserts that
    // `typeof import(route)` extends RouteHandlerConfig (HTTP verbs only).
    // Any extra export (such as a shared helper) fails the production build
    // with TS2344, so helpers must live in lib/telegram/messages.ts.
    expect(Object.keys(telegramRoute).sort()).toEqual(['POST'])
  })
})

describe('dynamic Telegram welcome brand copy', () => {
  const customProfile: BusinessProfile = {
    name: 'Padaria Estrela',
    shortName: 'Estrela',
    location: 'Batel, Curitiba - PR',
    pickupAddress: 'Rua das Flores, 123',
    description: 'Panificadora e confeitaria artesanal.',
    personaRole: 'confeiteira chefe e anfitriã de atendimento',
  }

  it('asserts dynamic Telegram welcome has no steakhouse emoji or demo-only text and reflects profile fields', () => {
    const welcome = obterMensagemBoasVindasTelegram(customProfile)

    // Must not contain steakhouse / barbecue emojis or legacy steakhouse keywords
    expect(welcome).not.toMatch(/[🍖🥩🔥]/u)
    expect(welcome.toLowerCase()).not.toMatch(/churrasco|churrascaria|costela|picanha/)

    // Must not contain demo-only or test-only text
    expect(welcome.toLowerCase()).not.toMatch(
      /ambiente de demonstração|ambiente de demonstracao|dados de teste|fictício|ficticio|nenhum negócio real|nenhum negocio real/,
    )

    // Must reflect profile attributes: personaRole, name, location, and shortName brand
    expect(welcome).toContain(customProfile.personaRole)
    expect(welcome).toContain(customProfile.name)
    expect(welcome).toContain(customProfile.location)
    expect(welcome).toContain(customProfile.shortName)
  })

  it('leaves the Telegram phone-sharing workflow intact', () => {
    const welcome = obterMensagemBoasVindasTelegram(customProfile)

    // Phone-sharing workflow instructions must remain intact
    expect(welcome).toContain('compartilhe seu número de telefone')
    expect(welcome).toContain('Toque no botão abaixo para compartilhar')
  })

  it('exports obterMensagemBoasVindasTelegram from lib/telegram/messages.ts', () => {
    expect(typeof obterMensagemBoasVindasTelegram).toBe('function')
  })

  it('reflects DEFAULT_BUSINESS_PROFILE without steakhouse emoji when defaults are used', () => {
    const welcome = obterMensagemBoasVindasTelegram(DEFAULT_BUSINESS_PROFILE)

    expect(welcome).not.toMatch(/[🍖🥩🔥]/u)
    expect(welcome).toContain(DEFAULT_BUSINESS_PROFILE.personaRole)
    expect(welcome).toContain(DEFAULT_BUSINESS_PROFILE.location)
    expect(welcome).toContain(DEFAULT_BUSINESS_PROFILE.name)
  })
})

describe('generic Telegram contact and catalog copy', () => {
  it('confirms a shared phone number without steakhouse framing', () => {
    const confirmation = buildTelegramContactConfirmationMessage('Ana')

    expect(confirmation).toContain('Ana')
    expect(confirmation).not.toMatch(/[🍖🥩🔥]/u)
    expect(confirmation.toLowerCase()).not.toMatch(/churrasco|churrascaria|costela|picanha/)
  })

  it('keeps the keyword catalog prompt neutral and free of official-combo framing', () => {
    const prompt = buildTelegramCatalogPromptMessage()

    expect(prompt.text).not.toMatch(/[🍖🥩🔥]/u)
    expect(prompt.text.toLowerCase()).not.toMatch(/churrasco|churrascaria|costela|picanha/)
    expect(prompt.text.toLowerCase()).not.toContain('oficiais')
    expect(prompt.text).toContain('catálogo')

    // The single opt-in button is preserved so explicit selection stays intact.
    expect(prompt.reply_markup.inline_keyboard).toEqual([
      [{ text: 'Ver catálogo', callback_data: 'catalog:view' }],
    ])
  })

  it('uses a neutral product-description fallback in the catalog card caption', () => {
    const card = buildTelegramCatalogCard({
      id: 'product-1',
      nome: 'Item de exemplo',
      descricao: '',
      preco_centavos: 1000,
      quantidade_estoque: 1,
      url_imagem: null,
    } satisfies ProdutoCardapio)

    expect(card.caption).not.toMatch(/[🍖🥩🔥]/u)
    expect(card.caption.toLowerCase()).not.toMatch(/assado|domingo|churrasco|churrascaria/)
    expect(card.caption).toContain('Item de exemplo')
    // Callback wiring for the real add/details flow is unchanged.
    expect(card.reply_markup.inline_keyboard[0][0].callback_data).toBe('catalog:add:product-1')
    expect(card.reply_markup.inline_keyboard[0][1].callback_data).toBe('catalog:details:product-1')
  })
})
