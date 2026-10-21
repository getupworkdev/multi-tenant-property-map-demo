import type { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'
import { csvToRecords, parseCsv } from '../src/lib/csv'
import { ADMIN_A, MEMBER_A, TENANT_A, TENANT_B, asUser, makeDb, one, read } from './db'

let db: PGlite
const feed = csvToRecords(read('data/sample-feed.csv'))

type ImportResult = { batch_id: string; inserted: number; updated: number; unchanged: number; rejected: number; rejected_rows: unknown[] }

const importFeed = (user: string, rows: unknown[], file = 'sample-feed.csv') =>
  asUser(db, user, (tx) => one<ImportResult>(tx, 'select public.import_properties($1, $2::jsonb) as result', [file, JSON.stringify(rows)]))

const count = async (tenant: string) =>
  (await db.query<{ n: number }>('select count(*)::int as n from public.properties where tenant_id = $1', [tenant])).rows[0].n

beforeAll(async () => {
  db = await makeDb()
})

describe('CSV bulk feed -> staging -> validation -> merge in one transaction', () => {
  it('parses quoted fields, escaped quotes and CRLF', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
    ])
  })

  it('imports the good rows and rejects and reports each bad one', async () => {
    const result = await importFeed(ADMIN_A, feed)
    expect(result).toMatchObject({ inserted: 9, updated: 0, unchanged: 0, rejected: 3 })
    expect(result.rejected_rows).toEqual([
      { row: 4, source_id: 'FEED-0001', error: 'duplicate source_id in file' },
      { row: 11, source_id: 'FEED-9001', error: 'lat/lng out of range' },
      { row: 12, source_id: 'bad id!', error: 'invalid source_id' },
    ])
    expect(await count(TENANT_A)).toBe(9)

    // Every row is kept in staging with its outcome.
    const { rows } = await db.query<{ status: string; n: number }>(
      'select status, count(*)::int as n from public.import_rows where batch_id = $1 group by status order by status',
      [result.batch_id],
    )
    expect(rows).toEqual([
      { status: 'rejected', n: 3 },
      { status: 'valid', n: 9 },
    ])
  })

  it('re-importing the same file creates no duplicates and changes nothing', async () => {
    const again = await importFeed(ADMIN_A, feed)
    expect(again).toMatchObject({ inserted: 0, updated: 0, unchanged: 9, rejected: 3 })
    expect(await count(TENANT_A)).toBe(9)
  })

  it('a changed row is updated in place, keyed by its source ID', async () => {
    const changed = feed.map((r) => (r.source_id === 'FEED-0002' ? { ...r, owner_name: 'Owner 002 (new)' } : r))
    const result = await importFeed(ADMIN_A, changed)
    expect(result).toMatchObject({ inserted: 0, updated: 1, unchanged: 8 })
    const owner = await one(db, `select owner_name as result from public.properties where tenant_id = $1 and source_id = 'FEED-0002'`, [TENANT_A])
    expect(owner).toBe('Owner 002 (new)')
  })

  it('a failure part-way rolls back the whole batch', async () => {
    const before = await count(TENANT_A)
    const batchesBefore = await one(db, 'select count(*)::int as result from public.import_batches')
    // A non-array payload fails after nothing is merged; the batch row must not survive either.
    await expect(importFeed(ADMIN_A, { not: 'an array' } as unknown as unknown[])).rejects.toThrow(/JSON array/)
    expect(await count(TENANT_A)).toBe(before)
    expect(await one(db, 'select count(*)::int as result from public.import_batches')).toBe(batchesBefore)
  })

  it('imports land in the caller’s tenant only, and only admins can import', async () => {
    expect(await count(TENANT_B)).toBe(0)
    await expect(importFeed(MEMBER_A, feed)).rejects.toThrow(/only tenant admins/)
  })
})
