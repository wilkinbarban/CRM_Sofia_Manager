import { BrandLogo } from '@/components/ui/BrandLogo'
import { OperatorLogoutButton } from '@/components/operator/OperatorLogoutButton'
import { OperatorTopNavigation } from '@/components/operator/OperatorTopNavigation'
import { resolveBusinessProfileSync } from '@/lib/config/business-profile'

export type WorkspaceBrand = {
  name?: string
  shortName?: string
  subtitle?: string
}

type OperatorWorkspaceHeaderProps = {
  active: 'atendimento' | 'pedidos' | 'admin' | 'estoque' | 'conhecimento' | 'perfil'
  role: string
  adminTab?: string
  brand?: WorkspaceBrand
}

function roleLabel(role: string) {
  if (role === 'admin') return 'Administrador'
  if (role === 'supervisor') return 'Supervisor'
  return 'Atendente'
}

export function OperatorWorkspaceHeader({ active, role, adminTab, brand }: OperatorWorkspaceHeaderProps) {
  // O perfil vem do servidor quando disponível; sem ele o cabeçalho ainda usa
  // o perfil resolvido por ambiente, nunca um texto fixo.
  const fallbackProfile = resolveBusinessProfileSync()
  const brandName = brand?.name?.trim() || fallbackProfile.name
  const brandShortName = brand?.shortName?.trim() || fallbackProfile.shortName || brandName
  const brandSubtitle = brand?.subtitle?.trim() || fallbackProfile.location

  return (
    <header
      data-testid="operator-workspace-header"
      className="sticky top-0 z-40 flex min-h-16 w-full items-center gap-3 overflow-hidden border-b border-zinc-800 bg-zinc-900/80 px-3 py-2 backdrop-blur-md sm:px-6"
    >
      <div className="hidden shrink-0 items-center gap-2.5 sm:flex">
        <BrandLogo size="md" href="/atendimento" brandName={brandName} subtitle={brandSubtitle} />
        <span className="hidden rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold tracking-wider text-amber-400 uppercase xl:inline-block">
          {brandShortName}
        </span>
      </div>
      <div className="ml-auto flex min-w-0 items-center gap-2">
        <OperatorTopNavigation active={active} role={role} adminTab={adminTab} />
        <OperatorLogoutButton />
      </div>
      <div className="hidden shrink-0 items-center gap-2 border-l border-zinc-800 pl-2 xl:flex">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
        </span>
        <span className="text-xs font-medium text-zinc-300">{roleLabel(role)}</span>
      </div>
    </header>
  )
}
