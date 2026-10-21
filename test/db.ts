import { PGlite, type Transaction } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { postgis } from '@electric-sql/pglite-postgis'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
export const read = (path: string) => readFileSync(join(root, path), 'utf8')

export const TENANT_A = '0a000000-0000-4000-8000-000000000001'
export const TENANT_B = '0b000000-0000-4000-8000-000000000001'
export const ADMIN_A = 'a1000000-0000-4000-8000-000000000001'
export const MEMBER_A = 'a1000000-0000-4000-8000-000000000002'
export const ADMIN_B = 'b1000000-0000-4000-8000-000000000001'

/** In-process Postgres with PostGIS, pg_trgm, the Supabase roles, the migration and test users. */
export async function makeDb(): Promise<PGlite> {
  const db = await PGlite.create({ extensions: { postgis, pg_trgm } })
  await db.exec(read('test/supabase-shim.sql'))
  const migrations = readdirSync(join(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort()
  for (const file of migrations) await db.exec(read(`supabase/migrations/${file}`))
  await db.exec(read('test/fixtures.sql'))
  return db
}

/** Runs fn the way PostgREST would for a signed-in user (or anon when userId is null). */
export function asUser<T>(db: PGlite, userId: string | null, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec(userId ? 'set local role authenticated' : 'set local role anon')
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [userId ? JSON.stringify({ sub: userId }) : ''])
    return fn(tx)
  })
}

export async function one<T = unknown>(tx: Transaction | PGlite, sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await tx.query<{ result: T }>(sql, params)
  return rows[0].result
}

export type Row = { source_id: string; address: string; owner_name: string; lat: number | string; lng: number | string; city?: string }

/** Loads properties through the real import pipeline (as the database owner, like the seed). */
export function importAs(db: PGlite, tenant: string, rows: Row[], file = 'fixture.csv') {
  return one(db, 'select public._import_properties($1, null, $2, $3::jsonb) as result', [tenant, file, JSON.stringify(rows)])
}

export async function addActivity(db: PGlite, tenant: string, sourceId: string, kind: string, status = 'open') {
  await db.query(
    `insert into public.property_activities (tenant_id, property_id, kind, status)
     select $1, id, $3, $4 from public.properties where tenant_id = $1 and source_id = $2`,
    [tenant, sourceId, kind, status],
  )
}

/** The same function the /api/map route uses, wired to the database as a given user. */
export const rpcAs = (db: PGlite, userId: string | null) => async (fn: string, args: Record<string, unknown>) => {
  try {
    const data = await asUser(db, userId, (tx) =>
      one(tx, `select public.${fn}(${Object.keys(args).map((k, i) => `${k} => $${i + 1}`).join(', ')}) as result`, Object.values(args)),
    )
    return { data, error: null }
  } catch (e) {
    return { data: null, error: { message: (e as Error).message } }
  }
}
