import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ actionEmitirComprovanteVenda: vi.fn() }))
vi.mock('@/app/actions/pedidos', () => ({ actionEmitirComprovanteVenda: mocks.actionEmitirComprovanteVenda }))

import { ReceiptOutputActions } from '@/components/receipts/ReceiptOutputActions'

const orderId = '123e4567-e89b-12d3-a456-426614174000'
const snapshot = {
  order: { id: orderId, delivery_type: 'retirada' },
  customer: { name: 'João Açúcar', phone: '5541999999999' },
  line_items: [{ id: 'line-1', name: 'Pão de alho', quantity: 1, unit_price_centavos: 1200, line_total_centavos: 1200 }],
  charged_amount_centavos: 1200,
  payment: { status: 'aprovado', method: 'pix' },
  establishment: { name: 'Empório São José' },
  issuance: { issued_at: '2026-08-20T12:00:00.000Z', snapshot_version: 1 },
}

describe('ReceiptOutputActions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.actionEmitirComprovanteVenda.mockResolvedValue({ success: true, receipt_id: 'receipt-1', snapshot })
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:receipt-pdf'),
      revokeObjectURL: vi.fn(),
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('issues once, opens an accessible preview, switches width, and shows both complete copies', async () => {
    render(<ReceiptOutputActions pedidoId={orderId} />)
    const opener = screen.getByRole('button', { name: 'Comprovante' })
    fireEvent.click(opener)

    const dialog = await screen.findByRole('dialog', { name: 'Pré-visualizar comprovante' })
    expect(mocks.actionEmitirComprovanteVenda).toHaveBeenCalledTimes(1)
    expect(dialog).toHaveFocus()
    expect(screen.getByText('VIA CLIENTE')).toBeInTheDocument()
    expect(screen.getByText('VIA ESTABELECIMENTO')).toBeInTheDocument()
    expect(screen.getAllByText(orderId)).toHaveLength(2)
    expect(screen.getByRole('radio', { name: '58 mm' })).toBeChecked()

    fireEvent.click(screen.getByRole('radio', { name: '80 mm' }))
    expect(screen.getByRole('radio', { name: '80 mm' })).toBeChecked()
    expect(mocks.actionEmitirComprovanteVenda).toHaveBeenCalledTimes(1)
  })

  it('closes with Escape and restores focus to the opener', async () => {
    render(<ReceiptOutputActions pedidoId={orderId} />)
    const opener = screen.getByRole('button', { name: 'Comprovante' })
    opener.focus()
    fireEvent.click(opener)
    const dialog = await screen.findByRole('dialog', { name: 'Pré-visualizar comprovante' })

    fireEvent.keyDown(dialog, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(opener).toHaveFocus()
  })

  it('downloads PDF from the authorized snapshot with a Blob URL and never navigates to the API route', async () => {
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<ReceiptOutputActions pedidoId={orderId} />)
    fireEvent.click(screen.getByRole('button', { name: 'Comprovante' }))
    await screen.findByRole('dialog')

    fireEvent.click(screen.getByRole('button', { name: 'Baixar PDF' }))

    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    expect(anchorClick).toHaveBeenCalledTimes(1)
    const anchor = document.querySelector('a[download="comprovante.pdf"]')
    expect(anchor?.getAttribute('href')).toBe('blob:receipt-pdf')
    expect(anchor?.getAttribute('href')).not.toContain('/api/receipts')
    expect(mocks.actionEmitirComprovanteVenda).toHaveBeenCalledTimes(1)
  })

  it('prints from the already-issued preview without opening a late popup or issuing again', async () => {
    const popup = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(<ReceiptOutputActions pedidoId={orderId} />)
    fireEvent.click(screen.getByRole('button', { name: 'Comprovante' }))
    await screen.findByRole('dialog')

    fireEvent.click(screen.getByRole('button', { name: 'Imprimir comprovante' }))

    expect(popup).not.toHaveBeenCalled()
    expect(mocks.actionEmitirComprovanteVenda).toHaveBeenCalledTimes(1)
    expect(screen.getByTitle('Área de impressão do comprovante')).toHaveAttribute('srcdoc', expect.stringContaining('@page { size: 58mm auto;'))
  })
})
