'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

export async function decide(formData: FormData) {
  const supabase = await createClient()
  const decision = formData.get('decision') === 'approve' ? 'approve' : 'reject'
  const propertyId = formData.get('property_id')
  const { error } = await supabase.rpc('decide_match', {
    p_contact_id: String(formData.get('contact_id')),
    p_decision: decision,
    p_property_id: decision === 'approve' && propertyId ? String(propertyId) : null,
  })
  if (error) throw new Error(error.message)
  revalidatePath('/admin/review')
}

export async function rerunMatching() {
  const supabase = await createClient()
  const { error } = await supabase.rpc('run_crm_matching')
  if (error) throw new Error(error.message)
  revalidatePath('/admin/review')
}
