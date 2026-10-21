import type { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'
import { ADMIN_A, MEMBER_A, TENANT_A, asUser, importAs, makeDb, one } from './db'

let db: PGlite

type Match = { contact: string; status: string; property: string | null; best_score: number | null; candidates: { property_id: string; score: number }[] }

const PROPERTIES = [
  { source_id: 'M-1', address: '37 Birch Rd', owner_name: 'Owner 004', lat: 43.661, lng: -79.441 },
  { source_id: 'M-2', address: '150 Willow Dr', owner_name: 'Owner 018', lat: 43.67, lng: -79.43 },
  { source_id: 'M-3', address: '400 Cedar Ave Unit 1', owner_name: 'Owner 157', lat: 43.68, lng: -79.45 },
  { source_id: 'M-4', address: '400 Cedar Ave Unit 2', owner_name: 'Owner 158', lat: 43.68004, lng: -79.45 },
  { source_id: 'M-5', address: '251 Birch Rd', owner_name: 'Owner 061', lat: 43.69, lng: -79.42 },
]

const CONTACTS = [
  // Clear match: same address written out in full, same owner, a few metres away.
  { id: 'c-exact', contactName: 'Owner 004', address1: '37 Birch Road', latitude: 43.66103, longitude: -79.441 },
  // Clear match despite a company suffix on the name.
  { id: 'c-suffix', contactName: 'Owner 018 Holdings Inc.', address1: '150 Willow Dr', latitude: 43.67, longitude: -79.43 },
  // Ambiguous: the building address matches two units equally well.
  { id: 'c-building', contactName: 'Cedar Building Management', address1: '400 Cedar Ave', latitude: 43.68002, longitude: -79.45 },
  // Ambiguous: misspelt street and ~200 m off, right owner.
  { id: 'c-typo', contactName: 'Owner 061', address1: '251 Brich Rd', latitude: 43.692, longitude: -79.42 },
  // No match: nothing nearby or similar.
  { id: 'c-none', contactName: 'Unrelated Contact', address1: 'PO Box 2001', latitude: 43.8561, longitude: -79.337 },
]

const matches = async (): Promise<Record<string, Match>> => {
  const { rows } = await db.query<Match>(
    `select c.external_id as contact, m.status, p.source_id as property, m.best_score::float8 as best_score, m.candidates
     from public.crm_matches m join public.crm_contacts c on c.id = m.contact_id
     left join public.properties p on p.id = m.property_id`,
  )
  return Object.fromEntries(rows.map((r) => [r.contact, r]))
}

const contactId = (external: string) => one<string>(db, 'select id as result from public.crm_contacts where external_id = $1', [external])
const propertyId = (source: string) => one<string>(db, 'select id as result from public.properties where source_id = $1', [source])

beforeAll(async () => {
  db = await makeDb()
  await importAs(db, TENANT_A, PROPERTIES)
  await db.query('select public._load_crm_contacts($1, $2::jsonb)', [TENANT_A, JSON.stringify(CONTACTS)])
  await asUser(db, ADMIN_A, (tx) => tx.query('select public.run_crm_matching()'))
})

describe('CRM matching: auto-link clear matches, queue ambiguous ones, record decisions', () => {
  it('auto-links clear matches (address normalised, company suffix ignored)', async () => {
    const m = await matches()
    expect(m['c-exact']).toMatchObject({ status: 'auto_linked', property: 'M-1' })
    expect(m['c-suffix']).toMatchObject({ status: 'auto_linked', property: 'M-2' })
    expect(m['c-exact'].best_score).toBeGreaterThanOrEqual(0.85)
  })

  it('sends ambiguous contacts to the review queue with ranked candidates and no link', async () => {
    const m = await matches()
    expect(m['c-building']).toMatchObject({ status: 'needs_review', property: null })
    expect(m['c-building'].candidates.map((c) => c.score)).toEqual([...m['c-building'].candidates.map((c) => c.score)].sort((a, b) => b - a))
    expect(m['c-building'].candidates.length).toBeGreaterThanOrEqual(2)
    expect(m['c-typo']).toMatchObject({ status: 'needs_review', property: null })
  })

  it('marks contacts with nothing similar or nearby as no match', async () => {
    expect((await matches())['c-none']).toMatchObject({ status: 'no_match', property: null, candidates: [] })
  })

  it('an admin approves one candidate; the link, the reviewer and the decision log are stored', async () => {
    const contact = await contactId('c-building')
    const unit2 = await propertyId('M-4')
    await asUser(db, ADMIN_A, (tx) => tx.query(`select public.decide_match($1, 'approve', $2)`, [contact, unit2]))

    expect((await matches())['c-building']).toMatchObject({ status: 'approved', property: 'M-4' })
    const { rows } = await db.query('select decision, decided_by from public.crm_match_decisions where contact_id = $1', [contact])
    expect(rows).toEqual([{ decision: 'approve', decided_by: ADMIN_A }])
  })

  it('an admin rejects a candidate list; approving a non-candidate property is refused', async () => {
    const contact = await contactId('c-typo')
    const notACandidate = await propertyId('M-2')
    await expect(
      asUser(db, ADMIN_A, (tx) => tx.query(`select public.decide_match($1, 'approve', $2)`, [contact, notACandidate])),
    ).rejects.toThrow(/candidate/)
    await asUser(db, ADMIN_A, (tx) => tx.query(`select public.decide_match($1, 'reject')`, [contact]))
    expect((await matches())['c-typo']).toMatchObject({ status: 'rejected', property: null })
  })

  it('re-running matching never overrides a human decision', async () => {
    await asUser(db, ADMIN_A, (tx) => tx.query('select public.run_crm_matching()'))
    const m = await matches()
    expect(m['c-building']).toMatchObject({ status: 'approved', property: 'M-4' })
    expect(m['c-typo']).toMatchObject({ status: 'rejected' })
    expect(m['c-exact']).toMatchObject({ status: 'auto_linked' })
  })

  it('members can see matches but only admins can decide them', async () => {
    const contact = await contactId('c-exact')
    await expect(asUser(db, MEMBER_A, (tx) => tx.query(`select public.decide_match($1, 'reject')`, [contact]))).rejects.toThrow(/only tenant admins/)
  })
})
