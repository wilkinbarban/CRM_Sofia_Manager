import React from 'react'
import { render, screen, waitFor, fireEvent, act, cleanup, within } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import PerfilPage from '@/app/cliente/perfil/page'
import ClientFactsSection from '@/components/cliente/ClientFactsSection'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// Mock next/navigation
const mockPush = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}))

const mockGetUser = vi.fn()
const mockUpdate = vi.fn()
const mockFrom = vi.fn()
const mockRpc = vi.fn()

const mockSupabaseInstance = {
  auth: {
    getUser: mockGetUser,
    signOut: vi.fn(),
    updateUser: vi.fn(async () => ({ data: {}, error: null })),
  },
  from: mockFrom,
  rpc: mockRpc,
}

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => mockSupabaseInstance,
}))

// Estado do "servidor" dos fatos: os testes afirmam a chamada exata do RPC e o efeito observado na
// tela depois dela, nunca texto que apareceria de qualquer forma.
type FatoNoServidor = {
  fato_id: string
  tipo: string
  chave: string
  valor: string
  origem: string
}

type ErroRpc = { code?: string; message: string }

let fatosNoServidor: FatoNoServidor[] = []
let erroDeLeitura: ErroRpc | null = null
let erroDeEscrita: ErroRpc | null = null

function responderRpc(fn: string, args: any) {
  if (fn === 'meus_fatos_cliente') {
    // Um erro nunca "apaga" o payload: e justamente por isso que a tela nao pode confiar nele.
    return { data: fatosNoServidor.map((fato) => ({ ...fato })), error: erroDeLeitura }
  }

  if (erroDeEscrita) {
    return { data: null, error: erroDeEscrita }
  }

  if (fn === 'corrigir_meu_fato_cliente') {
    fatosNoServidor = fatosNoServidor.map((fato) =>
      fato.fato_id === args.p_fato_id ? { ...fato, valor: args.p_valor, origem: 'cliente' } : fato
    )
    return { data: [{ fato_id: args.p_fato_id, valor: args.p_valor, estado: 'aprovado', origem: 'cliente' }], error: null }
  }

  if (fn === 'recusar_meu_fato_cliente') {
    fatosNoServidor = fatosNoServidor.filter((fato) => fato.fato_id !== args.p_fato_id)
    return { data: [{ fato_id: args.p_fato_id, estado: 'rejeitado' }], error: null }
  }

  return { data: null, error: { code: '42883', message: `funcao desconhecida: ${fn}` } }
}

function chamadasRpc(nome: string) {
  return mockRpc.mock.calls.filter(([fn]) => fn === nome)
}

