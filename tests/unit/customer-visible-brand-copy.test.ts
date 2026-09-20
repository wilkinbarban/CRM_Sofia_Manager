import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Regression guard for issue #197: customer- and operator-visible copy must not
 * resurrect the retired business identity ("Asados") or its location ("Curitiba").
 *
 * Why a source-level test instead of a behavioral import:
 * - `apps/web/src/app/api/webhooks/telegram/route.ts` is a Next.js route handler whose
 *   module scope builds an admin Supabase client, reads system configuration and pulls in
 *   the RAG pipeline. Importing it to reach `MENSAGEM_BOAS_VINDAS` would require a mocked
 *   Next.js/Supabase runtime far larger than the contract under test.
 * - `conhecimento/page.tsx` and `produtos/layout.tsx` are async server components that
 *   call `createClient().auth.getUser()` and `redirect()`, so they cannot render outside
 *   an authenticated request.
 * The observable contract here is the literal copy shipped to users, so asserting on the
 * source text is the honest, focused check.
 *
 * The Telegram webhook keeps legitimate location-domain identifiers such as
 * `normalizeCuritibaPhone` / "padrão de Curitiba" (phone normalization, not customer
 * copy), so its assertion is deliberately scoped to the welcome-message template rather
 * than the whole file.
 */

const TELEGRAM_WEBHOOK = 'apps/web/src/app/api/webhooks/telegram/route.ts'
const CONHECIMENTO_PAGE = 'apps/web/src/app/atendimento/conhecimento/page.tsx'
const PRODUTOS_LAYOUT = 'apps/web/src/app/atendimento/produtos/layout.tsx'
const OPERATOR_CONSOLES = [CONHECIMENTO_PAGE, PRODUTOS_LAYOUT]

const read = (path: string) => readFileSync(path, 'utf8')

/** Extracts the `MENSAGEM_BOAS_VINDAS` template literal body from the webhook source. */
function telegramWelcomeCopy(source: string): string {
  const match = source.match(/const MENSAGEM_BOAS_VINDAS = `([\s\S]*?)`/)
  expect(match, 'telegram webhook must define MENSAGEM_BOAS_VINDAS').not.toBeNull()
  return match![1]
}

describe('customer-visible brand copy', () => {
  it('welcomes Telegram customers with neutral CRM demo copy instead of the retired business', () => {
    const welcome = telegramWelcomeCopy(read(TELEGRAM_WEBHOOK))

    // Truthful demo framing: Sofia is the CRM's virtual attendant and the data is test data.
    expect(welcome).toContain('Sofía')
    expect(welcome).toContain('atendente virtual')
    expect(welcome).toContain('CRM')
    expect(welcome).toContain('dados de teste')

    // No retired business identity, no claimed real steakhouse, no claimed location.
    expect(welcome).not.toContain('Asados')
    expect(welcome).not.toContain('Curitiba')
    expect(welcome).not.toMatch(/churrascaria/i)
  })

  it('labels both operator consoles as the CRM Sofia Manager console', () => {
    for (const path of OPERATOR_CONSOLES) {
      const source = read(path)

      expect(source, path).toContain('Console de Atendimento CRM Sofia Manager')
      expect(source, `${path} must not display the retired brand`).not.toContain('Asados')
      expect(source, `${path} must not display the retired location`).not.toContain('Curitiba')
    }
  })

  it('removes the retired brand everywhere without breaking the Curitiba phone-normalization domain identifier', () => {
    const webhook = read(TELEGRAM_WEBHOOK)

    // Broad guard: no retired brand string survives anywhere in the webhook file.
    expect(webhook).not.toContain('Asados')
    // Over-removal guard: `Curitiba` is a phone-normalization domain identifier, not copy,
    // so a blindly broad deletion of the location string would silently break inbound contacts.
    expect(webhook).toContain('normalizeCuritibaPhone')
  })
})
