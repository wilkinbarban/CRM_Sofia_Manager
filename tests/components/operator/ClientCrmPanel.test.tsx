import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ClientCrmPanel from '@/components/operator/ClientCrmPanel'

vi.mock('@/app/actions/clientes', () => ({
  atualizarClienteCrm: vi.fn(),
}))

// A quarta aba monta o painel de fatos nas navegações por teclado: sem este mock o teste executaria
// a cadeia real da action (gate de operador -> createClient -> cookies) dentro do jsdom.
vi.mock('@/app/actions/fatos-cliente', () => ({
  listarFatosCliente: vi.fn().mockResolvedValue({ success: true, data: [] }),
  revisarFatoCliente: vi.fn(),
}))

vi.mock('@/components/operator/OperatorCartPanel', () => ({
  default: () => <div data-testid="cart-panel">Cart content</div>,
}))

vi.mock('@/components/operator/OperatorClientOrdersList', () => ({
  default: () => <div data-testid="orders-panel">Orders content</div>,
}))

const cliente = {
  id: 'cliente-1',
  nome: 'Maria Silva',
  telefone: '5541999999999',
  endereco: null,
  tags: [],
  notas: null,
  score: 0,
}

afterEach(() => cleanup())

describe('ClientCrmPanel workflow hierarchy', () => {
  it('prioritizes the active sale and keeps cart and orders immediately visible', () => {
    render(<ClientCrmPanel cliente={cliente} />)

    expect(screen.getByText('Venda em andamento')).toBeInTheDocument()
    expect(screen.getByText('Maria Silva')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Carrinho/i })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /Pedidos/i })).toBeVisible()
    expect(screen.getByTestId('cart-panel')).toBeInTheDocument()
  })

  it('preserves direct access to the customer order history', () => {
    render(<ClientCrmPanel cliente={cliente} />)

    fireEvent.click(screen.getByRole('tab', { name: /Pedidos/i }))

    expect(screen.getByRole('tab', { name: /Pedidos/i })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('orders-panel')).toBeInTheDocument()
  })

  it('supports WAI-ARIA automatic tab navigation from the keyboard', () => {
    render(<ClientCrmPanel cliente={cliente} />)

    const cartTab = screen.getByRole('tab', { name: /Carrinho/i })
    const ordersTab = screen.getByRole('tab', { name: /Pedidos/i })
    const crmTab = screen.getByRole('tab', { name: /Dados do cliente/i })
    const fatosTab = screen.getByRole('tab', { name: 'Fatos do cliente (memória)' })

    cartTab.focus()
    fireEvent.keyDown(cartTab, { key: 'ArrowRight' })
    expect(ordersTab).toHaveFocus()
    expect(ordersTab).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(ordersTab, { key: 'End' })
    expect(fatosTab).toHaveFocus()

    fireEvent.keyDown(crmTab, { key: 'Home' })
    expect(cartTab).toHaveFocus()

    fireEvent.keyDown(cartTab, { key: 'ArrowLeft' })
    expect(fatosTab).toHaveFocus()
  })
})
