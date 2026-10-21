import { redirect } from 'next/navigation'
import { Header } from '@/components/Header'
import { createClient, getMember } from '@/lib/supabase/server'
import { decide, rerunMatching } from './actions'

type Candidate = { property_id: string; address: string; owner_name: string; score: number; distance_m: number | null }
type Match = {
  contact_id: string
  status: string
  best_score: number | null
  candidates: Candidate[]
  decided_at: string | null
  crm_contacts: { name: string; address: string; external_id: string } | null
  properties: { address: string } | null
}

const STATUS_LABEL: Record<string, string> = {
  needs_review: 'Needs review',
  auto_linked: 'Auto-linked',
  approved: 'Approved',
  rejected: 'Rejected',
  no_match: 'No match',
}

export default async function ReviewPage() {
  const member = await getMember()
  if (!member) redirect('/')
  if (!member.isAdmin) redirect('/map')

  const supabase = await createClient()
  const { data } = await supabase
    .from('crm_matches')
    .select('contact_id, status, best_score, candidates, decided_at, crm_contacts(name, address, external_id), properties(address)')
    .order('status')
  const matches = (data ?? []) as unknown as Match[]
  const pending = matches.filter((m) => m.status === 'needs_review')
  const done = matches.filter((m) => m.status !== 'needs_review')

  return (
    <>
      <Header tenantName={member.tenantName} email={member.email} isAdmin={member.isAdmin} />
      <main className="page">
        <div className="row spread">
          <div>
            <h1>CRM review queue</h1>
            <p className="muted">
              CRM contacts (mocked GoHighLevel JSON) are scored against your properties: 50% address, 30% owner name, 20% distance. Clear matches
              link automatically; close calls wait here.
            </p>
          </div>
          <form action={rerunMatching}>
            <button>Re-run matching</button>
          </form>
        </div>

        <h2>Needs review ({pending.length})</h2>
        {pending.length === 0 && <p className="muted">Nothing waiting.</p>}
        {pending.map((m) => (
          <section key={m.contact_id} className="card">
            <p>
              <strong>{m.crm_contacts?.name}</strong> · {m.crm_contacts?.address}{' '}
              <span className="muted small">({m.crm_contacts?.external_id})</span>
            </p>
            <form action={decide} className="stack">
              <input type="hidden" name="contact_id" value={m.contact_id} />
              {m.candidates.map((c, i) => (
                <label key={c.property_id} className="candidate">
                  <input type="radio" name="property_id" value={c.property_id} defaultChecked={i === 0} />
                  <span>
                    {c.address} · {c.owner_name}
                    <span className="muted small">
                      {' '}
                      score {Number(c.score).toFixed(2)}
                      {c.distance_m !== null && ` · ${c.distance_m} m`}
                    </span>
                  </span>
                </label>
              ))}
              <div className="row">
                <button className="primary" name="decision" value="approve">
                  Approve selected
                </button>
                <button name="decision" value="reject">
                  Reject all
                </button>
              </div>
            </form>
          </section>
        ))}

        <h2>All matches</h2>
        <table>
          <thead>
            <tr>
              <th>Contact</th>
              <th>Status</th>
              <th>Linked property</th>
              <th className="num">Best score</th>
            </tr>
          </thead>
          <tbody>
            {done.map((m) => (
              <tr key={m.contact_id}>
                <td>
                  {m.crm_contacts?.name}
                  <div className="muted small">{m.crm_contacts?.address}</div>
                </td>
                <td>
                  <span className={`status s-${m.status}`}>{STATUS_LABEL[m.status]}</span>
                  {m.decided_at && <div className="muted small">decided {new Date(m.decided_at).toLocaleString()}</div>}
                </td>
                <td>{m.properties?.address ?? '·'}</td>
                <td className="num">{m.best_score === null ? '·' : Number(m.best_score).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </main>
    </>
  )
}
