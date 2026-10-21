import { NextResponse, type NextRequest } from 'next/server'
import { getMapData, parseStates } from '@/lib/map-data'
import { createClient } from '@/lib/supabase/server'

// GeoJSON for the map. Runs map_features() with the caller's JWT, so RLS decides what comes back.
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'sign in required' }, { status: 401 })

  const states = parseStates(request.nextUrl.searchParams.get('states'))
  try {
    const data = await getMapData((fn, args) => supabase.rpc(fn, args) as never, states)
    return NextResponse.json(data, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 })
  }
}
