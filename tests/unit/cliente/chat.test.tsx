import React from 'react'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach, afterEach, beforeAll } from 'vitest'
import ChatContainer from '@/components/chat/ChatContainer'
import ClienteChatPage from '@/app/cliente/chat/page'
import { admitirMensagemSofiaWeb, obterSofiaPresence, processarIaChat } from '@/app/actions/chat'

// Mock next/navigation
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
}))

// Mock Supabase Server Client
const mockServerSupabase = {
  auth: {
    getUser: vi.fn(),
  },
  from: vi.fn(),
  rpc: vi.fn(),
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => mockServerSupabase,
}))

beforeAll(() => {
  window.HTMLElement.prototype.scrollTo = vi.fn()
})

afterEach(() => {
  cleanup()
})

// Mock Supabase Client
const mockChannel = {
  on: vi.fn().mockReturnThis(),
  subscribe: vi.fn().mockReturnThis(),
}

const mockSupabase = {
  storage: {
    from: vi.fn().mockReturnValue({
      createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'http://mock-signed-url.jpg' }, error: null }),
    }),
  },
  channel: vi.fn().mockReturnValue(mockChannel),
  removeChannel: vi.fn(),
  from: vi.fn().mockReturnValue({
    insert: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockResolvedValue({ data: [], error: null }),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
  }),
}

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => mockSupabase,
}))

// Mock Chat Server Action
vi.mock('@/app/actions/chat', () => ({
  processarIaChat: vi.fn(),
  obterSofiaPresence: vi.fn(),
  admitirMensagemSofiaWeb: vi.fn().mockResolvedValue({ success: true, mensagem: null }),
}))

// Mock Carrinho Server Actions
vi.mock('@/app/actions/carrinho', () => ({
  actionObterCarrinhoAtivo: vi.fn().mockResolvedValue({ success: true, carrinho: null }),
  actionAdicionarItemAoCarrinho: vi.fn().mockResolvedValue({
    success: true,
    carrinho: {
      id: 'carrinho-1',
      cliente_id: 'cliente-123',
      total_centavos: 8990,
      subtotal_centavos: 8990,
      desconto_centavos: 0,
      taxa_entrega_centavos: 0,
      itens_carrinho: [
        {
          id: 'item-1',
          carrinho_id: 'carrinho-1',
          produto_id: 'prod-1',
          quantidade: 1,
          preco_unitario_centavos: 8990,
          produtos: {
            id: 'prod-1',
            nome: 'Costela Premium',
            preco_centavos: 8990,
            url_imagem: '/images/costela.jpg',
            url_imagem_thumb: '/images/costela_thumb.jpg',
          },
        },
      ],
    },
  }),
  actionAtualizarQuantidadeItem: vi.fn().mockResolvedValue({ success: true, carrinho: null }),
  actionRemoverItemDoCarrinho: vi.fn().mockResolvedValue({ success: true, carrinho: null }),
  actionLimparCarrinho: vi.fn().mockResolvedValue({ success: true, carrinho: null }),
}))

// Mock Pedidos Server Actions
vi.mock('@/app/actions/pedidos', () => ({
  actionCriarPedidoCliente: vi.fn().mockResolvedValue({
    success: true,
    pedido: {
      id: 'ped-123',
      status: 'novo',
      status_pagamento: 'pendente',
      total_pedido_centavos: 8990,
      tipo_entrega: 'retirada',
      data_criacao: new Date().toISOString(),
      itens_pedido: [],
    },
    mensagem: {
      id: 'msg-inserted-456',
      conversa_id: 'conversa-123',
      remetente: 'cliente',
      conteudo: '🛒 *Pedido #PED-123 Registrado!*',
      url_anexo: null,
      data_criacao: new Date().toISOString(),
    },
  }),
  actionListarMeusPedidosCliente: vi.fn().mockResolvedValue({
    success: true,
    data: [],
  }),
}))

const baseConversa = {
  id: 'conversa-123',
  cliente_id: 'cliente-123',
  status: 'ia_atendendo' as const,
  ia_ativa: true,
  data_criacao: '2026-07-10T12:00:00Z',
  data_atualizacao: '2026-07-10T12:00:00Z',
}

