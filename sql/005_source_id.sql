-- WhatsApp grubundan gelen komutun mesaj kimliği. Aynı mesaj iki kez işlenirse
-- (yeniden bağlanma, yeniden başlatma) ikinci kayıt benzersizlik kuralına takılır.
alter table public.reminders add column if not exists source_id text;
create unique index if not exists reminders_source_id_key on public.reminders (source_id) where source_id is not null;
