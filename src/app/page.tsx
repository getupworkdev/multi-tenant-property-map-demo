import { redirect } from 'next/navigation'
import { DemoLogin } from '@/components/DemoLogin'
import { getMember } from '@/lib/supabase/server'

export default async function Home() {
  if (await getMember()) redirect('/map')
  return (
    <main className="page">
      <section className="card login">
        <h1>Multi-tenant property map</h1>
        <p className="muted">
          Two fictional client companies share one database. Each sees only its own ~150 made-up properties around Toronto, coloured by
          relationship state. Isolation is enforced by Postgres row-level security, not by the screen.
        </p>
        <DemoLogin />
      </section>
    </main>
  )
}
