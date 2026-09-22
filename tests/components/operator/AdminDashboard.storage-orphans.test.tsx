import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminDashboard from '@/components/operator/AdminDashboard'
import {
  executarReconciliacaoImagemOrfa,
  listarReconciliacoesImagemOrfa,
  type StorageOrphanReconciliationListItem,
  varrerImagensOrfasEmModoDryRun,
} from '@/app/actions/storage-orphan-reconciliation'

vi.mock('next/link', () => ({
  default: ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) => (
    <a className={className} href={href}>{children}</a>
  ),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: vi.fn(() => ({ auth: { signOut: vi.fn() } })),
}))

vi.mock('@/app/actions/admin', () => ({
  atualizarPerfilUsuario: vi.fn(),
  obterEstatisticasMensagens: vi.fn(),
  obterLogsAuditoria: vi.fn(),
  deletarUsuarioAdmin: vi.fn(),
  salvarConfiguracaoAdmin: vi.fn(),
  obterComprovantes: vi.fn(),
  listarRegistrosAnonimizadosPreservados: vi.fn().mockResolvedValue({ success: true, data: [] }),
}))

vi.mock('@/app/actions/storage-orphan-reconciliation', () => ({
  aprovarReconciliacaoImagemOrfa: vi.fn(),
  executarReconciliacaoImagemOrfa: vi.fn(),
  listarReconciliacoesImagemOrfa: vi.fn(),
  varrerImagensOrfasEmModoDryRun: vi.fn(),
}))

vi.mock('@/components/operator/KnowledgeCRUD', () => ({
  default: () => <div>Base de conhecimento isolada</div>,
}))

vi.mock('@/components/operator/BusinessHoursManager', () => ({
  default: () => <div>Horários isolados</div>,
}))

vi.mock('@/components/operator/InventoryManager', () => ({
  default: () => <div>Estoque isolado</div>,
}))

vi.mock('@/components/operator/integrations/LlmApiCard', () => ({
  default: () => <div>LLM isolado</div>,
}))

vi.mock('@/components/operator/integrations/WhatsAppCard', () => ({
  default: () => <div>WhatsApp isolado</div>,
}))

vi.mock('@/components/operator/integrations/TelegramBotCard', () => ({
  default: () => <div>Telegram isolado</div>,
}))

vi.mock('@/components/operator/integrations/MercadoPagoCard', () => ({
  default: () => <div>Mercado Pago isolado</div>,
}))

const dashboardProps = {
  usuarioLogado: { id: 'admin-1', nome: 'Admin Asados', funcao: 'admin', ativo: true },
  usuariosIniciais: [],
  estatisticasIniciais: {
    totalIa: 0,
    totalOperador: 0,
    totalCliente: 0,
    totalMensagens: 0,
    taxaAutomacao: 0,
  },
  logsIniciais: [],
  artigosIniciais: [],
  systemConfigs: {},
}

const pendingReconciliation: StorageOrphanReconciliationListItem = {
  id: '6de82d63-0701-49fa-93ef-75bf154b9b77',
  objectPath: 'produtos/picanha/1/full.webp',
  objectCreatedAt: '2026-07-19T12:00:00.000Z',
  discoveredAt: '2026-07-20T12:00:00.000Z',
  status: 'pending',
  attempts: 0,
  error: null,
  approvedAt: null,
  completedAt: null,
}

describe('AdminDashboard storage orphan reconciliation tab', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/atendimento/admin?tab=storage-orphans')
    vi.clearAllMocks()
    vi.mocked(listarReconciliacoesImagemOrfa).mockResolvedValue({ success: true, data: [pendingReconciliation] })
  })

  afterEach(() => {
    cleanup()
    window.history.replaceState(null, '', '/atendimento/admin')
  })

  it('opens the isolated reconciliation panel from the storage-orphans query tab without scanning or deleting', async () => {
    render(<AdminDashboard {...dashboardProps} />)

    expect(await screen.findByRole('button', { name: 'Reconciliação de imagens' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Reconciliação de imagens órfãs' })).toBeInTheDocument()
    expect(await screen.findByText(pendingReconciliation.objectPath)).toBeInTheDocument()

    await waitFor(() => expect(listarReconciliacoesImagemOrfa).toHaveBeenCalledOnce())
    expect(varrerImagensOrfasEmModoDryRun).not.toHaveBeenCalled()
    expect(executarReconciliacaoImagemOrfa).not.toHaveBeenCalled()
  })
})
