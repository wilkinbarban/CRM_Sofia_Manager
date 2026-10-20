// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEEPSEEK_CHAT_TIMEOUT_MS } from '@/lib/ai/deepseek'
import { chamarModeloEconomicoJson } from '@/lib/ai/llm-json'

// Issue #196 / slice 3: `chamarModeloEconomicoJson` forwards `params.timeoutMs`
// straight into `AbortSignal.timeout` inside the DeepSeek call. A zero, negative,
// fractional or non-finite value either aborts the request immediately, throws
// inside the signal factory, or removes the bound entirely, so this boundary must
// hand the provider a validated positive integer or the module fallback.

const h = vi.hoisted(() => ({ chamar: vi.fn() }))

vi.mock('@/lib/ai/deepseek', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/deepseek')>()
  return {
    ...actual,
    chamarDeepSeekChat: h.chamar,
    isUsableDeepSeekApiKey: () => true,
    resolverChaveDeepSeek: async () => 'sk-test-llm-json-timeout',
    resolverModeloDeepSeek: async () => 'deepseek-flash',
  }
})

const params = {
  system: 'Responda APENAS com um objeto JSON.',
  user: 'MENSAGENS RECEBIDAS NESTE LOTE',
  maxTokens: 400,
  timeoutMs: 5000,
}

/** Timeout actually handed to the provider on the nth call. */
const timeoutEnviado = (n = 0): unknown => h.chamar.mock.calls[n]![0].timeoutMs

beforeEach(() => {
  h.chamar.mockReset()
  h.chamar.mockResolvedValue({ success: true, content: '{"assunto":"cliente","fatos":[]}' })
})

describe('chamarModeloEconomicoJson — timeoutMs validation', () => {
  it('forwards a valid caller timeout unchanged', async () => {
    await expect(chamarModeloEconomicoJson({ ...params, timeoutMs: 5000 })).resolves
      .toBe('{"assunto":"cliente","fatos":[]}')

    expect(h.chamar).toHaveBeenCalledTimes(1)
    expect(timeoutEnviado()).toBe(5000)
    expect(h.chamar.mock.calls[0]![0].jsonResponse).toBe(true)
  })

  it('floors a fractional timeout to the positive integer the signal factory accepts', async () => {
    await expect(chamarModeloEconomicoJson({ ...params, timeoutMs: 10.7 })).resolves.not.toBeNull()

    expect(timeoutEnviado()).toBe(10)
  })

  it('falls back to the module default for every unusable timeout instead of aborting at once', async () => {
    const inutilizaveis: Array<[string, unknown]> = [
      ['zero', 0],
      ['negative', -1],
      ['NaN', Number.NaN],
      ['+Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['missing', undefined],
    ]

    for (const [rotulo, timeoutMs] of inutilizaveis) {
      h.chamar.mockClear()
      const resultado = await chamarModeloEconomicoJson({ ...params, timeoutMs } as never)

      expect(resultado, rotulo).toBe('{"assunto":"cliente","fatos":[]}')
      expect(timeoutEnviado(), rotulo).toBe(DEEPSEEK_CHAT_TIMEOUT_MS)
    }

    expect(DEEPSEEK_CHAT_TIMEOUT_MS).toBeGreaterThan(0)
    expect(Number.isInteger(DEEPSEEK_CHAT_TIMEOUT_MS)).toBe(true)
  })

  it('never hands the provider a timeout the abort signal would reject or treat as unbounded', async () => {
    const hostis = [0, -1, -0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e-9, 0.4, 1, 1.9, 30_000]

    for (const timeoutMs of hostis) {
      h.chamar.mockClear()
      await chamarModeloEconomicoJson({ ...params, timeoutMs })

      const enviado = timeoutEnviado() as number
      expect(Number.isFinite(enviado), String(timeoutMs)).toBe(true)
      expect(Number.isInteger(enviado), String(timeoutMs)).toBe(true)
      expect(enviado, String(timeoutMs)).toBeGreaterThan(0)
    }
  })
})
