'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/browser'

const ACCOUNTS = [
  { label: 'Sign in as Tenant A', email: 'tenant-a.demo@example.com', password: 'tenant-a-demo-2026' },
  { label: 'Sign in as Tenant B', email: 'tenant-b.demo@example.com', password: 'tenant-b-demo-2026' },
]

export function DemoLogin() {
  const router = useRouter()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  async function signIn(email: string, password: string) {
    setBusy(email)
    setError('')
    const { error } = await createClient().auth.signInWithPassword({ email, password })
    if (error) {
      setError(error.message)
      setBusy('')
      return
    }
    router.replace('/map')
    router.refresh()
  }

  return (
    <div className="stack">
      {ACCOUNTS.map((a) => (
        <button key={a.email} className="primary" disabled={!!busy} onClick={() => signIn(a.email, a.password)}>
          {busy === a.email ? 'Signing in…' : a.label}
        </button>
      ))}
      {error && <p className="error">{error}</p>}
    </div>
  )
}
