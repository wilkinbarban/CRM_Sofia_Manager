import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'
import OperatorCartPanel from '@/components/operator/OperatorCartPanel'
import * as carrinhoActions from '@/app/actions/carrinho'

vi.mock('@/app/actions/carrinho', () => ({
  actionObterCarrinhoAtivo: vi.fn(),
  actionAtualizarQuantidadeItem: vi.fn(),
  actionRemoverItemDoCarrinho: vi.fn(),
  actionLimparCarrinho: vi.fn(),
  actionConverterCarrinhoEmPedido: vi.fn(),
}))

describe('OperatorCartPanel (TDD)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('exibe estado de carrinho vazio quando não há itens', async () => {
    vi.mocked(carrinhoActions.actionObterCarrinhoAtivo).mockResolvedValueOnce({
      success: true,
      carrinho: {
        id: 'cart-1',
        cliente_id: 'cli-1',
        canal: 'whatsapp',
        status: 'aberto',
        subtotal_centavos: 0,
        desconto_centavos: 0,
        taxa_entrega_centavos: 0,
        total_centavos: 0,
        tipo_entrega: 'retirada',
        itens_carrinho: [],
      },
    })

    render(<OperatorCartPanel clienteId="cli-1" clienteNome="João Silva" />)

    expect(await screen.findByText('Carrinho Vazio')).toBeInTheDocument()
    expect(screen.getByText('Pedido de João Silva')).toBeInTheDocument()
    expect(screen.getByText(/Os itens adicionados pelo cliente no WhatsApp/i)).toBeInTheDocument()
  })

  it('renderiza itens do carrinho e permite converter em pedido', async () => {
    vi.mocked(carrinhoActions.actionObterCarrinhoAtivo).mockResolvedValueOnce({
      success: true,
      carrinho: {
        id: 'cart-1',
        cliente_id: 'cli-1',
        canal: 'whatsapp',
        status: 'aberto',
        subtotal_centavos: 6990,
        desconto_centavos: 0,
        taxa_entrega_centavos: 0,
        total_centavos: 6990,
        tipo_entrega: 'retirada',
        itens_carrinho: [
          {
            id: 'item-1',
            carrinho_id: 'cart-1',
            produto_id: 'prod-1',
            quantidade: 1,
            preco_unitario_centavos: 6990,
            preco_total_centavos: 6990,
            produtos: {
              id: 'prod-1',
              nome: 'Combo 1 - O Clássico',
              url_imagem: '/img.png',
            },
          },
        ],
      },
    })

    const onPedidoConvertido = vi.fn()

    render(
      <OperatorCartPanel
        clienteId="cli-1"
        clienteNome="João Silva"
        onPedidoConvertido={onPedidoConvertido}
      />
    )

    expect(await screen.findByText('Combo 1 - O Clássico')).toBeInTheDocument()
    expect(screen.getByText('Converter em Pedido Oficial')).toBeInTheDocument()

    // Simular conversão do pedido
    vi.mocked(carrinhoActions.actionConverterCarrinhoEmPedido).mockResolvedValueOnce({
      success: true,
      pedidoId: 'ped-abc-12345',
      totalCentavos: 6990,
    })

    vi.mocked(carrinhoActions.actionObterCarrinhoAtivo).mockResolvedValueOnce({
      success: true,
      carrinho: {
        id: 'cart-2',
        cliente_id: 'cli-1',
        canal: 'whatsapp',
        status: 'aberto',
        subtotal_centavos: 0,
        desconto_centavos: 0,
        taxa_entrega_centavos: 0,
        total_centavos: 0,
        tipo_entrega: 'retirada',
        itens_carrinho: [],
      },
    })

    fireEvent.click(screen.getByText('Converter em Pedido Oficial'))

    await waitFor(() => {
      expect(carrinhoActions.actionConverterCarrinhoEmPedido).toHaveBeenCalledWith(
        expect.objectContaining({
          carrinhoId: 'cart-1',
          meioPagamento: 'pix',
        })
      )
      expect(onPedidoConvertido).toHaveBeenCalledWith('ped-abc-12345')
    })
  })
})
