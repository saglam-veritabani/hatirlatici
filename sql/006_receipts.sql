-- Okundu bilgisi: gönderilen WhatsApp mesajının kimliği ve iletildi/okundu zamanları.
alter table public.reminders
  add column if not exists wa_message_id text,
  add column if not exists delivered_at timestamptz,
  add column if not exists read_at timestamptz;

create index if not exists reminders_wa_message_id_idx
  on public.reminders (wa_message_id) where wa_message_id is not null;
