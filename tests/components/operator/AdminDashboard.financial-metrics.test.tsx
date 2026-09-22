import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminDashboard from '@/components/operator/AdminDashboard'
import { obterMetricasFinanceirasOperacionais } from '@/app/actions/admin'

vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }))
vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn(() => ({ auth: { signOut: vi.fn() } })) }))
vi.mock('@/app/actions/admin', () => ({
  atualizarPerfilUsuario: vi.fn(), criarUsuarioAdmin: vi.fn(), editarUsuarioAdmin: vi.fn(), obterEstatisticasMensagens: vi.fn().mockResolvedValue({ success: true, data: { totalIa: 1, totalOperador: 2, totalCliente: 3, totalMensagens: 6, taxaAutomacao: 33.33 } }), obterMetricasFinanceirasOperacionais: vi.fn(), obterLogsAuditoria: vi.fn(), deletarUsuarioAdmin: vi.fn(), purgarUsuarioAdminTotal: vi.fn(), purgarResidualClienteAdmin: vi.fn(), listarRegistrosAnonimizadosPreservados: vi.fn(), salvarConfiguracaoAdmin: vi.fn(), obterComprovantes: vi.fn(),
}))
vi.mock('@/app/actions/storage-orphan-reconciliation', () => ({ aprovarReconciliacaoImagemOrfa: vi.fn(), executarReconciliacaoImagemOrfa: vi.fn(), listarReconciliacoesImagemOrfa: vi.fn(), varrerImagensOrfasEmModoDryRun: vi.fn() }))
vi.mock('@/components/operator/KnowledgeCRUD', () => ({ default: () => null }))
vi.mock('@/components/operator/BusinessHoursManager', () => ({ default: () => null }))
vi.mock('@/components/operator/InventoryManager', () => ({ default: () => null }))
vi.mock('@/components/operator/integrations/LlmApiCard', () => ({ default: () => null }))
vi.mock('@/components/operator/integrations/WhatsAppCard', () => ({ default: () => null }))
vi.mock('@/components/operator/integrations/TelegramBotCard', () => ({ default: () => null }))
vi.mock('@/components/operator/integrations/MercadoPagoCard', () => ({ default: () => null }))

const props = { usuarioLogado: { id: 'admin', nome: 'Admin', funcao: 'admin', ativo: true }, usuariosIniciais: [], estatisticasIniciais: { totalIa: 0, totalOperador: 0, totalCliente: 0, totalMensagens: 0, taxaAutomacao: 0 }, logsIniciais: [], artigosIniciais: [], systemConfigs: {}, initialTab: 'metricas' as const }
const metrics = { period: { startAt: '2026-08-01T00:00:00.000Z', endAt: '2026-08-31T00:00:00.000Z' }, ordersCreated: 4, approvedSalesCount: 2, refundedSalesCount: 1, grossApprovedCents: 12000, refundsCents: 2000, netOperationalRevenueCents: 10000, averageApprovedTicketCents: 6000, providerGrossCents: 11000, providerFeesCents: 500, providerNetCents: 10500, openReceivablesCount: 1, openReceivablesCents: 3000, cashSessionsOpened: 2, cashSessionsClosed: 1, cashDifferenceCents: -50, bankReconciledCount: 1, bankReconciledCents: 6000, bankUnreconciledCount: 1, bankUnreconciledCents: 4500, marginAvailable: false as const }

describe('AdminDashboard financial metrics', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(obterMetricasFinanceirasOperacionais).mockResolvedValue({ success: true, data: metrics, fetchedAt: '2026-08-31T12:00:00.000Z' }) })
  afterEach(cleanup)
  it('loads the default 30-day operational-financial audit and retains unavailable margin disclosure', async () => {
    render(<AdminDashboard {...props} />)
    await waitFor(() => expect(obterMetricasFinanceirasOperacionais).toHaveBeenCalledOnce())
    expect(screen.getByText(/Receita operacional líquida/)).toBeInTheDocument()
    expect(screen.getByText(/4 pedidos · 2 vendas aprovadas/)).toBeInTheDocument()
    expect(screen.queryByText(/eventos aprovados/i)).not.toBeInTheDocument()
    expect(screen.getByText(/Margem operacional: Não disponível/)).toBeInTheDocument()
    expect(screen.getByText(/não é contabilidade fiscal nem escrituração de partidas dobradas/i)).toBeInTheDocument()
    expect(screen.getByText(/pagamentos parciais e combinados permanecem desabilitados/i)).toBeInTheDocument()
  })

  it('keeps financial failure explicit while refreshing chat metrics', async () => {
    vi.mocked(obterMetricasFinanceirasOperacionais).mockResolvedValue({ success: false, error: 'METRICAS_FINANCEIRAS_INDISPONIVEIS' })
    render(<AdminDashboard {...props} />)
    expect(await screen.findByText(/Métricas financeiras indisponíveis/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Atualizar Indicadores/i }))
    await waitFor(() => expect(obterMetricasFinanceirasOperacionais).toHaveBeenCalledTimes(2))
  })
})
