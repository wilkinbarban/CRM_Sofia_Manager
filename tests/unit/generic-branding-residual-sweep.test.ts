import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const runtimeSources = [
  'apps/web/src/app/cadastro/page.tsx',
  'apps/web/src/app/cliente/verificar-telefone/page.tsx',
  'apps/web/src/app/verificar-email/VerificarEmailClient.tsx',
  'apps/web/src/components/chat/ChatContainer.tsx',
  'apps/web/src/components/cliente/ClienteOrdersDashboard.tsx',
  'apps/web/src/components/cliente/ModalPagamentoCliente.tsx',
  'apps/web/src/components/comprovantes/ModalVisualizadorComprovante.tsx',
  'apps/web/src/components/operator/AdminDashboard.tsx',
  'apps/web/src/components/operator/ConversationsQueue.tsx',
  'apps/web/src/components/operator/OperatorCartPanel.tsx',
  'apps/web/src/components/operator/OperatorChatConsole.tsx',
  'apps/web/src/components/operator/OperatorClientOrdersList.tsx',
  'apps/web/src/components/operator/OperatorInboxContainer.tsx',
  'apps/web/src/components/operator/OrdersManagementDashboard.tsx',
  'apps/web/src/components/operator/PaymentProofAdminPanel.tsx',
  'apps/web/src/lib/ai/tools.ts',
  'apps/web/src/lib/whatsapp/action-router.ts',
  'apps/web/src/lib/whatsapp/gateways/catalog-gateway.ts',
] as const

const sourceText = Object.fromEntries(
  runtimeSources.map((source) => [source, readFileSync(join(process.cwd(), source), 'utf8')]),
)

const combinedRuntimeSource = Object.values(sourceText).join('\n')

const compatibilityMigrationSource = readFileSync(
  join(process.cwd(), 'apps/web/src/lib/notifications/sound-preference.ts'),
  'utf8',
)

const retiredCopy = [
  'Tradição em Assados de Domingo',
  'Domingo de Assados no Umbará',
  'Balcão Umbará',
  'assados de domingo',
  'assados no bafo',
  'assados especiais',
  'Cardápio Oficial de Domingo',
  'logo-brasa-sabor.png',
  'curitibanas',
  'curitibano',
]

describe('generic CRM branding residual sweep', () => {
  it('removes retired business and location copy from runtime sources', () => {
    for (const copy of retiredCopy) {
      expect(combinedRuntimeSource).not.toContain(copy)
    }
  })

  it('uses only neutral CRM event and storage namespaces', () => {
    expect(combinedRuntimeSource).not.toMatch(/asados:/i)
    expect(combinedRuntimeSource).not.toMatch(/asados_/i)
    expect(combinedRuntimeSource).toContain('crm:order-updated')
    expect(combinedRuntimeSource).toContain('crm:open-attachment-preview')
    expect(compatibilityMigrationSource).toContain('crm_notificacoes_som')
    expect(compatibilityMigrationSource).toContain('asados_notificacoes_som')
  })

  it('keeps Curitiba DDD 41 phone validation intact', () => {
    expect(sourceText['apps/web/src/app/cadastro/page.tsx']).toContain("digits.length === 11 && digits.startsWith('419')")
    expect(sourceText['apps/web/src/app/cliente/verificar-telefone/page.tsx']).toMatch(/\^419\[0-9\]\{8\}\$/)
    expect(sourceText['apps/web/src/components/operator/OperatorChatConsole.tsx']).toMatch(/\^55419\[0-9\]\{8\}\$/)
  })
})
