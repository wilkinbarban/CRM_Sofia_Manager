import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const modal = readFileSync('apps/web/src/components/cliente/ModalPagamentoCliente.tsx', 'utf8')
const dashboard = readFileSync('apps/web/src/components/cliente/ClienteOrdersDashboard.tsx', 'utf8')
const chat = readFileSync('apps/web/src/components/chat/ChatContainer.tsx', 'utf8')
const pedidos = readFileSync('apps/web/src/app/actions/pedidos.ts', 'utf8')
const canonicalIntake = readFileSync('apps/web/src/lib/payment-proofs/canonical-intake.ts', 'utf8')
const credits = readFileSync('apps/web/src/lib/ai/credits.ts', 'utf8')
const atendimento = readFileSync('apps/web/src/app/actions/atendimento.ts', 'utf8')

describe('rejected-payment retry flow', () => {
  it('offers gateway retry but not proof upload for rejected payments', () => {
    expect(modal).toContain("const proofUploadAvailable = statusPagamento === 'pendente'")
    expect(dashboard).toContain("pedido.status_pagamento === 'pendente'")
    expect(chat).toContain("pedido.status_pagamento === 'pendente'")
    expect(dashboard).toContain("pedido.status_pagamento === 'rejeitado'")
    expect(chat).toContain("pedido.status_pagamento === 'rejeitado'")
  })

  it('preflights authoritative client proof intake before storage upload and skips canonical admission on failure', () => {
    const preflightImport = modal.indexOf('preflightComprovantePagamentoCliente,')
    const preflightCall = modal.indexOf('await preflightComprovantePagamentoCliente(pedidoId)')
    const failureReturn = modal.indexOf("if (!preflight.success) {", preflightCall)
    const upload = modal.indexOf(".from('chat-midias')\n          .upload")

    expect(preflightImport).toBeGreaterThan(-1)
    expect(preflightCall).toBeGreaterThan(-1)
    expect(failureReturn).toBeGreaterThan(preflightCall)
    expect(upload).toBeGreaterThan(failureReturn)
    expect(modal.slice(failureReturn, upload)).toContain('return')
    expect(modal.slice(failureReturn, upload)).not.toContain('enviarComprovantePagamentoCliente(')
  })

  it('independently enforces authoritative ownership, eligibility, and conversation at canonical admission', () => {
    const preflight = pedidos.slice(
      pedidos.indexOf('export async function preflightComprovantePagamentoCliente'),
      pedidos.indexOf('export async function enviarComprovantePagamentoCliente'),
    )
    const action = pedidos.slice(pedidos.indexOf('export async function enviarComprovantePagamentoCliente'))
    const canonicalCheck = action.indexOf("return { success: false, error: 'COMPROVANTE_INDISPONIVEL' }")

    for (const source of [preflight, action]) {
      expect(source).toContain("clienteDono?.usuario_id !== user.id")
      expect(source).toContain("pedido?.status_pagamento === 'pendente' && pedido?.status !== 'cancelado'")
      expect(source).toContain('!conversaId')
    }
    expect(canonicalCheck).toBeGreaterThan(-1)
    expect(canonicalCheck).toBeLessThan(action.indexOf(".from('chat-midias')\n      .download"))
    expect(canonicalCheck).toBeLessThan(action.indexOf('processCanonicalPaymentProof({'))
    expect(action).not.toMatch(/\.from\('conversas'\)[\s\S]{0,300}order\('data_atualizacao'/)
  })
})

// The retired OpenRouter surface must not come back: the credential, the model
// and the two vestigial process-input fields all belong to DeepSeek now.
describe('retired provider boundary', () => {
  it('never submits the vestigial provider credential or model with a canonical proof', () => {
    const call = pedidos.slice(
      pedidos.indexOf('processCanonicalPaymentProof({'),
      pedidos.indexOf("if (processed.status === 'disabled')"),
    )
    const processInputType = canonicalIntake.slice(
      canonicalIntake.indexOf('type ProcessInput'),
      canonicalIntake.indexOf('function proofIdFrom'),
    )

    expect(call).not.toContain('apiKey')
    expect(call).not.toContain('model')
    expect(pedidos).not.toContain('OPENROUTER')
    expect(processInputType).not.toContain('apiKey')
    expect(processInputType).not.toContain('model')
  })

  it('keeps the credit and status surfaces on DeepSeek only', () => {
    for (const source of [credits, atendimento]) {
      expect(source).not.toMatch(/openrouter/i)
      expect(source).not.toContain('sk-or-')
      expect(source).not.toContain('deepseek-chat')
      expect(source).not.toContain('deepseek-reasoner')
    }

    expect(credits).not.toContain('parseOpenRouterRemainingUsd')
    expect(credits).not.toContain('resolveLlmCreditProvider')
  })
})
