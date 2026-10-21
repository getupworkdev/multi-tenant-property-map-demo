-- Multi-tenant property map: tenant-isolated properties, a single state view with priority rules,
-- a staged CSV import, and CRM (GoHighLevel-style) matching with an admin review queue.
--
-- Every table carries tenant_id and is protected by RLS. Browsers read through the API with the
-- user's own JWT; nothing in the app uses the service role key.

create extension if not exists postgis with schema extensions;
create extension if not exists pg_trgm with schema extensions;

create table public.tenants (
    id   uuid primary key default gen_random_uuid(),
    slug text not null unique,
    name text not null
);

create table public.tenant_members (
    user_id   uuid primary key references auth.users (id) on delete cascade,
    tenant_id uuid not null references public.tenants (id),
    role      text not null default 'member' check (role in ('member', 'admin'))
);

create function public.current_tenant_id() returns uuid
language sql stable security definer set search_path = public
as $$ select tenant_id from public.tenant_members where user_id = auth.uid() $$;

create function public.is_tenant_admin() returns boolean
language sql stable security definer set search_path = public
as $$ select coalesce((select role = 'admin' from public.tenant_members where user_id = auth.uid()), false) $$;

-- Lowercase, punctuation stripped, common street suffixes shortened, single spaces.
create function public.normalize_address(p_address text) returns text
language plpgsql immutable set search_path = pg_catalog
as $$
declare
    v_text text := regexp_replace(lower(coalesce(p_address, '')), '[^a-z0-9 ]', ' ', 'g');
    v_pair text[];
begin
    foreach v_pair slice 1 in array array[
        ['street', 'st'], ['avenue', 'ave'], ['road', 'rd'], ['drive', 'dr'], ['boulevard', 'blvd'],
        ['crescent', 'cres'], ['court', 'ct'], ['place', 'pl'], ['lane', 'ln'], ['suite', 'unit'], ['apt', 'unit']
    ] loop
        v_text := regexp_replace(v_text, '\m' || v_pair[1] || '\M', v_pair[2], 'g');
    end loop;
    return trim(regexp_replace(v_text, '\s+', ' ', 'g'));
end;
$$;

-- Lowercase, punctuation and company suffixes removed.
create function public.normalize_name(p_name text) returns text
language sql immutable set search_path = pg_catalog
as $$
    select trim(regexp_replace(
        regexp_replace(regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9 ]', ' ', 'g'),
                       '\m(inc|llc|ltd|limited|corp|corporation|co|the|holdings)\M', ' ', 'g'),
        '\s+', ' ', 'g'))
$$;

create table public.properties (
    id           uuid primary key default gen_random_uuid(),
    tenant_id    uuid not null references public.tenants (id),
    source_id    text not null,                -- the feed's property / parcel ID
    address      text not null,
    address_norm text not null,
    city         text,
    postcode     text,
    owner_name   text not null,
    owner_norm   text not null,
    location     extensions.geography(Point, 4326) not null,
    row_hash     text not null,                -- detects unchanged rows on re-import
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    unique (tenant_id, source_id),
    unique (id, tenant_id)
);
create index properties_tenant on public.properties (tenant_id);
create index properties_location on public.properties using gist (location);
create index properties_address_trgm on public.properties using gin (address_norm extensions.gin_trgm_ops);

create table public.property_activities (
    id          bigint generated always as identity primary key,
    tenant_id   uuid not null,
    property_id uuid not null,
    kind        text not null check (kind in ('work_won', 'existing_client', 'inspection', 'proposal', 'relationship')),
    status      text not null default 'open' check (status in ('open', 'closed')),
    note        text,
    occurred_at timestamptz not null default now(),
    foreign key (property_id, tenant_id) references public.properties (id, tenant_id) on delete cascade
);
create index property_activities_property on public.property_activities (property_id);

-- The five map states, in priority order. Colours and filter labels come from here.
create table public.property_state_legend (
    state    text primary key,
    priority integer not null unique,
    label    text not null,
    color    text not null
);
insert into public.property_state_legend (state, priority, label, color) values
    ('work_won', 1, 'Work won', '#1b7f4c'),
    ('existing_client', 2, 'Existing client', '#2563eb'),
    ('in_progress', 3, 'Inspection / proposal in progress', '#d97706'),
    ('relationship', 4, 'Relationship in progress', '#9333ea'),
    ('available', 5, 'Available to pursue', '#6b7280');

