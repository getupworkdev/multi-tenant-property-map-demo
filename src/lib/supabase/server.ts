import 'server-only'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

/**
 * Supabase as the signed-in user: every query and RPC runs under RLS with the user's JWT.
 * This app has no privileged client at all.
 */
export async function createClient() {
  const cookieStore = await cookies()
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          toSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
        } catch {
          // Server Components cannot set cookies; the proxy refreshes the session instead.
        }
      },
    },
  })
}

export type Member = { userId: string; email: string; tenantName: string; isAdmin: boolean }

export async function getMember(): Promise<Member | null> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null
  const { data } = await supabase.from('tenant_members').select('role, tenants(name)').eq('user_id', user.id).maybeSingle()
  if (!data) return null
  const tenant = data.tenants as unknown as { name: string } | null
  return { userId: user.id, email: user.email ?? '', tenantName: tenant?.name ?? '', isAdmin: data.role === 'admin' }
}
