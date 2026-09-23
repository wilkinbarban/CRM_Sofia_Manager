import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolveReceiptPreviewTarget } from '@/components/operator/OperatorChatConsole'

const componentSource = readFileSync(
  'apps/web/src/components/operator/OperatorChatConsole.tsx',
  'utf8',
)
const bannerSource = componentSource.slice(
  componentSource.indexOf("tipoDetectado === 'comprovante' && (() =>"),
  componentSource.indexOf('{/* Histórico Cronológico de Mensagens */}'),
)

describe('operator receipt banner preview target', () => {
  it('gives an authenticated canonical proof exclusive precedence over an unrelated attachment', () => {
    expect(resolveReceiptPreviewTarget({
      payment_proof_id: 'proof-123',
      url_anexo: 'private/unrelated-receipt.pdf',
    })).toEqual({
      kind: 'payment-proof',
      url: '/api/payment-proofs/proof-123/preview',
      filename: 'comprovante.png',
      proofId: 'proof-123',
    })
  })

  it('uses the stored attachment only when no canonical proof exists', () => {
    expect(resolveReceiptPreviewTarget({
      payment_proof_id: null,
      url_anexo: 'private/latest-receipt.pdf',
    })).toEqual({
      kind: 'attachment',
      url: 'private/latest-receipt.pdf',
      filename: 'latest-receipt.pdf',
    })
  })

  it('returns no actionable target when both identifiers are absent', () => {
    expect(resolveReceiptPreviewTarget({ payment_proof_id: null, url_anexo: null })).toBeNull()
  })

  it('keeps the banner path single-routed without dispatching the inline attachment event', () => {
    expect(bannerSource).toContain('resolveReceiptPreviewTarget(mensagemRecente)')
    expect(bannerSource).toContain('handleAbrirVisualizador(')
    expect(bannerSource).not.toContain("dispatchEvent(new CustomEvent('asados:open-attachment-preview'")
    expect(bannerSource).not.toContain("dispatchEvent(new CustomEvent('crm:open-attachment-preview'")
  })
})