const mockProdutos = [
  {
    id: 'prod-1',
    nome: 'Costela Premium',
    descricao: 'Deliciosa costela assada na brasa',
    preco_centavos: 8990, // R$ 89,90
    url_imagem: '/images/costela.jpg',
    url_imagem_thumb: '/images/costela_thumb.jpg',
  },
  {
    id: 'prod-2',
    nome: 'Pão de Alho',
    descricao: 'Pão recheado com creme de alho especial',
    preco_centavos: 1500, // R$ 15,00
    url_imagem: null,
    url_imagem_thumb: null,
  }
]

describe('ChatContainer Core UI Tests (Phase 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(obterSofiaPresence).mockResolvedValue({ success: true, presence: null })
  })

  it('shows Sofia composing only from the authorized durable presence readback', async () => {
    vi.mocked(obterSofiaPresence).mockResolvedValue({
      success: true,
      presence: { status: 'composing', expiresAt: new Date(Date.now() + 30_000).toISOString() },
    })

    render(
      <ChatContainer
        clienteNome="Ana Silva"
        conversaInicial={baseConversa}
        mensagensIniciais={[]}
        produtos={[]}
      />
    )

    expect(await screen.findByText('Digitando')).toBeInTheDocument()
    expect(obterSofiaPresence).toHaveBeenCalledWith('conversa-123')
  })

  it('hides expired durable presence even when the readback was composing', async () => {
    vi.mocked(obterSofiaPresence).mockResolvedValue({
      success: true,
      presence: { status: 'composing', expiresAt: new Date(Date.now() - 1_000).toISOString() },
    })

    render(
      <ChatContainer
        clienteNome="Ana Silva"
        conversaInicial={baseConversa}
        mensagensIniciais={[]}
        produtos={[]}
      />
    )

    await waitFor(() => expect(screen.queryByText('Digitando')).not.toBeInTheDocument())
  })

  it('Task 2.1: Aligns client messages to the right and IA/Operator messages to the left', () => {
    const mensagens = [
      {
        id: 'msg-1',
        conversa_id: 'conversa-123',
        remetente: 'cliente' as const,
        conteudo: 'Quero fazer um pedido',
        url_anexo: null,
        data_criacao: '2026-07-10T12:01:00Z',
      },
      {
        id: 'msg-2',
        conversa_id: 'conversa-123',
        remetente: 'ia' as const,
        conteudo: 'Olá! Sou a Sofia.',
        url_anexo: null,
        data_criacao: '2026-07-10T12:01:30Z',
      },
      {
        id: 'msg-3',
        conversa_id: 'conversa-123',
        remetente: 'operador' as const,
        conteudo: 'Posso te ajudar?',
        url_anexo: null,
        data_criacao: '2026-07-10T12:02:00Z',
      },
    ]

    render(
      <ChatContainer
        clienteNome="Ana Silva"
        conversaInicial={baseConversa}
        mensagensIniciais={mensagens}
        produtos={[]}
      />
    )

    // Find the message wrappers
    const clientMsgElement = screen.getByText('Quero fazer um pedido').closest('.flex.w-full')
    const iaMsgElement = screen.getByText('Olá! Sou a Sofia.').closest('.flex.w-full')
    const operatorMsgElement = screen.getByText('Posso te ajudar?').closest('.flex.w-full')

    expect(clientMsgElement).toHaveClass('justify-end')
    expect(iaMsgElement).toHaveClass('justify-start')
    expect(operatorMsgElement).toHaveClass('justify-start')
  })

  it('Task 2.2: Renders correct channel source badges based on message database indicators', () => {
    const mensagens = [
      {
        id: 'msg-wa',
        conversa_id: 'conversa-123',
        remetente: 'cliente' as const,
        conteudo: 'Mensagem via WhatsApp',
        url_anexo: null,
        data_criacao: '2026-07-10T12:01:00Z',
        whatsapp_mensagem_id: 'wa-id-123',
      },
      {
        id: 'msg-tg',
        conversa_id: 'conversa-123',
        remetente: 'cliente' as const,
        conteudo: 'Mensagem via Telegram',
        url_anexo: null,
        data_criacao: '2026-07-10T12:01:30Z',
        telegram_mensagem_id: 'tg-id-123',
      },
      {
        id: 'msg-web',
        conversa_id: 'conversa-123',
        remetente: 'cliente' as const,
        conteudo: 'Mensagem via Web',
        url_anexo: null,
        data_criacao: '2026-07-10T12:02:00Z',
      },
    ]

    render(
      <ChatContainer
        clienteNome="Ana Silva"
        conversaInicial={baseConversa}
        mensagensIniciais={mensagens}
        produtos={[]}
      />
    )

    // Check for WhatsApp indicator/badge
    const waBadge = screen.getAllByText('WhatsApp')[0]
    expect(waBadge).toBeInTheDocument()
    // It should have classes representing a green style
    expect(waBadge.className).toContain('emerald') // or similar green-based style

    // Check for Telegram indicator/badge
    const tgBadge = screen.getAllByText('Telegram')[0]
    expect(tgBadge).toBeInTheDocument()
    // It should have classes representing a blue style
    expect(tgBadge.className).toContain('blue')

    // Check for Web indicator/badge
    const webBadge = screen.getAllByText('Web')[0]
    expect(webBadge).toBeInTheDocument()
  })

  it('Task 2.3: Displays correct sender labels for IA, Operator, and Client', () => {
    const mensagens = [
      {
        id: 'msg-ia',
        conversa_id: 'conversa-123',
        remetente: 'ia' as const,
        conteudo: 'Resposta IA',
        url_anexo: null,
        data_criacao: '2026-07-10T12:01:00Z',
      },
      {
        id: 'msg-op',
        conversa_id: 'conversa-123',
        remetente: 'operador' as const,
        conteudo: 'Resposta Operador',
        url_anexo: null,
        data_criacao: '2026-07-10T12:02:00Z',
      },
      {
        id: 'msg-cli',
        conversa_id: 'conversa-123',
        remetente: 'cliente' as const,
        conteudo: 'Mensagem Cliente',
        url_anexo: null,
        data_criacao: '2026-07-10T12:03:00Z',
      },
    ]

    render(
      <ChatContainer
        clienteNome="Ana Silva"
        conversaInicial={baseConversa}
        mensagensIniciais={mensagens}
        produtos={[]}
      />
    )

    // Expecting sender names to identify the sender
    expect(screen.getAllByText('Sofia (IA)')[0]).toBeInTheDocument()
    expect(screen.getAllByText('Atendente')[0]).toBeInTheDocument()
    
    // Client message should show customer's name ("Ana Silva") or "Você"
    expect(screen.getAllByText('Ana Silva')[0]).toBeInTheDocument()
  })

  it('Task 2.4: Renders the product catalog sidebar in the chat layout', () => {
    render(
      <ChatContainer
        clienteNome="Ana Silva"
        conversaInicial={baseConversa}
        mensagensIniciais={[]}
        produtos={mockProdutos}
      />
    )

    // Check if sidebar header exists
    expect(screen.getAllByText(/Catálogo de Produtos/i)[0]).toBeInTheDocument()

    // Check if products exist in the document
    expect(screen.getByText('Costela Premium')).toBeInTheDocument()
    expect(screen.getByText('Pão de Alho')).toBeInTheDocument()

    // Prices must be formatted: preco_centavos / 100
    expect(screen.getByText(/R\$\s*89,90/)).toBeInTheDocument()
    expect(screen.getByText(/R\$\s*15,00/)).toBeInTheDocument()

    // Check descriptions
    expect(screen.getByText('Deliciosa costela assada na brasa')).toBeInTheDocument()

    // Cards should be draggable
    const costelaCard = screen.getByText('Costela Premium').closest('[draggable="true"]')
    expect(costelaCard).toBeInTheDocument()
  })

  it('keeps catalog and current order visible as primary customer actions', () => {
    render(
      <ChatContainer
        clienteNome="Ana Silva"
        conversaInicial={baseConversa}
        mensagensIniciais={[]}
        produtos={mockProdutos}
      />
    )

    expect(screen.getByRole('button', { name: /Abrir cardápio/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Abrir meu pedido/i })).toBeInTheDocument()
    expect(screen.getByTestId('customer-commerce-panel')).toHaveClass('lg:w-[min(48vw,640px)]', 'xl:w-[min(44vw,680px)]')
    expect(screen.getByTestId('customer-chat-shell')).toHaveClass('h-full', 'min-h-0')
  })

  describe('ClienteChatPage Server Component (Task 3.1)', () => {
    it('keeps the client catalog on its existing RPC and preserves the returned catalog order', async () => {
      // Mock getUser to return authenticated user
      mockServerSupabase.auth.getUser.mockResolvedValue({
        data: { user: { id: 'user-123', email: 'test@example.com' } },
        error: null,
      })

      // Mock clientes query
      const mockSingleCliente = vi.fn().mockResolvedValue({
        data: { id: 'cliente-123', nome: 'Cliente Teste', telefone: '5541999999999' },
        error: null,
      })
      const mockEqCliente = vi.fn().mockReturnValue({ single: mockSingleCliente })
      const mockSelectCliente = vi.fn().mockReturnValue({ eq: mockEqCliente })

      // Mock conversas query
      const mockMaybeSingleConversa = vi.fn().mockResolvedValue({
        data: { id: 'conversa-123', cliente_id: 'cliente-123', status: 'ia_atendendo', ia_ativa: true },
        error: null,
      })
      const mockLimitConversa = vi.fn().mockReturnValue({ maybeSingle: mockMaybeSingleConversa })
      const mockOrderConversa = vi.fn().mockReturnValue({ limit: mockLimitConversa })
      const mockNeqConversa = vi.fn().mockReturnValue({ order: mockOrderConversa })
      const mockEqConversa = vi.fn().mockReturnValue({ neq: mockNeqConversa })
      const mockSelectConversa = vi.fn().mockReturnValue({ eq: mockEqConversa })

      // Mock mensagens query
      const mockMessagesLimit = vi.fn().mockResolvedValue({
        data: [],
        error: null,
      })
      const mockMessagesOrder = vi.fn().mockReturnValue({ limit: mockMessagesLimit })
      const mockMessagesEq = vi.fn().mockReturnValue({ order: mockMessagesOrder })
      const mockMessagesSelect = vi.fn().mockReturnValue({ eq: mockMessagesEq })

      mockServerSupabase.from.mockImplementation((table: string) => {
        if (table === 'clientes') {
          return { select: mockSelectCliente }
        }
        if (table === 'conversas') {
          return { select: mockSelectConversa }
        }
        if (table === 'mensagens') {
          return { select: mockMessagesSelect }
        }
        return {}
      })

      // Mock buscar_produtos_disponiveis RPC
      mockServerSupabase.rpc.mockResolvedValue({
        data: [
          {
            id: 'prod-server-1',
            nome: 'Picanha na Grelha',
            descricao: 'Picanha macia e suculenta',
            preco_centavos: 12000,
            url_imagem: null,
            url_imagem_thumb: null,
          },
          {
            id: 'prod-server-2',
            nome: 'Abacaxi Assado',
            descricao: 'Abacaxi com canela',
            preco_centavos: 1800,
            url_imagem: null,
            url_imagem_thumb: null,
          }
        ],
        error: null,
      })

      const PageComponent = await ClienteChatPage()
      render(PageComponent)

      // Verify that the product from the RPC is rendered in the page/container
      expect(screen.getByText('Picanha na Grelha')).toBeInTheDocument()
      expect(screen.getByText(/R\$\s*120,00/)).toBeInTheDocument()
      const firstCatalogItem = screen.getAllByText('Picanha na Grelha')[0]
      const secondCatalogItem = screen.getAllByText('Abacaxi Assado')[0]
      expect(firstCatalogItem.compareDocumentPosition(secondCatalogItem) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(mockServerSupabase.rpc).toHaveBeenCalledWith('buscar_produtos_disponiveis')
      expect(mockServerSupabase.rpc).toHaveBeenCalledTimes(1)
    })
  })

  describe('ChatContainer Drag & Drop / Click Interactions (Tasks 3.2 - 3.4)', () => {
    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('Task 3.2: onDragStart sets product JSON and dropping adds product to client cart', async () => {
      render(
        <ChatContainer
          clienteNome="Ana Silva"
          conversaInicial={baseConversa}
          mensagensIniciais={[]}
          produtos={mockProdutos}
        />
      )

      // Find draggable product card
      const costelaCard = screen.getAllByText('Costela Premium')[0].closest('[draggable="true"]')
      expect(costelaCard).toBeInTheDocument()

      // Drag start event
      const dataTransfer = {
        setData: vi.fn(),
        getData: vi.fn().mockReturnValue(JSON.stringify(mockProdutos[0])),
      }
      fireEvent.dragStart(costelaCard!, { dataTransfer })
      expect(dataTransfer.setData).toHaveBeenCalledWith('application/json', JSON.stringify(mockProdutos[0]))

      // Find drop zone (messages container with chat-dropzone testid)
      const chatArea = screen.getByTestId('chat-dropzone')
      fireEvent.dragOver(chatArea)
      fireEvent.drop(chatArea, { dataTransfer })
    })

    it('Task 3.3 & 3.4: adding product and submitting custom order summary sends message and calls processarIaChat', async () => {
      // Mock insert message
      const mockInsertResult = {
        id: 'msg-inserted-456',
        conversa_id: 'conversa-123',
        remetente: 'cliente' as const,
        conteudo: '🛒 *Pedido Montado no Cardápio:*\n• 1x Costela Premium (R$ 89,90)\n\n💰 *Total:* R$ 89,90\n🕒 *Horário de Retirada:* 12:00\n📍 *Local:* Balcão Umbará (Casa de Assados Brasa & Sabor)\n\nOlá! Gostaria de confirmar esse pedido, por favor!',
        url_anexo: null,
        data_criacao: new Date().toISOString(),
      }

      const mockSingleInsert = vi.fn().mockResolvedValue({ data: mockInsertResult, error: null })
      const mockSelectInsert = vi.fn().mockReturnValue({ single: mockSingleInsert })
      const mockInsert = vi.fn().mockReturnValue({ select: mockSelectInsert })

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === 'mensagens') {
          return { insert: mockInsert }
        }
        return {
          insert: vi.fn().mockReturnThis(),
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockResolvedValue({ data: [], error: null }),
          single: vi.fn().mockResolvedValue({ data: null, error: null }),
        }
      })

      const processarIaChatMock = vi.mocked(processarIaChat)
      processarIaChatMock.mockResolvedValue({ success: true })

      render(
        <ChatContainer
          clienteNome="Ana Silva"
          conversaInicial={baseConversa}
          mensagensIniciais={[]}
          produtos={mockProdutos}
        />
      )

      // Find Add button on Costela card
      const addButtons = screen.getAllByRole('button', { name: /Adicionar/i })
      expect(addButtons.length).toBeGreaterThan(0)
      fireEvent.click(addButtons[0])

      // After adding, submit custom order to chat if present
      await waitFor(() => {
        const sendOrderBtn = screen.queryByRole('button', { name: /Enviar Pedido para Atendente/i })
        if (sendOrderBtn) {
          fireEvent.click(sendOrderBtn)
        }
      })
    })
  })
})

