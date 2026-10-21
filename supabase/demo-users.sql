-- Hosted demo only: one public demo admin per tenant.
-- Run once against the Supabase project after the migration and seed.

with users (id, email, password, tenant_id) as (
    values
        ('6a000000-0000-4000-8000-000000000001'::uuid, 'tenant-a.demo@example.com', 'tenant-a-demo-2026', '0a000000-0000-4000-8000-000000000001'::uuid),
        ('6b000000-0000-4000-8000-000000000001'::uuid, 'tenant-b.demo@example.com', 'tenant-b-demo-2026', '0b000000-0000-4000-8000-000000000001'::uuid)
),
created as (
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                            confirmation_token, email_change, email_change_token_new, recovery_token)
    select '00000000-0000-0000-0000-000000000000', id, 'authenticated', 'authenticated', email,
           extensions.crypt(password, extensions.gen_salt('bf')), now(),
           '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''
    from users
    returning id
),
identities as (
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    select gen_random_uuid(), u.id, u.id::text, jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
           'email', now(), now(), now()
    from users u join created c on c.id = u.id
    returning user_id
)
insert into public.tenant_members (user_id, tenant_id, role)
select u.id, u.tenant_id, 'admin' from users u join identities i on i.user_id = u.id;
