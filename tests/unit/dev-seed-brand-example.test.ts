import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SEED_PATH = join(process.cwd(), 'supabase/seed.sql')
const seed = readFileSync(SEED_PATH, 'utf8')

const CLIENT_QUESTION = 'Olá! Gostaria de saber os valores dos kits de churrasco.'
const EXPECTED_ASSISTANT_MESSAGE =
  'Olá, João! Eu sou a Sofía. Neste exemplo de conversa, os kits variam de R$ 150 a R$ 450. Qual tamanho de evento você planeja?'
const RETIRED_BRAND = 'Asados'
const RETIRED_BRAND_VARIANT = 'Brasa & Sabor'
// Universal demo/test-data claims that describe the whole product or dataset
// instead of the single example conversation in this dev fixture.
const UNIVERSAL_DEMO_CLAIM = /dados de teste|ambiente de demonstra|fictício|ficticio|nenhum negócio real|ambiente de teste/i

function extractRemetenteMessages(sql: string, remetente: 'cliente' | 'ia'): string[] {
  const pattern = new RegExp(`'${remetente}',\\s*\\n\\s*'([^']*)'`, 'g')
  return [...sql.matchAll(pattern)].map((match) => match[1])
}

const clientMessages = extractRemetenteMessages(seed, 'cliente')
const assistantMessages = extractRemetenteMessages(seed, 'ia')
const assistantMessage = assistantMessages[0]

describe('dev seed brand example conversation', () => {
  it('keeps a single seeded example exchange and preserves the client question', () => {
    expect(assistantMessages, 'the dev fixture must hold exactly one assistant example').toHaveLength(1)
    expect(clientMessages).toEqual([CLIENT_QUESTION])
  })

  it('removes the retired Asados brand from the assistant example', () => {
    expect(seed).not.toContain(RETIRED_BRAND)
    expect(seed).not.toContain(RETIRED_BRAND_VARIANT)
    expect(assistantMessage).not.toContain(RETIRED_BRAND)
    expect(assistantMessage).not.toContain(RETIRED_BRAND_VARIANT)
  })

  it('replaces exactly that one assistant example with the approved generic copy', () => {
    expect(assistantMessage).toBe(EXPECTED_ASSISTANT_MESSAGE)
  })

  it('preserves the R$ 150 a R$ 450 price range and the event-size question', () => {
    expect(assistantMessage).toContain('R$ 150 a R$ 450')
    expect(assistantMessage).toContain('Qual tamanho de evento você planeja?')
  })

  it('scopes the example wording and never asserts universal demo or test-data status', () => {
    expect(assistantMessage).toContain('Neste exemplo de conversa')
    expect(assistantMessage).not.toMatch(UNIVERSAL_DEMO_CLAIM)
  })
})
