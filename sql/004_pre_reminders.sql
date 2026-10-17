-- Ön hatırlatma: ana hatırlatmaya bağlı ek kayıtlar ("1 gün kaldı: ...").
--   group_id : ana kayıt ve ön hatırlatmaları aynı grupta toplar
--   leads    : ana kayıtta, kaç dakika önce ön hatırlatma gideceği (örn. {1440,60})
--   lead_min : ön hatırlatma kaydında, ana zamandan kaç dakika önce olduğu
alter table public.reminders
  add column if not exists group_id uuid,
  add column if not exists leads integer[],
  add column if not exists lead_min integer;

alter table public.reminders
  drop constraint if exists reminders_lead_min_check;
alter table public.reminders
  add constraint reminders_lead_min_check check (lead_min is null or lead_min > 0);

create index if not exists reminders_group_idx on public.reminders (group_id) where group_id is not null;

-- Tekrarlı hatırlatmada bir sonraki kayıtla birlikte onun ön hatırlatmalarını da üretir.
create or replace function public.complete_reminder(p_id bigint)
returns bigint
language plpgsql
set search_path = public
as $$
declare
  r        public.reminders%rowtype;
  tz       constant text := 'Europe/Istanbul';
  loc      timestamp;
  nxt      timestamptz;
  rule_day int;
  nm       timestamp;
  new_id   bigint;
  new_gid  uuid;
begin
  update public.reminders
     set status = 'sent', sent_at = now(), last_error = null
   where id = p_id and status = 'sending'
  returning * into r;

  if not found or r.recurrence = 'none' then
    return null;
  end if;

  loc := r.remind_at at time zone tz;
  rule_day := coalesce(nullif(r.recurrence_rule, '')::int, extract(day from loc)::int);

  loop
    if r.recurrence = 'daily' then
      loc := loc + interval '1 day';
    elsif r.recurrence = 'weekly' then
      loc := loc + interval '7 days';
    else
      nm  := date_trunc('month', loc) + interval '1 month';
      loc := nm
           + (least(rule_day, extract(day from (nm + interval '1 month - 1 day'))::int) - 1) * interval '1 day'
           + loc::time;
    end if;
    nxt := loc at time zone tz;
    exit when nxt > now();
  end loop;

  if coalesce(array_length(r.leads, 1), 0) > 0 then
    new_gid := gen_random_uuid();
  end if;

  insert into public.reminders (phone, message, remind_at, status, attempts, recurrence, recurrence_rule, leads, group_id)
  values (r.phone, r.message, nxt, 'pending', 0, r.recurrence, r.recurrence_rule, r.leads, new_gid)
  returning id into new_id;

  if new_gid is not null then
    insert into public.reminders (phone, message, remind_at, status, attempts, recurrence, group_id, lead_min)
    select r.phone,
           '⏰ ' || case when l % 10080 = 0 then (l / 10080)::text || ' hafta'
                         when l % 1440  = 0 then (l / 1440)::text  || ' gün'
                         when l % 60    = 0 then (l / 60)::text    || ' saat'
                         else l::text || ' dk' end
                || ' kaldı: ' || r.message,
           nxt - l * interval '1 minute', 'pending', 0, 'none', new_gid, l
      from unnest(r.leads) as l
     where nxt - l * interval '1 minute' > now() + interval '1 minute';
  end if;

  return new_id;
end;
$$;

revoke all on function public.complete_reminder(bigint) from public, anon, authenticated;
grant execute on function public.complete_reminder(bigint) to service_role;
