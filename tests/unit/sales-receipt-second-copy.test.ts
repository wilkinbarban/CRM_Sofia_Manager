import { describe, it, expect } from 'vitest'
import {
  buildReceiptPdf,
  toReceiptCopies,
  type ReceiptSnapshot,
} from '@/lib/receipts/salesReceipt'

describe('Sales Receipt 2ª Via (Segunda Via) Output', () => {
  const snapshot: ReceiptSnapshot = {
    order: { id: '11111111-2222-3333-4444-555555555555', delivery_type: 'retirada' },
    customer: { name: 'João Web', phone: '5541988888888' },
    line_items: [
      {
        id: 'item-1',
        name: 'Costela no Bafo',
        quantity: 1,
        unit_price_centavos: 11990,
        line_total_centavos: 11990,
      },
    ],
    charged_amount_centavos: 11990,
    payment: { status: 'aprovado', method: 'pix' },
    establishment: { name: 'Ambiente de demonstração' },
    issuance: { issued_at: '2026-08-25T12:00:00.000Z', snapshot_version: 1 },
  }

  it('renders standard two copies when isSegundaVia is false or not provided', () => {
    const copies = toReceiptCopies(snapshot)
    expect(copies).toHaveLength(2)
    expect(copies[0].label).toBe('VIA CLIENTE')
    expect(copies[1].label).toBe('VIA ESTABELECIMENTO')
    expect(copies[0].commercialData).toContain('COMPROVANTE DE VENDA')
  })

  it('renders explicit 2ª VIA header and single client copy when isSegundaVia is true', () => {
    const copies = toReceiptCopies(snapshot, { isSegundaVia: true })
    expect(copies).toHaveLength(1)
    expect(copies[0].label).toBe('VIA CLIENTE')
    expect(copies[0].commercialData).toContain('2ª VIA • COMPROVANTE DE PAGAMENTO')
  })

  it('generates valid PDF binary with 2ª VIA header', () => {
    const pdfBytes = buildReceiptPdf(snapshot, { isSegundaVia: true })
    expect(ArrayBuffer.isView(pdfBytes)).toBe(true)
    expect(pdfBytes.length).toBeGreaterThan(100)

    const pdfText = new TextDecoder('latin1').decode(pdfBytes)
    expect(pdfText).toContain('2\\252 VIA')
  })
})
