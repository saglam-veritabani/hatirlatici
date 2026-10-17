import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

export const supabase = createClient(config.supabaseUrl, config.supabaseKey, {
  auth: { persistSession: false },
});

const TABLE = 'reminders';

/** Zamanı gelmiş, hâlâ bekleyen kayıtları getirir. */
export async function fetchDueReminders(limit = 20) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('status', 'pending')
    .lte('remind_at', new Date().toISOString())
    .order('remind_at', { ascending: true })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}

/**
 * Kaydı 'sending' durumuna almaya çalışır.
 * Sadece hâlâ 'pending' ise günceller. Başka bir işlem önce aldıysa false döner.
 */
export async function claimReminder(reminder) {
  const { data, error } = await supabase
    .from(TABLE)
    .update({ status: 'sending', attempts: reminder.attempts + 1 })
    .eq('id', reminder.id)
    .eq('status', 'pending')
    .select('id');

  if (error) throw error;
  return (data ?? []).length > 0;
}

/**
 * Kaydı 'sent' yapar. Tekrarlıysa bir sonraki kaydı da aynı işlemde üretir
 * (veritabanındaki complete_reminder fonksiyonu, sql/003_recurrence.sql).
 * Yeni kaydın id'sini döner, tek seferlikse null.
 */
export async function markSent(id) {
  const { data, error } = await supabase.rpc('complete_reminder', { p_id: id });

  if (error) throw error;
  return data;
}

/**
 * Gönderim başarısızsa: deneme hakkı varsa 'pending'e geri alır,
 * yoksa 'failed' yapar.
 */
export async function markFailed(reminder, errorMessage) {
  const attemptsUsed = reminder.attempts + 1;
  const status = attemptsUsed >= config.maxAttempts ? 'failed' : 'pending';

  const { error } = await supabase
    .from(TABLE)
    .update({ status, last_error: errorMessage.slice(0, 500) })
    .eq('id', reminder.id);

  if (error) throw error;
  return status;
}

/**
 * Sunucu yeniden başlarken yarıda kalmış 'sending' kayıtlarını tekrar 'pending' yapar.
 * Tek bir sunucu çalıştığı için bu güvenlidir.
 */
export async function resetStuckSending() {
  const { error, count } = await supabase
    .from(TABLE)
    .update({ status: 'pending' }, { count: 'exact' })
    .eq('status', 'sending');

  if (error) throw error;
  return count ?? 0;
}

/* ---------- WhatsApp grubundan gelen komutlar ---------- */

/**
 * Hatırlatmaları (ve varsa ön hatırlatmalarını) tek işlemde ekler.
 * Aynı mesaj kimliği (source_id) ikinci kez gelirse { duplicate: true } döner.
 */
export async function insertReminders(rows) {
  const { error } = await supabase.from(TABLE).insert(rows);
  if (error) return error.code === '23505' ? { duplicate: true } : { error };
  return { ok: true };
}

/** Son `maxAgeMs` içinde gruptan eklenmiş, hâlâ bekleyen en son hatırlatmayı (ön hatırlatmalarıyla) siler. */
export async function cancelLatestChatReminder(maxAgeMs) {
  const since = new Date(Date.now() - maxAgeMs).toISOString();
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .not('source_id', 'is', null)
    .eq('status', 'pending')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = data?.[0];
  if (!row) return null;

  const del = await supabase.from(TABLE).delete().eq('id', row.id).eq('status', 'pending').select('id');
  if (del.error) throw del.error;
  if (!del.data?.length) return null;   // arada gönderilmeye başlamış

  if (row.group_id) {
    const kids = await supabase
      .from(TABLE).delete()
      .eq('group_id', row.group_id).not('lead_min', 'is', null).eq('status', 'pending');
    if (kids.error) throw kids.error;
  }
  return row;
}

/** Kayıtlı kişiler (hatırlatmanın kime gideceğini bulmak için). */
export async function listContacts() {
  const { data, error } = await supabase.from('contacts').select('name, phone');
  if (error) throw error;
  return data ?? [];
}

/** Patronun bekleyen hatırlatmaları ile gruptan başkasına kaydedilenler (ön hatırlatmalar hariç), zamana göre. */
export async function listPendingForBoss(phone, limit = 10) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .or(`phone.eq.${phone},source_id.not.is.null`)
    .eq('status', 'pending')
    .is('lead_min', null)
    .order('remind_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

/* ---------- İletildi / okundu bilgisi ---------- */

/** Gönderilen mesajın WhatsApp kimliğini kayda yazar (sonradan gelen iletildi/okundu bilgisi buna bağlanır). */
export async function setWaMessageId(id, waId) {
  const { error } = await supabase.from(TABLE).update({ wa_message_id: waId }).eq('id', id);
  if (error) throw error;
}

/**
 * Mesajın iletildiğini/okunduğunu işler. Zaman yalnızca ilk seferde yazılır, geri alınmaz.
 * @param {string} waId @param {'delivered'|'read'} kind @param {string} iso
 * @returns {Promise<number>} eşleşen kayıt sayısı (0 ise kayıt henüz kimliği yazmamış olabilir)
 */
export async function markReceipt(waId, kind, iso) {
  let matched = 0;
  const run = async (patch, nullCol) => {
    const { data, error } = await supabase.from(TABLE).update(patch).eq('wa_message_id', waId).is(nullCol, null).select('id');
    if (error) throw error;
    matched += data?.length ?? 0;
  };
  if (kind === 'read') {
    await run({ read_at: iso }, 'read_at');
    await run({ delivered_at: iso }, 'delivered_at');   // okundu ise iletilmiştir
  } else {
    await run({ delivered_at: iso }, 'delivered_at');
  }
  if (matched === 0) {
    const { data, error } = await supabase.from(TABLE).select('id').eq('wa_message_id', waId).limit(1);
    if (error) throw error;
    return data?.length ?? 0;   // kayıt var ama zaten işlenmiş
  }
  return matched;
}
