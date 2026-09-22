export interface IntegrationCardProps {
  initialConfigs: Record<string, string>
  showToast: (type: 'success' | 'error', msg: string) => void
}

export interface EvolutionCardProps extends IntegrationCardProps {
  provedorAtivo: 'meta' | 'evolution'
  onProvedorChange: (provider: 'meta' | 'evolution') => void
}