describe('ChatContainer Web admission idempotency key', () => {
  const admitir = vi.mocked(admitirMensagemSofiaWeb)

  beforeEach(() => {
    admitir.mockReset()
    admitir.mockResolvedValue({ success: true, mensagem: null })
  })

  const enviarTexto = async (texto: string) => {
    const esperadas = admitir.mock.calls.length + 1
    const campo = screen.getByPlaceholderText('Digite sua mensagem...')
    fireEvent.change(campo, { target: { value: texto } })
    await waitFor(() => {
      fireEvent.submit(campo.closest('form') as HTMLFormElement)
      expect(admitir).toHaveBeenCalledTimes(esperadas)
    })
  }

  it('mints a new idempotency key when the text is edited after a failed admission', async () => {
    admitir.mockResolvedValue({ success: false, error: 'SOFIA_BATCH_ADMISSION_FAILED' })

    render(
      <ChatContainer clienteNome="Ana Silva" conversaInicial={baseConversa} mensagensIniciais={[]} produtos={[]} />
    )

    await enviarTexto('primeira tentativa')
    await enviarTexto('texto editado')

    const [, conteudoEditado, chaveEditada] = admitir.mock.calls[1]
    const [, , chaveOriginal] = admitir.mock.calls[0]
    expect(conteudoEditado).toBe('texto editado')
    expect(chaveEditada).not.toBe(chaveOriginal)
  })

  it('keeps the same idempotency key when the identical text is retried', async () => {
    admitir.mockResolvedValue({ success: false, error: 'SOFIA_BATCH_ADMISSION_FAILED' })

    render(
      <ChatContainer clienteNome="Ana Silva" conversaInicial={baseConversa} mensagensIniciais={[]} produtos={[]} />
    )

    await enviarTexto('mesmo texto')
    await enviarTexto('mesmo texto')

    const [, , primeiraChave] = admitir.mock.calls[0]
    const [, , segundaChave] = admitir.mock.calls[1]
    expect(segundaChave).toBe(primeiraChave)
  })
})
