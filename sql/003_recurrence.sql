-- Gönderilen hatırlatmayı tek işlemde 'sent' yapar ve tekrarlıysa bir sonrakini üretir.
-- Tek işlemde olduğu için yarıda kesilirse ne çift kayıt ne de kaybolan tekrar oluşur.
-- Zamanlar İstanbul saatine göre hesaplanır. Kaçırılmış tekrarlar atlanır (bilgisayar
-- günlerce kapalı kalsa bile sonraki kayıt hep gelecekte olur).
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

  insert into public.reminders (phone, message, remind_at, status, attempts, recurrence, recurrence_rule)
  values (r.phone, r.message, nxt, 'pending', 0, r.recurrence, r.recurrence_rule)
  returning id into new_id;

  return new_id;
end;
$$;

revoke all on function public.complete_reminder(bigint) from public, anon, authenticated;
grant execute on function public.complete_reminder(bigint) to service_role;
