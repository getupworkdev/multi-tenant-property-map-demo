import { redirect } from 'next/navigation'
import { Header } from '@/components/Header'
import { MapView } from '@/components/MapView'
import { createClient, getMember } from '@/lib/supabase/server'

export default async function MapPage() {
  const member = await getMember()
  if (!member) redirect('/')
  const supabase = await createClient()
  const { data: legend } = await supabase.from('property_state_legend').select('state, label, color').order('priority')

  return (
    <>
      <Header tenantName={member.tenantName} email={member.email} isAdmin={member.isAdmin} />
      <MapView legend={legend ?? []} />
    </>
  )
}