describe('PerfilPage (migrated configurations page)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fatosNoServidor = []
    erroDeLeitura = null
    erroDeEscrita = null

    // O token cru do banco nunca deve chegar a tela; o log tambem e silenciado para manter a saida limpa.
    vi.spyOn(console, 'error').mockImplementation(() => {})

    mockRpc.mockImplementation(async (fn: string, args: any) => responderRpc(fn, args))

    // Explicitly define mock implementation before every single test
    mockGetUser.mockImplementation(async () => ({
      data: { user: { id: 'user-1', email: 'john@example.com' } },
      error: null,
    }))

    mockUpdate.mockImplementation(() => ({
      eq: vi.fn(async () => ({ error: null })),
    }))

    mockFrom.mockImplementation((table: string) => {
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        single: vi.fn(async () => {
          if (table === 'perfis') {
            return { data: { nome: 'John Doe' }, error: null }
          }
          if (table === 'clientes') {
            return { data: { telefone: '5541999999999', endereco: 'Rua das Flores, 123' }, error: null }
          }
          return { data: null, error: null }
        }),
        update: mockUpdate,
      }
      return builder
    })
  })

  it('renders loading state initially and then shows values from Supabase', async () => {
    render(<PerfilPage />)

    expect(screen.getByText(/Carregando configurações de perfil/i)).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.queryByText(/Carregando configurações de perfil/i)).not.toBeInTheDocument()
    })

    expect(screen.getByDisplayValue('John Doe')).toBeInTheDocument()
    expect(screen.getByDisplayValue('john@example.com')).toBeInTheDocument()
    expect(screen.getByDisplayValue('(41) 9 9999-9999')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Rua das Flores, 123')).toBeInTheDocument()
  })

  it('validates fields and shows error messages on submit if empty', async () => {
    render(<PerfilPage />)

    await waitFor(() => {
      expect(screen.queryByText(/Carregando configurações de perfil/i)).not.toBeInTheDocument()
    })

    const nomeInput = screen.getByLabelText(/Nome Completo/i) as HTMLInputElement
    const enderecoInput = screen.getByLabelText(/Endereço de Entrega/i) as HTMLTextAreaElement
    const submitBtn = screen.getByText('Salvar Alterações').closest('button')!

    await act(async () => {
      fireEvent.change(nomeInput, { target: { value: 'Jo' } })
      fireEvent.change(enderecoInput, { target: { value: 'Rua' } })
    })

    expect(nomeInput.value).toBe('Jo')
    expect(enderecoInput.value).toBe('Rua')

    const form = submitBtn.closest('form')!

    await act(async () => {
      fireEvent.submit(form)
    })

    await waitFor(() => {
      expect(screen.getByText('O nome deve ter pelo menos 3 caracteres')).toBeInTheDocument()
      expect(screen.getByText('O endereço deve ser detalhado (mínimo 5 caracteres)')).toBeInTheDocument()
    })
  })

  it('calls update queries and displays success message if inputs are valid and unchanged phone', async () => {
    render(<PerfilPage />)

    await waitFor(() => {
      expect(screen.queryByText(/Carregando configurações de perfil/i)).not.toBeInTheDocument()
    })

    const submitBtn = screen.getByText('Salvar Alterações').closest('button')!
    const form = submitBtn.closest('form')!
    
    await act(async () => {
      fireEvent.submit(form)
    })

    await waitFor(() => {
      expect(screen.getByText('Configurações salvas com sucesso!')).toBeInTheDocument()
    })

    expect(mockFrom).toHaveBeenCalledWith('perfis')
    expect(mockFrom).toHaveBeenCalledWith('clientes')
  })

  it('renders the facts section inside the profile page and reads the owner projection', async () => {
    fatosNoServidor = [
      { fato_id: 'fato-carne', tipo: 'preferencia', chave: 'ponto_carne', valor: 'ao ponto', origem: 'cliente' },
    ]

    render(<PerfilPage />)

    await waitFor(() => {
      expect(screen.queryByText(/Carregando configurações de perfil/i)).not.toBeInTheDocument()
    })

    expect(await screen.findByTestId('fatos-cliente-secao')).toBeInTheDocument()
    expect(await screen.findByText('ao ponto')).toBeInTheDocument()
    expect(mockRpc).toHaveBeenCalledWith('meus_fatos_cliente', { p_limite: 200 })
    // O formulario existente continua na tela, sem alteracao de layout.
    expect(screen.getByDisplayValue('John Doe')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Rua das Flores, 123')).toBeInTheDocument()
  })

  it('keeps the client gate: a phone without a client record is redirected and never queries facts', async () => {
    mockFrom.mockImplementation((table: string) => {
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        single: vi.fn(async () =>
          table === 'perfis'
            ? { data: { nome: 'John Doe' }, error: null }
            : { data: null, error: { message: 'No record' } }
        ),
        update: mockUpdate,
      }
      return builder
    })

    render(<PerfilPage />)

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/cliente/verificar-telefone')
    })

    expect(screen.queryByTestId('fatos-cliente-secao')).not.toBeInTheDocument()
    expect(mockRpc).not.toHaveBeenCalled()
  })
})

