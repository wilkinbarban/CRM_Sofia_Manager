import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OperatorWorkspaceHeader } from '@/components/operator/OperatorWorkspaceHeader'

vi.mock('@/app/actions/auth', () => ({ logout: vi.fn() }))

describe('OperatorWorkspaceHeader', () => {
  afterEach(cleanup)

  it.each([
    ['admin', ['Atendimento', 'Pedidos', 'Administração', 'Meu Perfil']],
    ['supervisor', ['Atendimento', 'Pedidos', 'Operacional & Vendas', 'Governança & Gestão', 'Estoque', 'Base RAG', 'Meu Perfil']],
    ['vendedor', ['Atendimento', 'Pedidos', 'Meu Perfil']],
  ])('renders the %s workspace role matrix with one logout', (role, expected) => {
    render(<OperatorWorkspaceHeader active="perfil" role={role} />)
    const nav = screen.getByRole('navigation', { name: 'Módulos do atendimento' })
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(expected)
    expect(screen.getAllByRole('button', { name: 'Sair' })).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Meu Perfil' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('operator-workspace-header')).toHaveClass('overflow-hidden')
  })

  it('renders the business profile name and short name supplied by the server', () => {
    render(
      <OperatorWorkspaceHeader
        active="atendimento"
        role="admin"
        brand={{ name: 'Padaria do Zé', shortName: 'Padaria Zé', subtitle: 'Curitiba - PR' }}
      />
    )

    expect(screen.getByText(/Padaria do/)).toBeInTheDocument()
    expect(screen.getByText('Zé')).toBeInTheDocument()
    expect(screen.getByText('Padaria Zé')).toBeInTheDocument()
    expect(screen.getByText('Curitiba - PR')).toBeInTheDocument()
    expect(screen.queryByText('CRM Sofia Manager')).not.toBeInTheDocument()
  })

  it('keeps rendering a brand when no server profile is supplied', () => {
    render(<OperatorWorkspaceHeader active="perfil" role="vendedor" />)

    expect(screen.getByTestId('operator-workspace-header')).toBeInTheDocument()
    expect(screen.queryByText('CRM Sofia Manager')).not.toBeInTheDocument()
  })

  it('sizes the module links for touch while scrolling on small screens', () => {
    render(<OperatorWorkspaceHeader active="atendimento" role="admin" />)

    const nav = screen.getByRole('navigation', { name: 'Módulos do atendimento' })
    expect(nav).toHaveClass('overflow-x-auto')

    const links = within(nav).getAllByRole('link')
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect(link).toHaveClass('h-11', 'sm:h-9')
    }
  })
})
