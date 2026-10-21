import type { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { getMapData } from '../src/lib/map-data'
import { ADMIN_A, ADMIN_B, MEMBER_A, TENANT_A, TENANT_B, addActivity, asUser, importAs, makeDb, read, rpcAs } from './db'

let db: PGlite
const TABLES = ['properties', 'property_activities', 'property_states', 'import_batches', 'import_rows', 'crm_contacts', 'crm_matches', 'crm_match_decisions']

beforeAll(async () => {
  db = await makeDb()
  const rows = (prefix: string, lng: number) =>
    Array.from({ length: 5 }, (_, i) => ({ source_id: `${prefix}-${i}`, address: `${i + 1} Test St`, owner_name: `Owner ${prefix}${i}`, lat: 43.65 + i / 1000, lng }))
  await importAs(db, TENANT_A, rows('A', -79.45))
  await importAs(db, TENANT_B, rows('B', -79.35))
  await addActivity(db, TENANT_B, 'B-0', 'work_won')
  await db.query(`select public._load_crm_contacts($1, $2::jsonb)`, [TENANT_B, JSON.stringify([{ id: 'b1', contactName: 'Owner B0', address1: '1 Test St', latitude: 43.65, longitude: -79.35 }])])
  await db.query(`select public._run_crm_matching($1)`, [TENANT_B])
  await asUser(db, ADMIN_B, (tx) => tx.query(`select public.decide_match(contact_id, 'reject') from public.crm_matches`))
})

const countTenantRows = (user: string | null, table: string, tenant: string) =>
  asUser(db, user, async (tx) => (await tx.query<{ n: number }>(`select count(*)::int as n from public.${table} where tenant_id = $1`, [tenant])).rows[0].n)

describe('tenant isolation is enforced by the database', () => {
  for (const table of TABLES) {
    it(`Tenant A sees zero Tenant B rows in ${table}`, async () => {
      expect(await countTenantRows(ADMIN_A, table, TENANT_B)).toBe(0)
      expect(await countTenantRows(MEMBER_A, table, TENANT_B)).toBe(0)
    })
  }

  it('Tenant B rows really exist (the zeros above are RLS, not empty tables)', async () => {
    for (const table of ['properties', 'property_states', 'crm_matches', 'crm_match_decisions']) {
      expect(await countTenantRows(ADMIN_B, table, TENANT_B)).toBeGreaterThan(0)
    }
  })

  it('the map data endpoint returns only the caller tenant’s features', async () => {
    const a = await getMapData(rpcAs(db, ADMIN_A), null)
    const b = await getMapData(rpcAs(db, ADMIN_B), null)
    expect(a.features.map((f) => f.properties.source_id).sort()).toEqual(['A-0', 'A-1', 'A-2', 'A-3', 'A-4'])
    expect(b.features.every((f) => f.properties.source_id.startsWith('B-'))).toBe(true)
    // Asking the endpoint for a state that only Tenant B has still returns nothing for Tenant A.
    expect((await getMapData(rpcAs(db, ADMIN_A), ['work_won'])).features).toHaveLength(0)
    expect((await getMapData(rpcAs(db, ADMIN_B), ['work_won'])).features).toHaveLength(1)
  })

  it('a Tenant A admin cannot decide a Tenant B match', async () => {
    const { rows } = await db.query<{ contact_id: string }>('select contact_id from public.crm_matches where tenant_id = $1', [TENANT_B])
    await expect(asUser(db, ADMIN_A, (tx) => tx.query(`select public.decide_match($1, 'reject')`, [rows[0].contact_id]))).rejects.toThrow(
      /match not found/,
    )
  })

  it('nobody writes to the tables directly, and anonymous callers read nothing', async () => {
    await expect(
      asUser(db, ADMIN_A, (tx) => tx.query(`update public.properties set owner_name = 'x' where tenant_id = $1`, [TENANT_B])),
    ).rejects.toThrow(/permission denied/)
    await expect(countTenantRows(null, 'properties', TENANT_A)).rejects.toThrow(/permission denied/)
    const anon = await getMapData(rpcAs(db, null), null).catch((e: Error) => e.message)
    expect(anon).toMatch(/permission denied/)
  })

  it('the app never uses a service-role key: no reference anywhere in the source or env names', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.(ts|tsx|js|mjs)$/.test(name)) files.push(path)
      }
    }
    walk(join(import.meta.dirname, '../src'))
    expect(files.length).toBeGreaterThan(5)
    for (const file of files) expect(readFileSync(file, 'utf8')).not.toMatch(/service[_-]?role/i)
    expect(read('.env.example')).not.toMatch(/service[_-]?role/i)
  })
})
