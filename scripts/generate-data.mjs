// Generates the fictional demo data: ~300 properties in two tenants around Toronto, their activity,
// a sample "bulk feed" CSV with deliberate bad rows, and mocked CRM contacts. Deterministic.
//   node scripts/generate-data.mjs
import { mkdirSync, writeFileSync } from 'node:fs'

export const TENANT_A = '0a000000-0000-4000-8000-000000000001'
export const TENANT_B = '0b000000-0000-4000-8000-000000000001'

function mulberry32(seed) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const STREETS = ['Maple St', 'Cedar Ave', 'Birch Rd', 'Willow Dr', 'Elm St', 'Spruce Ave', 'Juniper Cres', 'Alder Rd',
  'Linden Blvd', 'Poplar St', 'Hawthorn Ave', 'Sumac Dr', 'Larch Ln', 'Rowan Ct', 'Hazel Pl']

function properties(tenant, prefix, count, lngMin, lngMax, rand) {
  const rows = []
  const used = new Set()
  for (let i = 1; rows.length < count; i++) {
    const street = STREETS[Math.floor(rand() * STREETS.length)]
    const number = 1 + Math.floor(rand() * 298)
    const address = `${number} ${street}`
    if (used.has(address)) continue
    used.add(address)
    rows.push({
      source_id: `${prefix}-${String(rows.length + 1).padStart(4, '0')}`,
      address,
      city: 'Toronto',
      postcode: `M${1 + Math.floor(rand() * 9)}${'ABCEGHJKLMNPRSTVXY'[Math.floor(rand() * 18)]} ${Math.floor(rand() * 10)}${'ABCEGHJKLMNPRSTVWXYZ'[Math.floor(rand() * 20)]}${Math.floor(rand() * 10)}`,
      owner_name: `Owner ${String(rows.length + 1 + (prefix.endsWith('A') ? 0 : 500)).padStart(3, '0')}`,
      lat: +(43.645 + rand() * 0.07).toFixed(6),
      lng: +(lngMin + rand() * (lngMax - lngMin)).toFixed(6),
    })
  }
  // Two small buildings with two units each: the CRM contacts for these are deliberately ambiguous.
  for (const [k, street] of [[0, 'Cedar Ave'], [1, 'Linden Blvd']]) {
    const base = rows[10 + k]
    for (const unit of [1, 2]) {
      rows.push({
        source_id: `${prefix}-${String(rows.length + 1).padStart(4, '0')}`,
        address: `${400 + k} ${street} Unit ${unit}`,
        city: 'Toronto',
        postcode: base.postcode,
        owner_name: `Owner ${String(rows.length + 1 + (prefix.endsWith('A') ? 0 : 500)).padStart(3, '0')}`,
        lat: +(base.lat + unit * 0.00004).toFixed(6),
        lng: base.lng,
      })
    }
  }
  return rows
}

function activities(rows, rand) {
  const out = []
  for (const p of rows) {
    const r = rand()
    if (r < 0.12) out.push([p.source_id, 'work_won', 'closed'])
    else if (r < 0.22) out.push([p.source_id, 'existing_client', 'open'])
    else if (r < 0.31) out.push([p.source_id, 'inspection', 'open'])
    else if (r < 0.37) out.push([p.source_id, 'proposal', 'open'])
    else if (r < 0.50) out.push([p.source_id, 'relationship', 'open'])
    // Mixed histories, so the priority rules have work to do.
    if (r < 0.12 && rand() < 0.5) out.push([p.source_id, 'relationship', 'open'])
    if (r >= 0.31 && r < 0.37 && rand() < 0.4) out.push([p.source_id, 'relationship', 'open'])
    if (r >= 0.5 && rand() < 0.05) out.push([p.source_id, 'proposal', 'closed'])
  }
  return out
}

