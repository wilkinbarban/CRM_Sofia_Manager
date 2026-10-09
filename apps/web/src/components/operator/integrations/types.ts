export interface IntegrationCardProps {
  initialConfigs: Record<string, string>
  showToast: (type: 'success' | 'error', msg: string) => void
}
