import React from 'react'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import BusinessProfileCard from '@/components/operator/BusinessProfileCard'
import AdminDashboard from '@/components/operator/AdminDashboard'
import { salvarConfiguracaoAdmin } from '@/app/actions/admin'
import {
  DEFAULT_BUSINESS_PROFILE,
  BUSINESS_PROFILE_CONFIG_KEYS,
} from '@/lib/config/business-profile'

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: vi.fn(() => ({ auth: { signOut: vi.fn() } })),
}))

vi.mock('@/app/actions/admin', () => ({
  salvarConfiguracaoAdmin: vi.fn(),
  obterEstatisticasMensagens: vi.fn().mockResolvedValue({ success: true, data: null }),
  obterLogsAuditoria: vi.fn().mockResolvedValue({ success: true, data: [] }),
  listarRegistrosAnonimizadosPreservados: vi.fn().mockResolvedValue({ success: true, data: [] }),
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
vi.mock('@/components/operator/integrations/LlmApiCard', () => ({ default: () => <div /> }))
vi.mock('@/components/operator/integrations/WhatsAppCard', () => ({ default: () => <div /> }))
vi.mock('@/components/operator/integrations/TelegramBotCard', () => ({ default: () => <div /> }))
vi.mock('@/components/operator/integrations/MercadoPagoCard', () => ({ default: () => <div /> }))

describe('BusinessProfileCard — configuração do negócio', () => {
  const showToast = vi.fn()
  const onProfileSaved = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(salvarConfiguracaoAdmin).mockResolvedValue({ success: true })
  })

  afterEach(() => {
    cleanup()
  })

  it('renderiza os valores padrão quando não há configurações prévias', () => {
    render(<BusinessProfileCard showToast={showToast} onProfileSaved={onProfileSaved} />)

    expect(screen.getByLabelText(/Nome do Estabelecimento/i)).toHaveValue(DEFAULT_BUSINESS_PROFILE.name)
    expect(screen.getByLabelText(/Nome Curto/i)).toHaveValue(DEFAULT_BUSINESS_PROFILE.shortName)
    expect(screen.getByLabelText(/Localização \/ Cidade Base/i)).toHaveValue(DEFAULT_BUSINESS_PROFILE.location)
    expect(screen.getByLabelText(/Endereço de Retirada/i)).toHaveValue(DEFAULT_BUSINESS_PROFILE.pickupAddress)
    expect(screen.getByLabelText(/Papel da Persona Sofía/i)).toHaveValue(DEFAULT_BUSINESS_PROFILE.personaRole)
    expect(screen.getByLabelText(/Objeto Social/i)).toHaveValue(DEFAULT_BUSINESS_PROFILE.description)
  })

  it('renderiza os valores customizados quando informados em initialConfigs', () => {
    render(
      <BusinessProfileCard
        initialConfigs={{
          BUSINESS_NAME: 'Boutique de Carnes Nobres',
          BUSINESS_SHORT_NAME: 'Boutique',
          BUSINESS_LOCATION: 'Curitiba - Batel',
          BUSINESS_PICKUP_ADDRESS: 'Av. Batel, 1500',
          BUSINESS_DESCRIPTION: 'Cortes nobres e parrilha.',
          SOFIA_PERSONA_ROLE: 'sommelier de carnes e concierge',
        }}
        showToast={showToast}
      />,
    )

    expect(screen.getByLabelText(/Nome do Estabelecimento/i)).toHaveValue('Boutique de Carnes Nobres')
    expect(screen.getByLabelText(/Nome Curto/i)).toHaveValue('Boutique')
    expect(screen.getByLabelText(/Localização \/ Cidade Base/i)).toHaveValue('Curitiba - Batel')
    expect(screen.getByLabelText(/Endereço de Retirada/i)).toHaveValue('Av. Batel, 1500')
    expect(screen.getByLabelText(/Papel da Persona Sofía/i)).toHaveValue('sommelier de carnes e concierge')
    expect(screen.getByLabelText(/Objeto Social/i)).toHaveValue('Cortes nobres e parrilha.')
  })

  it('exibe o aviso da regra regional de Curitiba (DDD 41)', () => {
    render(<BusinessProfileCard showToast={showToast} />)

    expect(screen.getByText(/Validação Regional Preservada/i)).toBeInTheDocument()
    expect(screen.getByText(/55419XXXXXXXX/i)).toBeInTheDocument()
  })

  it('salva todas as 6 chaves de configuração ao submeter o formulário', async () => {
    render(<BusinessProfileCard showToast={showToast} onProfileSaved={onProfileSaved} />)

    fireEvent.change(screen.getByLabelText(/Nome do Estabelecimento/i), {
      target: { value: 'Pizzaria Bella Curitiba' },
    })
    fireEvent.change(screen.getByLabelText(/Nome Curto/i), {
      target: { value: 'Bella' },
    })

    fireEvent.click(screen.getByRole('button', { name: /Salvar Perfil da Empresa/i }))

    await waitFor(() => {
      expect(salvarConfiguracaoAdmin).toHaveBeenCalledTimes(6)
    })

    expect(salvarConfiguracaoAdmin).toHaveBeenCalledWith(
      BUSINESS_PROFILE_CONFIG_KEYS.name,
      'Pizzaria Bella Curitiba',
    )
    expect(salvarConfiguracaoAdmin).toHaveBeenCalledWith(
      BUSINESS_PROFILE_CONFIG_KEYS.shortName,
      'Bella',
    )
    expect(showToast).toHaveBeenCalledWith('success', 'Perfil da empresa salvo com sucesso!')
    expect(onProfileSaved).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Pizzaria Bella Curitiba',
        shortName: 'Bella',
      }),
    )
  })

  it('restaura os valores de fábrica ao clicar em Restaurar Padrões', () => {
    render(
      <BusinessProfileCard
        initialConfigs={{
          BUSINESS_NAME: 'Nome Temporario',
          BUSINESS_SHORT_NAME: 'Temp',
        }}
        showToast={showToast}
      />,
    )

    expect(screen.getByLabelText(/Nome do Estabelecimento/i)).toHaveValue('Nome Temporario')

    fireEvent.click(screen.getByRole('button', { name: /Restaurar Padrões/i }))

    expect(screen.getByLabelText(/Nome do Estabelecimento/i)).toHaveValue(DEFAULT_BUSINESS_PROFILE.name)
    expect(screen.getByLabelText(/Nome Curto/i)).toHaveValue(DEFAULT_BUSINESS_PROFILE.shortName)
    expect(showToast).toHaveBeenCalledWith('success', 'Valores restaurados para o padrão de fábrica.')
  })

  it('exibe mensagem de erro caso o salvamento falhe', async () => {
    vi.mocked(salvarConfiguracaoAdmin).mockResolvedValueOnce({
      success: false,
      error: 'Falha de conexão com o banco.',
    })

    render(<BusinessProfileCard showToast={showToast} />)

    fireEvent.click(screen.getByRole('button', { name: /Salvar Perfil da Empresa/i }))

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('error', 'Falha de conexão com o banco.')
    })
  })
})

