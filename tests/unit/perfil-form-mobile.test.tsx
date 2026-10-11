import React from 'react'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import PerfilForm from '@/components/operator/PerfilForm'

const mockPush = vi.fn()
const mockRefresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    refresh: mockRefresh,
  }),
}))

const defaultOperator = {
  id: 'op-1',
  nome: 'Operador Teste',
  email: 'operador@asados.com',
  funcao: 'admin',
}

describe('PerfilForm mobile treatment', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('gives every control a touch-sized target', () => {
    const { container } = render(<PerfilForm operatorInfo={defaultOperator} />)
    const controls = Array.from(container.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input'))
    expect(controls.length).toBeGreaterThanOrEqual(7)

    for (const control of controls) {
      expect(control.className).toContain('min-h-11')
    }
  })

  it('stacks the primary actions full width so a phone can reach them with the thumb', () => {
    const { container } = render(<PerfilForm operatorInfo={defaultOperator} />)
    const primary = Array.from(container.querySelectorAll<HTMLButtonElement>('button[type="submit"]'))
    expect(primary).toHaveLength(2)

    for (const action of primary) {
      expect(action.className).toContain('w-full')
      expect(action.className).toContain('sm:w-auto')
    }
  })

  it('names the password visibility toggles for assistive technology', () => {
    render(<PerfilForm operatorInfo={defaultOperator} />)

    const toggleSenha = screen.getByRole('button', { name: 'Mostrar senha' })
    const toggleConfirmar = screen.getByRole('button', { name: 'Mostrar confirmação de senha' })

    expect(toggleSenha).toBeInTheDocument()
    expect(toggleConfirmar).toBeInTheDocument()

    fireEvent.click(toggleSenha)
    expect(screen.getByRole('button', { name: 'Ocultar senha' })).toBeInTheDocument()

    fireEvent.click(toggleConfirmar)
    expect(screen.getByRole('button', { name: 'Ocultar confirmação de senha' })).toBeInTheDocument()
  })
})