-- One row per property with its single state:
-- work won > existing client > open inspection or proposal > open relationship > available.
create view public.property_states with (security_invoker = true) as
select
    p.id,
    p.tenant_id,
    p.source_id,
    p.address,
    p.city,
    p.postcode,
    p.owner_name,
    extensions.st_y(p.location::extensions.geometry) as lat,
    extensions.st_x(p.location::extensions.geometry) as lng,
    case
        when bool_or(a.kind = 'work_won') then 'work_won'
        when bool_or(a.kind = 'existing_client') then 'existing_client'
        when bool_or(a.kind in ('inspection', 'proposal') and a.status = 'open') then 'in_progress'
        when bool_or(a.kind = 'relationship' and a.status = 'open') then 'relationship'
        else 'available'
    end as state
from public.properties p
left join public.property_activities a on a.property_id = p.id
group by p.id;

-- ---------------------------------------------------------------------------
-- Import: CSV rows -> staging -> validation -> merge, all inside one transaction.
-- ---------------------------------------------------------------------------

create table public.import_batches (
    id         uuid primary key default gen_random_uuid(),
    tenant_id  uuid not null references public.tenants (id),
    file_name  text not null,
    created_by uuid references auth.users (id),
    created_at timestamptz not null default now(),
    row_count  integer not null,
    inserted   integer,
    updated    integer,
    unchanged  integer,
    rejected   integer
);

create table public.import_rows (
    batch_id   uuid not null references public.import_batches (id) on delete cascade,
    tenant_id  uuid not null,
    row_number integer not null,
    raw        jsonb not null,
    status     text not null default 'pending' check (status in ('pending', 'valid', 'rejected')),
    error      text,
    primary key (batch_id, row_number)
);