// Mocked CRM contacts in a GoHighLevel-like shape (the real API returns no coordinates;
// here they stand in for a geocoded address).
function contacts(rows, prefix) {
  const unit = (n) => rows.find((r) => r.address.endsWith(`Unit ${n}`) && r.address.startsWith('400'))
  const exact = [rows[3], rows[17], rows[42]]
  const typo = rows[60]
  return [
    ...exact.map((p, i) => ({
      id: `ghl_${prefix}_exact_${i + 1}`,
      contactName: `${p.owner_name}${i === 1 ? ' Holdings Inc.' : ''}`,
      address1: i === 0 ? p.address.replace(/\bSt$/, 'Street').replace(/\bAve$/, 'Avenue').replace(/\bRd$/, 'Road') : p.address,
      city: p.city,
      postalCode: p.postcode,
      latitude: p.lat + 0.00003,
      longitude: p.lng,
    })),
    {
      id: `ghl_${prefix}_building_1`,
      contactName: 'Cedar Building Management',
      address1: unit(1).address.replace(' Unit 1', ''),
      city: 'Toronto',
      postalCode: unit(1).postcode,
      latitude: unit(1).lat,
      longitude: unit(1).lng,
    },
    {
      id: `ghl_${prefix}_typo`,
      contactName: typo.owner_name,
      // A misspelt street name ("Brich" for "Birch"), slightly off position.
      address1: typo.address.replace(/^(\d+ \w)(\w)(\w)/, '$1$3$2'),
      city: 'Toronto',
      postalCode: typo.postcode,
      latitude: typo.lat + 0.002,
      longitude: typo.lng,
    },
    {
      id: `ghl_${prefix}_none`,
      contactName: 'Unrelated Contact',
      address1: 'PO Box 2001',
      city: 'Markham',
      postalCode: 'L3R 0Z9',
      latitude: 43.8561,
      longitude: -79.337,
    },
  ]
}

const dollarQuote = (value) => `$json$${JSON.stringify(value)}$json$::jsonb`

export function build() {
  const rand = mulberry32(20261021)
  const a = properties(TENANT_A, 'LBX-A', 156, -79.47, -79.4, rand)
  const b = properties(TENANT_B, 'LBX-B', 136, -79.4, -79.33, rand)
  const actA = activities(a, rand)
  const actB = activities(b, rand)
  return { a, b, actA, actB, contactsA: contacts(a, 'a'), contactsB: contacts(b, 'b') }
}

function activityInsert(tenant, acts) {
  const values = acts.map(([sid, kind, status]) => `('${sid}', '${kind}', '${status}')`).join(',\n    ')
  return `insert into public.property_activities (tenant_id, property_id, kind, status)
select '${tenant}', p.id, v.kind, v.status
from (values
    ${values}) as v (source_id, kind, status)
join public.properties p on p.tenant_id = '${tenant}' and p.source_id = v.source_id;`
}

function toCsv(rows) {
  const cols = ['source_id', 'address', 'city', 'postcode', 'owner_name', 'lat', 'lng']
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v))
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c] ?? '')).join(','))].join('\n') + '\n'
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { a, b, actA, actB, contactsA, contactsB } = build()
  const seed = `-- Generated by scripts/generate-data.mjs. Fictional data only.
-- Properties are loaded through the same import pipeline the app uses.

insert into public.tenants (id, slug, name) values
    ('${TENANT_A}', 'tenant-a', 'Tenant A (fictional)'),
    ('${TENANT_B}', 'tenant-b', 'Tenant B (fictional)');

select public._import_properties('${TENANT_A}', null, 'lightbox-feed-tenant-a.csv', ${dollarQuote(a)});
select public._import_properties('${TENANT_B}', null, 'lightbox-feed-tenant-b.csv', ${dollarQuote(b)});

${activityInsert(TENANT_A, actA)}

${activityInsert(TENANT_B, actB)}

select public._load_crm_contacts('${TENANT_A}', ${dollarQuote(contactsA)});
select public._load_crm_contacts('${TENANT_B}', ${dollarQuote(contactsB)});
select public._run_crm_matching('${TENANT_A}');
select public._run_crm_matching('${TENANT_B}');
`
  writeFileSync('supabase/seed.sql', seed)

  // A small sample feed with three bad rows, used by the import tests and the README.
  mkdirSync('data', { recursive: true })
  const sample = a.slice(0, 9).map((r) => ({ ...r, source_id: r.source_id.replace('LBX-A', 'FEED') }))
  sample.splice(3, 0, { ...sample[0], address: '1 Error Row', owner_name: 'Owner X' }) // duplicate source_id
  sample.push({ source_id: 'FEED-9001', address: '10 Nowhere St', city: 'Toronto', postcode: '', owner_name: 'Owner Y', lat: 95.5, lng: -79.4 })
  sample.push({ source_id: 'bad id!', address: '11 Nowhere St', city: 'Toronto', postcode: '', owner_name: 'Owner Z', lat: 43.7, lng: -79.4 })
  writeFileSync('data/sample-feed.csv', toCsv(sample))
  writeFileSync('data/crm-contacts-tenant-a.json', JSON.stringify(contactsA, null, 2) + '\n')
  console.log(`tenant A ${a.length} properties, ${actA.length} activities; tenant B ${b.length} properties, ${actB.length} activities`)
}
