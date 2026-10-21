// Shared by the /api/map route and the tests: the route passes the Supabase client's rpc
// (running with the signed-in user's JWT), the tests pass an in-process Postgres.

export const STATES = ['work_won', 'existing_client', 'in_progress', 'relationship', 'available'] as const
export type PropertyState = (typeof STATES)[number]

export type FeatureCollection = {
  type: 'FeatureCollection'
  features: {
    type: 'Feature'
    id: string
    geometry: { type: 'Point'; coordinates: [number, number] }
    properties: { id: string; state: PropertyState; address: string; owner: string; source_id: string }
  }[]
}

export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>

/** "work_won,available" -> ['work_won', 'available']; unknown values are dropped; empty -> all states. */
export function parseStates(param: string | null): PropertyState[] | null {
  if (!param) return null
  const wanted = param.split(',').map((s) => s.trim())
  const valid = STATES.filter((s) => wanted.includes(s))
  return valid.length ? valid : null
}

export async function getMapData(rpc: Rpc, states: PropertyState[] | null): Promise<FeatureCollection> {
  const { data, error } = await rpc('map_features', { p_states: states })
  if (error) throw new Error(error.message)
  return data as FeatureCollection
}
