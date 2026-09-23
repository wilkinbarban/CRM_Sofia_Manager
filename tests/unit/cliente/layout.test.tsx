// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import ClienteLayout from '@/app/cliente/layout'
import { redirect } from 'next/navigation'
import React from 'react'

// Mock next/navigation
const mockUsePathname = vi.fn()
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  usePathname: () => mockUsePathname(),
  useRouter: () => ({
    push: vi.fn(),
  }),
}))

// Mock next/headers
const mockHeaders = vi.fn()
vi.mock('next/headers', () => ({
  headers: () => mockHeaders(),
}))

// Mock supabase server client
const mockGetUser = vi.fn()
const mockFrom = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: {
      getUser: mockGetUser,
    },
    from: mockFrom,
  }),
}))

describe('ClienteLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUsePathname.mockReturnValue('/cliente/chat')
    mockHeaders.mockReturnValue({
      get: (key: string) => {
        if (key === 'x-pathname') return '/cliente/chat'
        return null
      },
    })
  })

  it('redirects to /login if user is not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })

    const resultPromise = ClienteLayout({ children: <div>Chat Area</div> })
    
    // In Next.js, layouts are async components, so we await them
    await expect(resultPromise).rejects.toThrow() // or expect redirect to be called
    // Since we mock redirect to throw or log, let's see how it behaves
    // Usually redirect throws a next-redirect error. Let's inspect redirect calls.
    expect(redirect).toHaveBeenCalledWith('/login')
  })

  it('redirects to /cliente/verificar-telefone if user phone is not verified and they are on a protected page', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    
    // Mock clients query returning empty (not verified)
    const mockSingle = vi.fn().mockResolvedValue({ data: null, error: { message: 'No record' } })
    const mockEq = vi.fn().mockReturnValue({ single: mockSingle })
    const mockSelect = vi.fn().mockReturnValue({ eq: mockEq })
    mockFrom.mockReturnValue({ select: mockSelect })

    await ClienteLayout({ children: <div>Chat Area</div> })

    expect(redirect).toHaveBeenCalledWith('/cliente/verificar-telefone')
  })

  it('renders children directly without layout headers if path is /cliente/verificar-telefone', async () => {
    mockHeaders.mockReturnValue({
      get: (key: string) => {
        if (key === 'x-pathname') return '/cliente/verificar-telefone'
        return null
      },
    })

    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })

    // Component renders without redirect
    const layout = await ClienteLayout({ children: <div data-testid="verification-content">Verification Page</div> })
    
    // Render the returned jsx using react testing library
    render(layout)
    
    expect(screen.getByTestId('verification-content')).toBeInTheDocument()
    // It should NOT render the header logo or links
    expect(screen.queryByText(/CRM Sofia/i)).not.toBeInTheDocument()
    expect(redirect).not.toHaveBeenCalled()
  })

  it('renders header, navigation links, and logout button if user is verified', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    
    // Mock clients query returning verified record
    const mockSingle = vi.fn().mockResolvedValue({ data: { id: 'client-1' }, error: null })
    const mockEq = vi.fn().mockReturnValue({ single: mockSingle })
    const mockSelect = vi.fn().mockReturnValue({ eq: mockEq })
    mockFrom.mockReturnValue({ select: mockSelect })

    const layout = await ClienteLayout({ children: <div data-testid="chat-content">Chat Content</div> })
    
    render(layout)

    expect(screen.getByTestId('chat-content')).toBeInTheDocument()
    expect(screen.getByText(/CRM Sofia/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /chat/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /perfil/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sair/i })).toBeInTheDocument()
    expect(redirect).not.toHaveBeenCalled()
  })
})