describe('ClientFactsSection (owner-scoped customer facts)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fatosNoServidor = []
    erroDeLeitura = null
    erroDeEscrita = null

    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockRpc.mockImplementation(async (fn: string, args: any) => responderRpc(fn, args))
  })

  it("lists the customer's own approved facts and marks each origin", async () => {
    fatosNoServidor = [
      { fato_id: 'fato-carne', tipo: 'preferencia', chave: 'ponto_carne', valor: 'ao ponto', origem: 'ia' },
      { fato_id: 'fato-endereco', tipo: 'endereco', chave: 'endereco_entrega', valor: 'Rua das Flores, 123', origem: 'cliente' },
    ]

    render(<ClientFactsSection />)

    expect(await screen.findByText('ao ponto')).toBeInTheDocument()
    expect(screen.getByText('Rua das Flores, 123')).toBeInTheDocument()
    expect(screen.getAllByTestId('fato-cliente-item')).toHaveLength(2)

    // Leitura de proprietario: o payload nao carrega id de cliente nem id de usuario, porque
    // `meus_fatos_cliente` resolve o cliente por `auth.uid()`. Um id aqui abriria leitura entre clientes.
    const leitura = chamadasRpc('meus_fatos_cliente')
    expect(leitura).toHaveLength(1)
    expect(leitura[0]).toEqual(['meus_fatos_cliente', { p_limite: 200 }])
    expect(Object.keys(leitura[0][1] as object)).toEqual(['p_limite'])

    const linhaCarne = screen
      .getAllByTestId('fato-cliente-item')
      .find((item) => item.getAttribute('data-fato-id') === 'fato-carne')!
    const linhaEndereco = screen
      .getAllByTestId('fato-cliente-item')
      .find((item) => item.getAttribute('data-fato-id') === 'fato-endereco')!

    expect(within(linhaCarne).getByTestId('fato-cliente-autoria')).toHaveTextContent('Sugerido pela Sofia')
    expect(within(linhaEndereco).getByTestId('fato-cliente-autoria')).toHaveTextContent('Informado por você')

    // A origem exibida vem da fixture, linha a linha: o atributo e evidencia, nao enfeite.
    expect(linhaCarne).toHaveAttribute('data-origem', 'ia')
    expect(linhaEndereco).toHaveAttribute('data-origem', 'cliente')
  })

  it('never exposes an internal observacao fact, even when the backend sends one', async () => {
    fatosNoServidor = [
      { fato_id: 'fato-endereco', tipo: 'endereco', chave: 'endereco_entrega', valor: 'Rua das Flores, 123', origem: 'cliente' },
      { fato_id: 'fato-nota', tipo: 'observacao', chave: 'nota_interna', valor: 'cliente reclama de tudo', origem: 'ia' },
    ]

    render(<ClientFactsSection />)

    expect(await screen.findByText('Rua das Flores, 123')).toBeInTheDocument()
    // A linha interna nao tem caminho de tela: a lista tem exatamente uma linha e nenhum texto interno.
    expect(screen.getAllByTestId('fato-cliente-item')).toHaveLength(1)
    expect(screen.queryByText('cliente reclama de tudo')).not.toBeInTheDocument()
    expect(screen.queryByTestId('fato-cliente-item')!.getAttribute('data-tipo')).toBe('endereco')
    expect(screen.queryByTestId('fato-cliente-item')).toHaveAttribute('data-origem', 'cliente')
    // E o cliente nao pode pedir fato de outro cliente: a consulta nao aceita nenhum alvo alem do limite.
    expect(Object.keys(chamadasRpc('meus_fatos_cliente')[0][1] as object)).toEqual(['p_limite'])
  })

  it("corrects a fact through corrigir_meu_fato_cliente and shows it as the customer's own statement", async () => {
    fatosNoServidor = [
      { fato_id: 'fato-carne', tipo: 'preferencia', chave: 'ponto_carne', valor: 'ao ponto', origem: 'ia' },
    ]

    render(<ClientFactsSection />)

    expect(await screen.findByText('ao ponto')).toBeInTheDocument()
    expect(screen.getByTestId('fato-cliente-autoria')).toHaveTextContent('Sugerido pela Sofia')

    fireEvent.click(screen.getByRole('button', { name: /corrigir fato ponto_carne/i }))

    const campo = screen.getByLabelText(/novo valor para ponto_carne/i)
    expect(campo).toHaveValue('ao ponto')

    await act(async () => {
      // O RPC recusa valor com espaco nas bordas (`p_valor <> btrim(p_valor)`), entao a tela apara.
      fireEvent.change(campo, { target: { value: '  bem passado  ' } })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /confirmar correção de ponto_carne/i }))
    })

    await waitFor(() => {
      expect(screen.queryByText('ao ponto')).not.toBeInTheDocument()
    })
    expect(screen.getByText('bem passado')).toBeInTheDocument()
    expect(screen.getByTestId('fato-cliente-autoria')).toHaveTextContent('Informado por você')
    // A linha corrigida tambem carrega a origem do servidor depois da re-leitura.
    expect(screen.getByTestId('fato-cliente-item')).toHaveAttribute('data-origem', 'cliente')

    // Argumentos exatos: o alvo e o id do fato (nunca o id do cliente) e o valor vai aparado.
    expect(mockRpc).toHaveBeenCalledWith('corrigir_meu_fato_cliente', {
      p_fato_id: 'fato-carne',
      p_valor: 'bem passado',
    })
    // O estado da tela vem do servidor: a escrita e seguida de uma nova leitura.
    expect(chamadasRpc('meus_fatos_cliente')).toHaveLength(2)
  })

  it('refuses a fact through recusar_meu_fato_cliente and removes it on the next render', async () => {
    fatosNoServidor = [
      { fato_id: 'fato-carne', tipo: 'preferencia', chave: 'ponto_carne', valor: 'ao ponto', origem: 'ia' },
      { fato_id: 'fato-endereco', tipo: 'endereco', chave: 'endereco_entrega', valor: 'Rua das Flores, 123', origem: 'cliente' },
    ]

    render(<ClientFactsSection />)

    expect(await screen.findByText('ao ponto')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /recusar fato ponto_carne/i }))
    })

    await waitFor(() => {
      expect(screen.queryByText('ao ponto')).not.toBeInTheDocument()
    })

    expect(mockRpc).toHaveBeenCalledWith('recusar_meu_fato_cliente', { p_fato_id: 'fato-carne' })
    expect(screen.getAllByTestId('fato-cliente-item')).toHaveLength(1)
    expect(screen.getByText('Rua das Flores, 123')).toBeInTheDocument()
    expect(screen.getByTestId('fato-cliente-item')).toHaveAttribute('data-origem', 'cliente')
    // A linha so sai da lista porque o servidor a devolveu fora dela: uma remocao otimista sem
    // re-leitura apagaria o texto sem nunca confirmar a recusa, e falharia nesta contagem.
    expect(chamadasRpc('meus_fatos_cliente')).toHaveLength(2)
  })

  it('renders an error state without leaking the RPC token or message when the read fails', async () => {
    fatosNoServidor = [
      { fato_id: 'fato-carne', tipo: 'preferencia', chave: 'ponto_carne', valor: 'ao ponto', origem: 'ia' },
    ]
    erroDeLeitura = { code: '42501', message: 'SOFIA_FATO_NAO_AUTORIZADO' }

    render(<ClientFactsSection />)

    expect(await screen.findByTestId('fatos-cliente-erro')).toHaveTextContent(
      'Não foi possível carregar suas informações'
    )
    // Um resultado recusado nunca vira linha, mesmo que o payload traga `data`.
    expect(screen.queryByTestId('fato-cliente-item')).not.toBeInTheDocument()
    expect(screen.queryByText('ao ponto')).not.toBeInTheDocument()
    expect(screen.queryByTestId('fatos-cliente-vazio')).not.toBeInTheDocument()

    expect(document.body.textContent).not.toMatch(/SOFIA_FATO/)
    expect(document.body.textContent).not.toMatch(/42501/)
  })

  it('renders a generic error and keeps the fact visible when the write fails', async () => {
    fatosNoServidor = [
      { fato_id: 'fato-carne', tipo: 'preferencia', chave: 'ponto_carne', valor: 'ao ponto', origem: 'ia' },
    ]
    erroDeEscrita = { code: 'P0002', message: 'SOFIA_FATO_NAO_ENCONTRADO' }

    render(<ClientFactsSection />)

    expect(await screen.findByText('ao ponto')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /recusar fato ponto_carne/i }))
    })

    expect(await screen.findByTestId('fatos-cliente-erro-acao')).toHaveTextContent(
      'Não foi possível concluir a alteração'
    )
    // Nada e removido otimisticamente: a linha continua exatamente como o servidor a devolveu.
    expect(screen.getByText('ao ponto')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/SOFIA_FATO/)
    expect(document.body.textContent).not.toMatch(/P0002/)
  })

  it('renders an empty state when the customer has no approved facts', async () => {
    render(<ClientFactsSection />)

    expect(await screen.findByTestId('fatos-cliente-vazio')).toBeInTheDocument()
    expect(screen.queryByTestId('fatos-cliente-lista')).not.toBeInTheDocument()
    expect(screen.queryByTestId('fato-cliente-item')).not.toBeInTheDocument()
  })

  it('calls only the owner-scoped functions and never reads a table directly', async () => {
    fatosNoServidor = [
      { fato_id: 'fato-carne', tipo: 'preferencia', chave: 'ponto_carne', valor: 'ao ponto', origem: 'ia' },
    ]
    erroDeEscrita = { code: '42501', message: 'SOFIA_FATO_NAO_AUTORIZADO' }

    render(<ClientFactsSection />)

    expect(await screen.findByText('ao ponto')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /recusar fato ponto_carne/i }))
    })
    await screen.findByTestId('fatos-cliente-erro-acao')

    const chamadas = mockRpc.mock.calls.map(([fn]) => fn)
    expect(new Set(chamadas)).toEqual(new Set(['meus_fatos_cliente', 'recusar_meu_fato_cliente']))
    for (const proibida of [
      'listar_fatos_cliente',
      'revisar_fato_cliente',
      'buscar_fatos_para_prompt',
      'registrar_fato_cliente',
    ]) {
      expect(chamadas).not.toContain(proibida)
    }
    // Nenhuma leitura direta de tabela: toda a superficie passa pelos RPCs do proprietario.
    expect(mockFrom).not.toHaveBeenCalled()
  })
})
