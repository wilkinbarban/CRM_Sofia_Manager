import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminDashboard from '@/components/operator/AdminDashboard'
import WhatsAppCard from '@/components/operator/integrations/WhatsAppCard'
import { salvarConfiguracaoAdmin } from '@/app/actions/admin'

vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }))
vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn(() => ({ auth: { signOut: vi.fn() } })) }))
vi.mock('@/app/actions/admin', () => ({
  atualizarPerfilUsuario: vi.fn(), obterEstatisticasMensagens: vi.fn(), obterLogsAuditoria: vi.fn(),
  deletarUsuarioAdmin: vi.fn(), obterComprovantes: vi.fn(), salvarConfiguracaoAdmin: vi.fn(),
  testarConexaoMeta: vi.fn(), testarConexaoEvolution: vi.fn(), obterQrCodeEvolution: vi.fn(),
  listarRegistrosAnonimizadosPreservados: vi.fn().mockResolvedValue({ success: true, data: [] }),
}))
vi.mock('@/app/actions/storage-orphan-reconciliation', () => ({
  aprovarReconciliacaoImagemOrfa: vi.fn(), executarReconciliacaoImagemOrfa: vi.fn(),
  listarReconciliacoesImagemOrfa: vi.fn(), varrerImagensOrfasEmModoDryRun: vi.fn(),
}))
vi.mock('@/components/operator/KnowledgeCRUD', () => ({ default: () => <div /> }))
vi.mock('@/components/operator/BusinessHoursManager', () => ({ default: () => <div /> }))
vi.mock('@/components/operator/InventoryManager', () => ({ default: () => <div /> }))
vi.mock('@/components/operator/integrations/LlmApiCard', () => ({ default: () => <section aria-label="LLM API card" /> }))
vi.mock('@/components/operator/integrations/WhatsAppCard', async importOriginal => {
  const actual = await importOriginal<typeof import('@/components/operator/integrations/WhatsAppCard')>()
  return { ...actual, default: actual.default }
})
vi.mock('@/components/operator/integrations/TelegramBotCard', () => ({ default: () => <section aria-label="Telegram card" /> }))
vi.mock('@/components/operator/integrations/MercadoPagoCard', () => ({ default: () => <section aria-label="Mercado Pago card" /> }))

const props = {
  usuarioLogado: { id: 'admin-1', nome: 'Admin', funcao: 'admin', ativo: true }, usuariosIniciais: [],
  estatisticasIniciais: { totalIa: 0, totalOperador: 0, totalCliente: 0, totalMensagens: 0, taxaAutomacao: 0 },
  logsIniciais: [], artigosIniciais: [], systemConfigs: {},
}

function WhatsAppHarness({ initial = 'meta' as const }) {
  const [provider, setProvider] = React.useState<'meta' | 'evolution'>(initial)
  return <WhatsAppCard initialConfigs={{}} showToast={vi.fn()} provedorAtivo={provider} onProvedorChange={setProvider} />
}

describe('Integrações do Sistema', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(salvarConfiguracaoAdmin).mockResolvedValue({ success: true }); window.history.replaceState(null, '', '/atendimento/admin?tab=integracoes') })
  afterEach(() => { cleanup(); window.history.replaceState(null, '', '/atendimento/admin') })

  it('renders integration options in a fixed order without draggable controls', async () => {
    render(<AdminDashboard {...props} />)
    expect(await screen.findByRole('heading', { name: 'Integrações do Sistema' })).toBeInTheDocument()
    const options = screen.getAllByRole('article').map(option => option.getAttribute('aria-label'))
    expect(options).toEqual(['WhatsApp', 'LLM API', 'Telegram', 'Mercado Pago'])
    expect(screen.getAllByRole('article').every(option => !option.hasAttribute('draggable'))).toBe(true)
  })

  it('names the provider that actually loads the system prompt', async () => {
    window.history.replaceState(null, '', '/atendimento/admin?tab=prompt')
    render(<AdminDashboard {...props} />)

    expect(await screen.findByRole('heading', { name: 'Master System Prompt' })).toBeInTheDocument()
    expect(screen.getByText(/pipeline de IA da DeepSeek/)).toBeInTheDocument()
    expect(screen.queryByText(/OpenRouter/)).not.toBeInTheDocument()
  })

  it('shows only Meta fields and saves only the active Meta configuration', async () => {
    render(<WhatsAppHarness />)
    expect(screen.getByRole('heading', { name: 'Configuração da Meta Cloud API' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Configuração da Evolution API' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Token de acesso da Meta'), { target: { value: 'meta-token' } })
    fireEvent.change(screen.getByLabelText('ID do número de telefone'), { target: { value: 'phone-id' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar configuração da Meta' }))
    await waitFor(() => expect(salvarConfiguracaoAdmin).toHaveBeenCalledTimes(4))
    expect(vi.mocked(salvarConfiguracaoAdmin).mock.calls.map(([key]) => key)).toEqual([
      'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN',
    ])
  })

  it('switches to Evolution, renders its QR controls, and saves only Evolution fields', async () => {
    render(<WhatsAppHarness />)
    fireEvent.click(screen.getByRole('radio', { name: 'Evolution API' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Configuração da Evolution API' })).toBeInTheDocument())
    expect(screen.queryByRole('heading', { name: 'Configuração da Meta Cloud API' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Obter QR Code' })).toBeInTheDocument()
    vi.mocked(salvarConfiguracaoAdmin).mockClear()
    fireEvent.change(screen.getByLabelText('URL da Evolution API'), { target: { value: 'http://evolution:8080' } })
    fireEvent.change(screen.getByLabelText('Chave da Evolution API'), { target: { value: 'evolution-key' } })
    fireEvent.change(screen.getByLabelText('Nome da instância'), { target: { value: 'asados' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar configuração da Evolution' }))
    await waitFor(() => expect(salvarConfiguracaoAdmin).toHaveBeenCalledTimes(3))
    expect(vi.mocked(salvarConfiguracaoAdmin).mock.calls.map(([key]) => key)).toEqual([
      'EVOLUTION_API_URL', 'EVOLUTION_API_KEY', 'EVOLUTION_INSTANCE_NAME',
    ])
  })
})
