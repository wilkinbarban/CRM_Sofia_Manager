import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachmentCard } from '@/components/operator/OperatorChatConsole'

const pdfBytes = new TextEncoder().encode('%PDF-1.4 preview')

describe('operator attachment PDF preview', () => {
  const destroy = vi.fn()

  beforeEach(() => {
    destroy.mockReset()
    ;(window as any).pdfjsLib = {
      GlobalWorkerOptions: {},
      getDocument: vi.fn(() => ({
        promise: Promise.resolve({
          numPages: 1,
          destroy,
          getPage: () => Promise.resolve({
            getViewport: () => ({ width: 300, height: 500 }),
            render: () => ({ promise: Promise.resolve() }),
          }),
        }),
      })),
    }
    global.fetch = vi.fn().mockResolvedValue(new Response(pdfBytes, {
      headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(pdfBytes.length) },
    }))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      fillStyle: '', fillRect: vi.fn(),
    } as any)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,preview')
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:original')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders the first PDF page as an inline PNG without downloading automatically', async () => {
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click')
    render(<AttachmentCard urlArquivo="private/customer-proof.pdf" onVisualizar={vi.fn()} />)

    await waitFor(() => expect(screen.getByAltText(/Prévia do comprovante enviado/i)).toHaveAttribute('src', 'data:image/png;base64,preview'))
    expect(global.fetch).toHaveBeenCalledWith('/api/chat/midia?path=private%2Fcustomer-proof.pdf')
    expect((window as any).pdfjsLib.GlobalWorkerOptions.workerSrc).toBe('/pdfjs/pdf.worker.min.js')
    expect(anchorClick).not.toHaveBeenCalled()
  })

  it('does not display download button in chat, offering preview only', async () => {
    render(<AttachmentCard urlArquivo="private/customer-proof.pdf" onVisualizar={vi.fn()} />)
    await waitFor(() => expect(screen.getByAltText(/Prévia do comprovante enviado/i)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /Baixar original/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Visualizar comprovante/i })).toBeInTheDocument()
  })

  it('opens the rendered PNG in an accessible lightbox without downloading and closes with Escape', async () => {
    const onVisualizar = vi.fn()
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click')
    render(<AttachmentCard urlArquivo="private/customer-proof.pdf" onVisualizar={onVisualizar} />)
    await waitFor(() => expect(screen.getByAltText(/Prévia do comprovante enviado/i)).toBeInTheDocument())

    const trigger = screen.getByRole('button', { name: /Visualizar comprovante/i })
    trigger.focus()
    fireEvent.click(trigger)

    expect(screen.getByRole('dialog', { name: /Prévia ampliada/i })).toBeInTheDocument()
    expect(screen.getByAltText(/Comprovante ampliado/i)).toHaveAttribute('src', 'data:image/png;base64,preview')
    expect(onVisualizar).not.toHaveBeenCalled()
    expect(anchorClick).not.toHaveBeenCalled()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('closes the PNG lightbox by close button and backdrop', async () => {
    render(<AttachmentCard urlArquivo="private/customer-proof.pdf" onVisualizar={vi.fn()} />)
    await waitFor(() => expect(screen.getByAltText(/Prévia do comprovante enviado/i)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /Visualizar comprovante/i }))
    fireEvent.click(screen.getByRole('button', { name: /Fechar prévia/i }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Visualizar comprovante/i }))
    fireEvent.mouseDown(screen.getByTestId('attachment-preview-backdrop'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows an actionable fallback and destroys the PDF document on unmount', async () => {
    ;(HTMLCanvasElement.prototype.getContext as any).mockReturnValue(null)
    const view = render(<AttachmentCard urlArquivo="private/customer-proof.pdf" onVisualizar={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/Não foi possível gerar a prévia/i)).toBeInTheDocument())
    view.unmount()
    expect(destroy).toHaveBeenCalled()
  })

  it('keeps non-PDF image attachments unchanged', async () => {
    global.fetch = vi.fn()
    render(<AttachmentCard urlArquivo="private/photo.jpg" onVisualizar={vi.fn()} />)
    expect(screen.getByText('IMAGEM')).toBeInTheDocument()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('opens its existing PNG when requested externally by message id', async () => {
    render(<AttachmentCard messageId="message-latest" urlArquivo="private/customer-proof.pdf" onVisualizar={vi.fn()} />)
    await waitFor(() => expect(screen.getByAltText(/Prévia do comprovante enviado/i)).toBeInTheDocument())
    window.dispatchEvent(new CustomEvent('crm:open-attachment-preview', { detail: { messageId: 'message-latest' } }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('ignores external preview requests for a different message', async () => {
    render(<AttachmentCard messageId="message-old" urlArquivo="private/customer-proof.pdf" onVisualizar={vi.fn()} />)
    await waitFor(() => expect(screen.getByAltText(/Prévia do comprovante enviado/i)).toBeInTheDocument())
    window.dispatchEvent(new CustomEvent('crm:open-attachment-preview', { detail: { messageId: 'message-latest' } }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('clears the previous preview immediately when its URL changes', async () => {
    const view = render(<AttachmentCard messageId="message-1" urlArquivo="private/first.pdf" onVisualizar={vi.fn()} />)
    await waitFor(() => expect(screen.getByAltText(/Prévia do comprovante enviado/i)).toBeInTheDocument())
    ;(global.fetch as any).mockReturnValueOnce(new Promise(() => {}))
    view.rerender(<AttachmentCard messageId="message-1" urlArquivo="private/second.pdf" onVisualizar={vi.fn()} />)
    expect(screen.queryByAltText(/Prévia do comprovante enviado/i)).not.toBeInTheDocument()
    expect(screen.getByText(/Gerando prévia segura/i)).toBeInTheDocument()
  })
})
