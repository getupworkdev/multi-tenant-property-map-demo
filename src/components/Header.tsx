'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/browser'

export function Header({ tenantName, email, isAdmin }: { tenantName: string; email: string; isAdmin: boolean }) {
  const router = useRouter()
  const pathname = usePathname()

  async function signOut() {
    await createClient().auth.signOut()
    router.replace('/')
    router.refresh()
  }

  return (
    <header className="top">
      <div>
        <strong>{tenantName}</strong>
        <span className="muted small"> · {email}</span>
      </div>
      <nav>
        <Link href="/map" aria-current={pathname === '/map' ? 'page' : undefined}>
          Map
        </Link>
        {isAdmin && (
          <Link href="/admin/review" aria-current={pathname.startsWith('/admin') ? 'page' : undefined}>
            CRM review queue
          </Link>
        )}
        <button onClick={signOut}>Sign out</button>
      </nav>
    </header>
  )
}
