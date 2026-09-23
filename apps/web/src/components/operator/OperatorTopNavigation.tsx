import Link from 'next/link'
import {
  BookOpen,
  Boxes,
  ClipboardList,
  LayoutDashboard,
  MessageSquare,
  ShieldCheck,
  Store,
  UserRound,
} from 'lucide-react'

type OperatorModule = 'atendimento' | 'pedidos' | 'admin' | 'estoque' | 'conhecimento' | 'perfil'

type OperatorTopNavigationProps = {
  active: OperatorModule
  role: string
  adminTab?: string
}

const commonItems = [
  { id: 'atendimento', label: 'Atendimento', href: '/atendimento', icon: MessageSquare },
  { id: 'pedidos', label: 'Pedidos', href: '/atendimento/pedidos', icon: ClipboardList },
] as const

const roleItems = {
  admin: [
    { id: 'admin', label: 'Administração', href: '/atendimento/admin', icon: LayoutDashboard },
  ],
  supervisor: [
    { id: 'admin', label: 'Operacional & Vendas', href: '/atendimento/admin?tab=estoque', icon: Store },
    { id: 'admin', label: 'Governança & Gestão', href: '/atendimento/admin?tab=operadores', icon: ShieldCheck },
    { id: 'estoque', label: 'Estoque', href: '/atendimento/produtos', icon: Boxes },
    { id: 'conhecimento', label: 'Base RAG', href: '/atendimento/conhecimento', icon: BookOpen },
  ],
  vendedor: [],
} as const

const profileItem = { id: 'perfil', label: 'Meu Perfil', href: '/atendimento/perfil', icon: UserRound } as const

const operationalAdminTabs = new Set(['estoque', 'horarios', 'comprovantes'])

export function OperatorTopNavigation({ active, role, adminTab }: OperatorTopNavigationProps) {
  const normalizedRole = role === 'admin' || role === 'supervisor' ? role : 'vendedor'
  const items = [...commonItems, ...roleItems[normalizedRole], profileItem]

  return (
    <nav
      aria-label="Módulos do atendimento"
      data-visual-treatment="segmented"
      data-header-alignment="adjacent-to-logout"
      className="min-w-0 overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950/45 p-1 shadow-inner shadow-black/20"
    >
      <div className="flex min-w-max items-center gap-1">
        {items.map((item) => {
            const Icon = item.icon
            const isSupervisorAdminItem = normalizedRole === 'supervisor' && item.id === 'admin'
            const itemTab = new URL(item.href, 'https://crmsofiamanager.local').searchParams.get('tab')
            const isActive = item.id === active && (
              !isSupervisorAdminItem ||
              (itemTab === 'estoque' ? operationalAdminTabs.has(adminTab ?? '') : !operationalAdminTabs.has(adminTab ?? ''))
            )
            return (
              <Link
                key={`${item.id}:${item.href}`}
                href={item.href}
                aria-current={isActive ? 'page' : undefined}
                className={`inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 ${
                  isActive
                    ? 'bg-amber-500 text-zinc-950 shadow-sm shadow-amber-500/20'
                    : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{item.label}</span>
              </Link>
            )
          })}
      </div>
    </nav>
  )
}
