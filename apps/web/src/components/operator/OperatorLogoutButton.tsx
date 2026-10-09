'use client'

import { LogOut } from 'lucide-react'
import { useFormStatus } from 'react-dom'
import { logout } from '@/app/actions/auth'

function SubmitButton() {
  const { pending } = useFormStatus()

  return (
    <button
      aria-label={pending ? 'Saindo…' : 'Sair'}
      className="flex min-h-11 sm:min-h-9 items-center gap-1.5 rounded-lg border border-rose-500/20 bg-rose-500/5 px-3 py-1.5 text-xs font-semibold text-rose-400 transition-colors hover:bg-rose-500/10 hover:text-rose-300 disabled:cursor-wait disabled:opacity-60"
      disabled={pending}
      type="submit"
    >
      <LogOut aria-hidden="true" className="h-3.5 w-3.5" />
      <span>{pending ? 'Saindo…' : 'Sair'}</span>
    </button>
  )
}

export function OperatorLogoutButton() {
  return (
    <form action={logout}>
      <SubmitButton />
    </form>
  )
}
