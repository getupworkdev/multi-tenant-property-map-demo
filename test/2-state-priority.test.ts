import type { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'
import { STATES, getMapData } from '../src/lib/map-data'
import { ADMIN_A, TENANT_A, addActivity, asUser, importAs, makeDb, rpcAs } from './db'

let db: PGlite

// Each property gets a set of activities; the expected state is the highest-priority one.
const CASES: { id: string; activities: [string, string][]; expected: string }[] = [
  { id: 'P-none', activities: [], expected: 'available' },
  { id: 'P-rel', activities: [['relationship', 'open']], expected: 'relationship' },
  { id: 'P-rel-closed', activities: [['relationship', 'closed']], expected: 'available' },
  { id: 'P-insp', activities: [['inspection', 'open']], expected: 'in_progress' },
  { id: 'P-prop-closed', activities: [['proposal', 'closed'], ['relationship', 'open']], expected: 'relationship' },
  { id: 'P-prop-rel', activities: [['proposal', 'open'], ['relationship', 'open']], expected: 'in_progress' },
  { id: 'P-client-prop', activities: [['existing_client', 'open'], ['proposal', 'open'], ['relationship', 'open']], expected: 'existing_client' },
  { id: 'P-won-all', activities: [['work_won', 'closed'], ['existing_client', 'open'], ['inspection', 'open'], ['relationship', 'open']], expected: 'work_won' },
  { id: 'P-won-only', activities: [['work_won', 'closed']], expected: 'work_won' },
]

beforeAll(async () => {
  db = await makeDb()
  await importAs(
    db,
    TENANT_A,
    CASES.map((c, i) => ({ source_id: c.id, address: `${i + 1} Priority Rd`, owner_name: `Owner P${i}`, lat: 43.66 + i / 1000, lng: -79.42 })),
  )
  for (const c of CASES) for (const [kind, status] of c.activities) await addActivity(db, TENANT_A, c.id, kind, status)
})

describe('one state per property, chosen by priority in a single SQL view', () => {
  for (const c of CASES) {
    it(`${c.id}: ${c.activities.map((a) => a.join(':')).join(' + ') || 'no activity'} -> ${c.expected}`, async () => {
      const { rows } = await asUser(db, ADMIN_A, (tx) => tx.query<{ state: string }>('select state from public.property_states where source_id = $1', [c.id]))
      expect(rows).toEqual([{ state: c.expected }])
    })
  }

  it('the legend lists the five states in priority order, matching the app', async () => {
    const { rows } = await asUser(db, ADMIN_A, (tx) =>
      tx.query<{ state: string; color: string }>('select state, color from public.property_state_legend order by priority'),
    )
    expect(rows.map((r) => r.state)).toEqual([...STATES])
    expect(rows.every((r) => /^#[0-9a-f]{6}$/i.test(r.color))).toBe(true)
  })

  it('map features carry the view’s state, and filters return exactly those states', async () => {
    const all = await getMapData(rpcAs(db, ADMIN_A), null)
    for (const c of CASES) expect(all.features.find((f) => f.properties.source_id === c.id)?.properties.state).toBe(c.expected)

    const filtered = await getMapData(rpcAs(db, ADMIN_A), ['work_won', 'relationship'])
    expect(filtered.features.map((f) => f.properties.source_id).sort()).toEqual(['P-prop-closed', 'P-rel', 'P-won-all', 'P-won-only'])
  })
})
