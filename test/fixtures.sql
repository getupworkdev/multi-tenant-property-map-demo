insert into public.tenants (id, slug, name) values
    ('0a000000-0000-4000-8000-000000000001', 'tenant-a', 'Tenant A'),
    ('0b000000-0000-4000-8000-000000000001', 'tenant-b', 'Tenant B');

insert into auth.users (id, email) values
    ('a1000000-0000-4000-8000-000000000001', 'admin.a@example.com'),
    ('a1000000-0000-4000-8000-000000000002', 'member.a@example.com'),
    ('b1000000-0000-4000-8000-000000000001', 'admin.b@example.com');

insert into public.tenant_members (user_id, tenant_id, role) values
    ('a1000000-0000-4000-8000-000000000001', '0a000000-0000-4000-8000-000000000001', 'admin'),
    ('a1000000-0000-4000-8000-000000000002', '0a000000-0000-4000-8000-000000000001', 'member'),
    ('b1000000-0000-4000-8000-000000000001', '0b000000-0000-4000-8000-000000000001', 'admin');