create function public._import_properties(p_tenant uuid, p_actor uuid, p_file_name text, p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_batch     uuid;
    v_inserted  integer;
    v_updated   integer;
    v_unchanged integer;
    v_rejected  integer;
begin
    if p_tenant is null then
        raise exception 'no tenant' using errcode = '42501';
    end if;
    if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
        raise exception 'rows must be a JSON array';
    end if;

    insert into public.import_batches (tenant_id, file_name, created_by, row_count)
    values (p_tenant, p_file_name, p_actor, jsonb_array_length(p_rows))
    returning id into v_batch;

    insert into public.import_rows (batch_id, tenant_id, row_number, raw)
    select v_batch, p_tenant, r.n::integer, r.value
    from jsonb_array_elements(p_rows) with ordinality as r (value, n);

    -- Validation: IDs and geometry. The first failing rule is reported per row.
    update public.import_rows r
    set status = 'rejected', error = v.error
    from (
        select row_number,
            case
                when coalesce(trim(raw ->> 'source_id'), '') = '' then 'missing source_id'
                when trim(raw ->> 'source_id') !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' then 'invalid source_id'
                when row_number > min(row_number) over (partition by trim(raw ->> 'source_id')) then 'duplicate source_id in file'
                when coalesce(trim(raw ->> 'address'), '') = '' then 'missing address'
                when coalesce(trim(raw ->> 'owner_name'), '') = '' then 'missing owner_name'
                when coalesce(raw ->> 'lat', '') !~ '^-?[0-9]+(\.[0-9]+)?$'
                  or coalesce(raw ->> 'lng', '') !~ '^-?[0-9]+(\.[0-9]+)?$' then 'lat/lng must be decimal numbers'
                when (raw ->> 'lat')::numeric not between -90 and 90
                  or (raw ->> 'lng')::numeric not between -180 and 180 then 'lat/lng out of range'
                when (raw ->> 'lat')::numeric = 0 and (raw ->> 'lng')::numeric = 0 then 'lat/lng is 0,0'
            end as error
        from public.import_rows
        where batch_id = v_batch
    ) v
    where r.batch_id = v_batch and r.row_number = v.row_number and v.error is not null;

    update public.import_rows set status = 'valid' where batch_id = v_batch and status = 'pending';

    -- Merge: insert new IDs, update changed rows, leave identical rows alone.
    with incoming as (
        select trim(raw ->> 'source_id') as source_id,
               trim(raw ->> 'address') as address,
               nullif(trim(raw ->> 'city'), '') as city,
               nullif(trim(raw ->> 'postcode'), '') as postcode,
               trim(raw ->> 'owner_name') as owner_name,
               (raw ->> 'lat')::double precision as lat,
               (raw ->> 'lng')::double precision as lng
        from public.import_rows
        where batch_id = v_batch and status = 'valid'
    ),
    hashed as (
        select i.*, md5(concat_ws('|', i.source_id, i.address, i.city, i.postcode, i.owner_name, i.lat, i.lng)) as row_hash,
               p.id as existing_id, p.row_hash as existing_hash
        from incoming i
        left join public.properties p on p.tenant_id = p_tenant and p.source_id = i.source_id
    ),
    inserted as (
        insert into public.properties (tenant_id, source_id, address, address_norm, city, postcode,
                                       owner_name, owner_norm, location, row_hash)
        select p_tenant, source_id, address, public.normalize_address(address), city, postcode,
               owner_name, public.normalize_name(owner_name),
               st_setsrid(st_makepoint(lng, lat), 4326)::geography, row_hash
        from hashed where existing_id is null
        returning 1
    ),
    updated as (
        update public.properties p
        set address = h.address, address_norm = public.normalize_address(h.address), city = h.city,
            postcode = h.postcode, owner_name = h.owner_name, owner_norm = public.normalize_name(h.owner_name),
            location = st_setsrid(st_makepoint(h.lng, h.lat), 4326)::geography, row_hash = h.row_hash,
            updated_at = now()
        from hashed h
        where h.existing_id = p.id and h.existing_hash <> h.row_hash
        returning 1
    )
    select (select count(*) from inserted),
           (select count(*) from updated),
           (select count(*) from hashed where existing_id is not null and existing_hash = row_hash)
    into v_inserted, v_updated, v_unchanged;

    select count(*) into v_rejected from public.import_rows where batch_id = v_batch and status = 'rejected';

    update public.import_batches
    set inserted = v_inserted, updated = v_updated, unchanged = v_unchanged, rejected = v_rejected
    where id = v_batch;

    return jsonb_build_object(
        'batch_id', v_batch,
        'inserted', v_inserted,
        'updated', v_updated,
        'unchanged', v_unchanged,
        'rejected', v_rejected,
        'rejected_rows', coalesce((
            select jsonb_agg(jsonb_build_object('row', row_number, 'source_id', raw ->> 'source_id', 'error', error)
                             order by row_number)
            from public.import_rows where batch_id = v_batch and status = 'rejected'), '[]'::jsonb));
end;
$$;

create function public.import_properties(p_file_name text, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
    if not public.is_tenant_admin() then
        raise exception 'only tenant admins can import' using errcode = '42501';
    end if;
    return public._import_properties(public.current_tenant_id(), auth.uid(), p_file_name, p_rows);
end;
$$;

-- ---------------------------------------------------------------------------
-- CRM matching: score candidates, auto-link clear matches, queue ambiguous ones for review.
-- ---------------------------------------------------------------------------

create table public.crm_contacts (
    id           uuid primary key default gen_random_uuid(),
    tenant_id    uuid not null references public.tenants (id),
    external_id  text not null,              -- the CRM's contact ID
    name         text not null,
    name_norm    text not null,
    address      text not null,
    address_norm text not null,
    location     extensions.geography(Point, 4326),
    raw          jsonb not null,
    imported_at  timestamptz not null default now(),
    unique (tenant_id, external_id),
    unique (id, tenant_id)
);

create table public.crm_matches (
    contact_id  uuid primary key,
    tenant_id   uuid not null,
    status      text not null check (status in ('auto_linked', 'needs_review', 'no_match', 'approved', 'rejected')),
    property_id uuid,
    best_score  numeric(5, 3),
    candidates  jsonb not null default '[]'::jsonb,
    matched_at  timestamptz not null default now(),
    decided_by  uuid references auth.users (id),
    decided_at  timestamptz,
    foreign key (contact_id, tenant_id) references public.crm_contacts (id, tenant_id) on delete cascade,
    foreign key (property_id, tenant_id) references public.properties (id, tenant_id),
    check (status not in ('auto_linked', 'approved') or property_id is not null),
    check (status not in ('approved', 'rejected') or decided_at is not null)
);

-- Every human decision, kept even if a match is decided again.
create table public.crm_match_decisions (
    id          bigint generated always as identity primary key,
    tenant_id   uuid not null references public.tenants (id),
    contact_id  uuid not null,
    decision    text not null check (decision in ('approve', 'reject')),
    property_id uuid,
    decided_by  uuid not null references auth.users (id),
    decided_at  timestamptz not null default now()
);

create function public._load_crm_contacts(p_tenant uuid, p_contacts jsonb) returns integer
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_count integer;
begin
    insert into public.crm_contacts (tenant_id, external_id, name, name_norm, address, address_norm, location, raw)
    select p_tenant, c ->> 'id',
           coalesce(c ->> 'contactName', concat_ws(' ', c ->> 'firstName', c ->> 'lastName')),
           public.normalize_name(coalesce(c ->> 'contactName', concat_ws(' ', c ->> 'firstName', c ->> 'lastName'))),
           c ->> 'address1', public.normalize_address(c ->> 'address1'),
           case when c ? 'latitude' and c ? 'longitude'
                then st_setsrid(st_makepoint((c ->> 'longitude')::float8, (c ->> 'latitude')::float8), 4326)::geography end,
           c
    from jsonb_array_elements(p_contacts) as c
    on conflict (tenant_id, external_id) do update
    set name = excluded.name, name_norm = excluded.name_norm, address = excluded.address,
        address_norm = excluded.address_norm, location = excluded.location, raw = excluded.raw, imported_at = now();
    get diagnostics v_count = row_count;
    return v_count;
end;
$$;

create function public._run_crm_matching(p_tenant uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_contact    public.crm_contacts;
    v_candidates jsonb;
    v_best       numeric;
    v_second     numeric;
    v_status     text;
begin
    for v_contact in
        select c.* from public.crm_contacts c
        where c.tenant_id = p_tenant
          and not exists (select 1 from public.crm_matches m
                          where m.contact_id = c.id and m.status in ('approved', 'rejected'))
    loop
        -- Score = 50% address similarity + 30% owner-name similarity + 20% proximity (0 m -> 1, 500 m+ -> 0).
        select coalesce(jsonb_agg(to_jsonb(x) order by x.score desc), '[]'::jsonb) into v_candidates
        from (
            select p.id as property_id, p.address, p.owner_name,
                   round((0.5 * similarity(p.address_norm, v_contact.address_norm)
                        + 0.3 * similarity(p.owner_norm, v_contact.name_norm)
                        + 0.2 * case when v_contact.location is null then 0
                                     else greatest(0, 1 - st_distance(p.location, v_contact.location) / 500.0) end
                         )::numeric, 3) as score,
                   case when v_contact.location is null then null
                        else round(st_distance(p.location, v_contact.location)::numeric) end as distance_m
            from public.properties p
            where p.tenant_id = p_tenant
              and (similarity(p.address_norm, v_contact.address_norm) > 0.3
                   or (v_contact.location is not null and st_dwithin(p.location, v_contact.location, 300)))
            order by score desc
            limit 3
        ) x;

        v_best := (v_candidates -> 0 ->> 'score')::numeric;
        v_second := (v_candidates -> 1 ->> 'score')::numeric;
        v_status := case
            when v_best >= 0.85 and (v_second is null or v_best - v_second >= 0.15) then 'auto_linked'
            when v_best >= 0.5 then 'needs_review'
            else 'no_match'
        end;

        insert into public.crm_matches (contact_id, tenant_id, status, property_id, best_score, candidates)
        values (v_contact.id, p_tenant, v_status,
                case when v_status = 'auto_linked' then (v_candidates -> 0 ->> 'property_id')::uuid end,
                v_best, v_candidates)
        on conflict (contact_id) do update
        set status = excluded.status, property_id = excluded.property_id, best_score = excluded.best_score,
            candidates = excluded.candidates, matched_at = now()
        where public.crm_matches.status not in ('approved', 'rejected');
    end loop;

    return (select jsonb_object_agg(status, n) from (
        select status, count(*) as n from public.crm_matches where tenant_id = p_tenant group by status) s);
end;
$$;

create function public.run_crm_matching() returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
    if not public.is_tenant_admin() then
        raise exception 'only tenant admins can run matching' using errcode = '42501';
    end if;
    return public._run_crm_matching(public.current_tenant_id());
end;
$$;

create function public.decide_match(p_contact_id uuid, p_decision text, p_property_id uuid default null)
returns text
language plpgsql security definer set search_path = public
as $$
declare
    v_match public.crm_matches;
begin
    if not public.is_tenant_admin() then
        raise exception 'only tenant admins can review matches' using errcode = '42501';
    end if;
    select * into v_match from public.crm_matches
    where contact_id = p_contact_id and tenant_id = public.current_tenant_id()
    for update;
    if not found then
        raise exception 'match not found';
    end if;
    if p_decision = 'approve' then
        if p_property_id is null or not exists (
            select 1 from jsonb_array_elements(v_match.candidates) c where (c ->> 'property_id')::uuid = p_property_id) then
            raise exception 'approve needs one of the candidate properties';
        end if;
        update public.crm_matches
        set status = 'approved', property_id = p_property_id, decided_by = auth.uid(), decided_at = now()
        where contact_id = p_contact_id;
    elsif p_decision = 'reject' then
        update public.crm_matches
        set status = 'rejected', property_id = null, decided_by = auth.uid(), decided_at = now()
        where contact_id = p_contact_id;
    else
        raise exception 'decision must be approve or reject';
    end if;
    insert into public.crm_match_decisions (tenant_id, contact_id, decision, property_id, decided_by)
    values (v_match.tenant_id, p_contact_id, p_decision, case when p_decision = 'approve' then p_property_id end, auth.uid());
    return case when p_decision = 'approve' then 'approved' else 'rejected' end;
end;
$$;

-- ---------------------------------------------------------------------------
-- The map's data endpoint: GeoJSON from the state view, filtered by state. Runs as the caller.
-- ---------------------------------------------------------------------------

create function public.map_features(p_states text[] default null) returns jsonb
language sql stable security invoker set search_path = public
as $$
    select jsonb_build_object(
        'type', 'FeatureCollection',
        'features', coalesce(jsonb_agg(jsonb_build_object(
            'type', 'Feature',
            'id', s.id,
            'geometry', jsonb_build_object('type', 'Point', 'coordinates', jsonb_build_array(s.lng, s.lat)),
            'properties', jsonb_build_object('id', s.id, 'state', s.state, 'address', s.address,
                                             'owner', s.owner_name, 'source_id', s.source_id))), '[]'::jsonb))
    from public.property_states s
    where p_states is null or s.state = any (p_states)
$$;

-- ---------------------------------------------------------------------------
-- Row-level security on every table.
-- ---------------------------------------------------------------------------

alter table public.tenants enable row level security;
alter table public.tenant_members enable row level security;
alter table public.properties enable row level security;
alter table public.property_activities enable row level security;
alter table public.property_state_legend enable row level security;
alter table public.import_batches enable row level security;
alter table public.import_rows enable row level security;
alter table public.crm_contacts enable row level security;
alter table public.crm_matches enable row level security;
alter table public.crm_match_decisions enable row level security;

create policy tenants_read on public.tenants for select to authenticated
    using (id = public.current_tenant_id());
create policy tenant_members_read on public.tenant_members for select to authenticated
    using (user_id = auth.uid());
create policy properties_read on public.properties for select to authenticated
    using (tenant_id = public.current_tenant_id());
create policy property_activities_read on public.property_activities for select to authenticated
    using (tenant_id = public.current_tenant_id());
create policy legend_read on public.property_state_legend for select to authenticated
    using (true);
create policy import_batches_read on public.import_batches for select to authenticated
    using (tenant_id = public.current_tenant_id() and public.is_tenant_admin());
create policy import_rows_read on public.import_rows for select to authenticated
    using (tenant_id = public.current_tenant_id() and public.is_tenant_admin());
create policy crm_contacts_read on public.crm_contacts for select to authenticated
    using (tenant_id = public.current_tenant_id());
create policy crm_matches_read on public.crm_matches for select to authenticated
    using (tenant_id = public.current_tenant_id());
create policy crm_match_decisions_read on public.crm_match_decisions for select to authenticated
    using (tenant_id = public.current_tenant_id());

revoke all on public.tenants, public.tenant_members, public.properties, public.property_activities,
    public.property_state_legend, public.import_batches, public.import_rows, public.crm_contacts,
    public.crm_matches, public.crm_match_decisions, public.property_states from anon, authenticated;
grant select on public.tenants, public.tenant_members, public.properties, public.property_activities,
    public.property_state_legend, public.import_batches, public.import_rows, public.crm_contacts,
    public.crm_matches, public.crm_match_decisions, public.property_states to authenticated;

revoke execute on function public.current_tenant_id(), public.is_tenant_admin(),
    public.normalize_address(text), public.normalize_name(text),
    public._import_properties(uuid, uuid, text, jsonb), public.import_properties(text, jsonb),
    public._load_crm_contacts(uuid, jsonb), public._run_crm_matching(uuid), public.run_crm_matching(),
    public.decide_match(uuid, text, uuid), public.map_features(text[])
    from public, anon, authenticated;
grant execute on function public.current_tenant_id(), public.is_tenant_admin(),
    public.normalize_address(text), public.normalize_name(text),
    public.import_properties(text, jsonb), public.run_crm_matching(), public.decide_match(uuid, text, uuid),
    public.map_features(text[])
    to authenticated;
