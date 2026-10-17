-- Adım 1'deki tabloya 'sending' durumunu ekler.
-- Çift gönderimi önlemek için kayıt göndermeden önce bu duruma alınır.
alter table reminders drop constraint reminders_status_check;

alter table reminders
  add constraint reminders_status_check
  check (status in ('pending', 'sending', 'sent', 'failed'));
