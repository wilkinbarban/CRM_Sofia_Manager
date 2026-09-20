import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminDashboard from '@/components/operator/AdminDashboard'
import {
  criarUsuarioAdmin,
  editarUsuarioAdmin,
  obterEstatisticasMensagens,
  obterLogsAuditoria,
  obterComprovantes,
  purgarResidualClienteAdmin,
} from '@/app/actions/admin'

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: vi.fn(() => ({
    auth: { signOut: vi.fn() },
    storage: {
      from: () => ({
        createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://example.com/receipt.pdf' } }),
      }),
    },
  })),
}))

vi.mock('@/app/actions/admin', () => ({
  atualizarPerfilUsuario: vi.fn().mockResolvedValue({ success: true }),
  criarUsuarioAdmin: vi.fn().mockResolvedValue({
    success: true,
    usuario: {
      id: 'new-user-123',
      nome: 'Mariana Souza',
      email: 'mariana@crmsofiamanager.com.br',
      funcao: 'vendedor',
      ativo: true,
      telefone: '5541998877665',
    },
  }),
  editarUsuarioAdmin: vi.fn().mockResolvedValue({ success: true }),
  deletarUsuarioAdmin: vi.fn().mockResolvedValue({ success: true }),
  purgarResidualClienteAdmin: vi.fn().mockResolvedValue({ success: true }),
  listarRegistrosAnonimizadosPreservados: vi.fn().mockResolvedValue({ success: true, data: [{ id: 'residual-11111111-1111-4111-8111-111111111111', conversations: 1, messages: 2, orders: 1, paymentProofs: 1, legacyReceipts: 1, retentionStatus: 'preserved' }] }),
  obterEstatisticasMensagens: vi.fn().mockResolvedValue({
    success: true,
    data: {
      totalIa: 85,
      totalOperador: 15,
      totalCliente: 100,
      totalMensagens: 200,
      taxaAutomacao: 85.0,
    },
  }),
  obterLogsAuditoria: vi.fn().mockResolvedValue({
    success: true,
    data: [
      {
        id: 'log-1',
        usuario_id: 'admin-1',
        acao: 'editar_usuario',
        detalhes: { nome: 'Carlos', funcao_nova: 'supervisor' },
        data_criacao: new Date().toISOString(),
      },
    ],
  }),
  obterComprovantes: vi.fn().mockResolvedValue({
    success: true,
    data: [
      {
        id: 'comp-1',
        cliente_id: 'cli-1',
        url_arquivo: 'comprovantes/cli-1/comp.pdf',
        tamanho_bytes: 204800,
        data_criacao: new Date().toISOString(),
        clientes: { nome: 'João da Silva' },
      },
    ],
  }),
  salvarConfiguracaoAdmin: vi.fn().mockResolvedValue({ success: true }),
  testarConexaoMeta: vi.fn(),
  testarConexaoEvolution: vi.fn(),
  obterQrCodeEvolution: vi.fn(),
}))

vi.mock('@/app/actions/storage-orphan-reconciliation', () => ({
  aprovarReconciliacaoImagemOrfa: vi.fn(),
  executarReconciliacaoImagemOrfa: vi.fn(),
  listarReconciliacoesImagemOrfa: vi.fn(),
  varrerImagensOrfasEmModoDryRun: vi.fn(),
}))

vi.mock('@/components/operator/KnowledgeCRUD', () => ({ default: () => <div /> }))
vi.mock('@/components/operator/BusinessHoursManager', () => ({ default: () => <div /> }))
vi.mock('@/components/operator/InventoryManager', () => ({ default: () => <div /> }))
vi.mock('@/components/operator/PaymentProofAdminPanel', () => ({ default: () => <div><h2>Comprovantes de Pagamento</h2><input placeholder="Filtrar por nome do cliente..." /></div> }))

