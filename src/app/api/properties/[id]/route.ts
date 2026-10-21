import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// One property record. Another tenant's ID simply returns 404: RLS hides the row.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'sign in required' }, { status: 401 })

  const [property, activities, crm] = await Promise.all([
    supabase.from('property_states').select('id, source_id, address, city, postcode, owner_name, state, lat, lng').eq('id', id).maybeSingle(),
    supabase.from('property_activities').select('kind, status, occurred_at').eq('property_id', id).order('occurred_at', { ascending: false }),
    supabase.from('crm_matches').select('status, crm_contacts(name, external_id)').eq('property_id', id),
  ])
  if (!property.data) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ property: property.data, activities: activities.data ?? [], crm: crm.data ?? [] })
}