describe('AdminDashboard — navegação para a aba empresa', () => {
  const adminProps = {
    usuarioLogado: { id: 'admin-1', nome: 'Admin', funcao: 'admin', ativo: true },
    usuariosIniciais: [],
    estatisticasIniciais: { totalIa: 0, totalOperador: 0, totalCliente: 0, totalMensagens: 0, taxaAutomacao: 0 },
    logsIniciais: [],
    artigosIniciais: [],
    systemConfigs: {
      BUSINESS_NAME: 'Empresa Teste',
      BUSINESS_SHORT_NAME: 'Teste',
    },
  }

  afterEach(() => {
    cleanup()
    window.history.replaceState(null, '', '/atendimento/admin')
  })

  it('renderiza o perfil da empresa diretamente quando tab=empresa', async () => {
    window.history.replaceState(null, '', '/atendimento/admin?tab=empresa')
    render(<AdminDashboard {...adminProps} />)

    expect(await screen.findByRole('heading', { name: /Perfil da Empresa & Identidade Comercial/i })).toBeInTheDocument()
    expect(screen.getByLabelText(/Nome do Estabelecimento/i)).toHaveValue('Empresa Teste')
  })

  it('permite alternar para a aba empresa pelo botão da barra lateral', async () => {
    render(<AdminDashboard {...adminProps} />)

    const empresaButton = screen.getByRole('button', { name: /Perfil da Empresa/i })
    expect(empresaButton).toBeInTheDocument()

    fireEvent.click(empresaButton)

    expect(await screen.findByRole('heading', { name: /Perfil da Empresa & Identidade Comercial/i })).toBeInTheDocument()
  })
})