const defaultProps = {
  usuarioLogado: { id: 'admin-1', nome: 'Admin Principal', funcao: 'admin', ativo: true },
  usuariosIniciais: [
    {
      id: 'admin-1',
      nome: 'Admin Principal',
      funcao: 'admin',
      ativo: true,
      email: 'admin@crmsofiamanager.com.br',
      telefone: '5541999990000',
    },
    {
      id: 'op-1',
      nome: 'Carlos Vendedor',
      funcao: 'vendedor',
      ativo: true,
      email: 'carlos@crmsofiamanager.com.br',
      telefone: '5541988881111',
    },
  ],
  estatisticasIniciais: {
    totalIa: 50,
    totalOperador: 10,
    totalCliente: 60,
    totalMensagens: 120,
    taxaAutomacao: 83.33,
  },
  logsIniciais: [
    {
      id: 'log-initial-1',
      usuario_id: 'admin-1',
      acao: 'login_sistema',
      detalhes: { ip: '127.0.0.1' },
      data_criacao: new Date().toISOString(),
    },
  ],
  calendarConfig: {
    googleCalendarId: null,
    googleClientEmail: null,
    googlePrivateKeyConfigured: false,
  },
  artigosIniciais: [],
  systemConfigs: {},
}

describe('AdminDashboard — Gestão de Usuários, Métricas, Logs e Comprovantes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('1. Gestão de Usuários: abre modal de criação e cadastra novo membro', async () => {
    render(<AdminDashboard {...defaultProps} />)

    // Clicar no botão "+ Novo Membro"
    const btnNovo = screen.getByRole('button', { name: /Novo Membro/i })
    fireEvent.click(btnNovo)

    expect(screen.getByRole('heading', { name: 'Cadastrar Novo Membro da Equipe' })).toBeInTheDocument()

    // Preencher campos
    fireEvent.change(screen.getByPlaceholderText('Ex: Carlos Oliveira'), {
      target: { value: 'Mariana Souza' },
    })
    fireEvent.change(screen.getByPlaceholderText('carlos@crmsofiamanager.com.br'), {
      target: { value: 'mariana@crmsofiamanager.com.br' },
    })
    fireEvent.change(screen.getByPlaceholderText('Mínimo 6 dígitos'), {
      target: { value: 'senha123' },
    })

    // Submeter
    const btnSubmit = screen.getByRole('button', { name: 'Cadastrar Membro' })
    fireEvent.click(btnSubmit)

    await waitFor(() => {
      expect(criarUsuarioAdmin).toHaveBeenCalledWith({
        nome: 'Mariana Souza',
        email: 'mariana@crmsofiamanager.com.br',
        senha: 'senha123',
        funcao: 'vendedor',
        telefone: undefined,
      })
      expect(screen.getByText('Mariana Souza')).toBeInTheDocument()
    })
  })

  it('lists preserved anonymized residuals and requires password plus typed confirmation before purge', async () => {
    render(<AdminDashboard {...defaultProps} />)
    const disclosure = await screen.findByRole('button', { name: /Registros anonimizados preservados/i })
    fireEvent.click(disclosure)
    expect(screen.getByText('residual-11111111-1111-4111-8111-111111111111')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Purgar registro anonimizado de teste' }))
    expect(screen.getByRole('heading', { name: 'Purgar registro anonimizado de teste' })).toBeInTheDocument()
    const confirm = screen.getByRole('button', { name: 'Confirmar purga residual' })
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Senha atual do administrador para residual'), { target: { value: 'current-password' } })
    fireEvent.change(screen.getByLabelText('Confirmação de purga residual'), { target: { value: 'PURGAR RESIDUAL DEFINITIVAMENTE' } })
    fireEvent.click(confirm)
    await waitFor(() => expect(purgarResidualClienteAdmin).toHaveBeenCalledWith({ clienteId: 'residual-11111111-1111-4111-8111-111111111111', senhaAtual: 'current-password', confirmacao: 'PURGAR RESIDUAL DEFINITIVAMENTE' }))
    await waitFor(() => expect(screen.queryByText('residual-11111111-1111-4111-8111-111111111111')).not.toBeInTheDocument())
  })

  it('keeps preserved anonymized records inside the user-management flow as a compact responsive disclosure', async () => {
    render(<AdminDashboard {...defaultProps} />)

    const panel = await screen.findByTestId('anonymized-records-panel')
    const managementFlow = screen.getByTestId('user-management-flow')
    const disclosure = screen.getByRole('button', { name: /Registros anonimizados preservados/i })

    expect(managementFlow).toContainElement(panel)
    expect(panel).toHaveClass('min-w-0', 'overflow-hidden')
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('residual-11111111-1111-4111-8111-111111111111')).not.toBeInTheDocument()

    fireEvent.click(disclosure)

    expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('residual-11111111-1111-4111-8111-111111111111')).toHaveClass('break-all')
  })

  it('2. Gestão de Usuários: abre modal de edição e atualiza dados do operador', async () => {
    render(<AdminDashboard {...defaultProps} />)

    // Clicar no botão de editar do Carlos (segunda linha)
    const btnEditCarlos = screen.getAllByTitle(/Editar dados cadastrais/i)[1]
    fireEvent.click(btnEditCarlos)

    expect(screen.getByRole('heading', { name: 'Editar Dados do Usuário' })).toBeInTheDocument()

    // Alterar nome
    const inputNome = screen.getByPlaceholderText('Nome do operador')
    fireEvent.change(inputNome, { target: { value: 'Carlos Oliveira Vendedor' } })

    // Salvar
    const btnSalvar = screen.getByRole('button', { name: 'Salvar Alterações' })
    fireEvent.click(btnSalvar)

    await waitFor(() => {
      expect(editarUsuarioAdmin).toHaveBeenCalledWith('op-1', {
        nome: 'Carlos Oliveira Vendedor',
        email: 'carlos@crmsofiamanager.com.br',
        telefone: '5541988881111',
        funcao: 'vendedor',
        ativo: true,
        novaSenha: undefined,
      })
      expect(screen.getByText('Carlos Oliveira Vendedor')).toBeInTheDocument()
    })
  })

  it('3. Métricas & Indicadores: renderiza indicadores de automação e botão de atualizar', async () => {
    window.history.replaceState(null, '', '/atendimento/admin?tab=metricas')
    render(<AdminDashboard {...defaultProps} />)

    expect(await screen.findByRole('heading', { name: 'Métricas & Indicadores' })).toBeInTheDocument()
    expect(screen.getByText('Total de Mensagens')).toBeInTheDocument()
    expect(screen.getByText('Respostas de IA (Sofia)')).toBeInTheDocument()

    const btnRefresh = screen.getByRole('button', { name: /Atualizar Indicadores/i })
    fireEvent.click(btnRefresh)

    await waitFor(() => {
      expect(obterEstatisticasMensagens).toHaveBeenCalled()
    })
  })

  it('4. Logs de Auditoria: exibe logs e suporta filtros de classificação', async () => {
    window.history.replaceState(null, '', '/atendimento/admin?tab=auditoria')
    render(<AdminDashboard {...defaultProps} />)

    expect(await screen.findByRole('heading', { name: 'Logs de Auditoria' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Todos' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Info/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Alerta/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Erro/i })).toBeInTheDocument()

    const btnRefreshLogs = screen.getByRole('button', { name: /Atualizar Logs/i })
    fireEvent.click(btnRefreshLogs)

    await waitFor(() => {
      expect(obterLogsAuditoria).toHaveBeenCalledWith(100)
    })
  })

  it('5. Comprovantes de Pagamento: lista comprovantes com opção de filtro', async () => {
    window.history.replaceState(null, '', '/atendimento/admin?tab=comprovantes')
    render(<AdminDashboard {...defaultProps} />)

    expect(await screen.findByRole('heading', { name: 'Comprovantes de Pagamento' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Filtrar por nome do cliente...')).toBeInTheDocument()

    await waitFor(() => {
      expect(obterComprovantes).toHaveBeenCalled()
    })
  })
})

describe('AdminDashboard — initial admin tab deep links', () => {
  it('renders a valid initial tab on the first render without waiting for a client effect', () => {
    render(<AdminDashboard {...defaultProps} initialTab="estoque" />)

    expect(screen.getByRole('button', { name: 'Estoque & Combos' })).toHaveClass('bg-amber-500/15')
    expect(screen.queryByRole('button', { name: /Novo Membro/i })).not.toBeInTheDocument()
  })
})
