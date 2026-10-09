import { redirect } from 'next/navigation'
import { verificarPermissaoQualquerOperador } from '@/app/actions/perfil'
import PerfilForm from '@/components/operator/PerfilForm'
import { OperatorWorkspaceHeader } from '@/components/operator/OperatorWorkspaceHeader'
import { getBusinessProfile } from '@/lib/config/business-profile'

export const dynamic = 'force-dynamic'

export default async function PerfilPage() {
  const check = await verificarPermissaoQualquerOperador()

  if (!check.authorized || !check.user || !check.perfil) {
    redirect('/login')
  }

  const { user, perfil } = check

  const operatorInfo = {
    id: perfil.id,
    nome: perfil.nome || '',
    email: user.email || '',
    funcao: perfil.funcao || '',
  }

  const businessProfile = await getBusinessProfile()

  return (
    <div className="flex min-h-screen w-full flex-col bg-zinc-950 text-zinc-50 font-sans">
      <OperatorWorkspaceHeader
        active="perfil"
        role={perfil.funcao}
        brand={{
          name: businessProfile.name,
          shortName: businessProfile.shortName,
          subtitle: businessProfile.location,
        }}
      />
      <main className="flex-1 overflow-y-auto">
        <PerfilForm operatorInfo={operatorInfo} />
      </main>
    </div>
  )
}
