import { describe, expect, it } from 'vitest'
import { buildReceiptPdf, buildReceiptPrintDocument, toReceiptCopies } from '@/lib/receipts/salesReceipt'

const snapshot = {
  order: { id: '123e4567-e89b-12d3-a456-426614174000', delivery_type: 'retirada' },
  customer: { name: 'Ana', phone: '5541999999999' },
  line_items: [{ id: 'line-1', name: 'Costela', quantity: 2, unit_price_centavos: 2500, line_total_centavos: 5000 }],
  charged_amount_centavos: 5000,
  payment: { status: 'aprovado', method: 'pix' },
  establishment: { name: 'Loja de Teste' },
  issuance: { issued_at: '2026-08-20T12:00:00.000Z', snapshot_version: 1 },
}

describe('sales receipt output', () => {
  it('creates two labelled copies with identical immutable commercial data', () => {
    const copies = toReceiptCopies(snapshot)

    expect(copies.map((copy) => copy.label)).toEqual(['VIA CLIENTE', 'VIA ESTABELECIMENTO'])
    expect(copies[0].commercialData).toEqual(copies[1].commercialData)
    expect(copies[0].commercialData).toContain('R$ 50,00')
  })

  it('renders deterministic 58/80 mm print documents and deterministic PDF bytes', () => {
    const receipt58 = buildReceiptPrintDocument(snapshot, 58)
    const receipt80 = buildReceiptPrintDocument(snapshot, 80)
    const firstPdf = buildReceiptPdf(snapshot)
    const secondPdf = buildReceiptPdf(snapshot)

    expect(receipt58).toContain('@page { size: 58mm auto; margin: 0; }')
    expect(receipt80).toContain('@page { size: 80mm auto; margin: 0; }')
    expect(receipt80).toContain('VIA CLIENTE')
    expect(receipt80).toContain('VIA ESTABELECIMENTO')
    expect(firstPdf).toEqual(secondPdf)
    expect(new TextDecoder().decode(firstPdf)).toContain('VIA CLIENTE')
  })

  it('renders a structured Brazilian thermal receipt without horizontal overflow', () => {
    const receipt58 = buildReceiptPrintDocument(snapshot, 58)

    expect(receipt58).toContain('COMPROVANTE DE VENDA')
    expect(receipt58).toContain('DADOS DO PEDIDO')
    expect(receipt58).toContain('CLIENTE')
    expect(receipt58).toContain('ITENS')
    expect(receipt58).toContain('PAGAMENTO')
    expect(receipt58).toContain('TOTAL PAGO')
    expect(receipt58).toContain('overflow-wrap: anywhere')
    expect(receipt58).toContain('max-width: 100%')
    expect(receipt58).not.toContain('white-space: nowrap')
  })

  it('keeps a long immutable order ID complete in print and thermal PDF output', () => {
    const orderId = snapshot.order.id
    const receipt58 = buildReceiptPrintDocument(snapshot, 58)
    const pdfText = new TextDecoder().decode(buildReceiptPdf(snapshot))

    expect(receipt58).toContain(orderId)
    expect(pdfText).toContain('123e4567-e89b-12d3-a456-')
    expect(pdfText).toContain('426614174000')
    expect(
      [...pdfText.matchAll(/\(([^)]*)\) Tj/g)]
        .map((match) => match[1])
        .filter((line) => /^[0-9a-f-]+$/.test(line))
        .join(''),
    ).toContain(orderId)
    expect(pdfText).toContain('/MediaBox [0 0 226.77')
  })

  it('encodes accented Portuguese deterministically with WinAnsi instead of corrupt placeholders', () => {
    const accentedSnapshot = {
      ...snapshot,
      establishment: { name: 'Empório São José' },
      customer: { name: 'João Açúcar', phone: '5541999999999' },
      line_items: [{ ...snapshot.line_items[0], name: 'Pão de alho' }],
    }
    const pdfText = new TextDecoder().decode(buildReceiptPdf(accentedSnapshot))

    expect(pdfText).toContain('/Encoding /WinAnsiEncoding')
    expect(pdfText).toContain('S\\303O JOS\\311')
    expect(pdfText).toContain('Jo\\343o A\\347\\372car')
    expect(pdfText).toContain('P\\343o de alho')
    expect(pdfText).not.toContain('S?o Jos?')
    expect(buildReceiptPdf(accentedSnapshot)).toEqual(buildReceiptPdf(accentedSnapshot))
  })
})
