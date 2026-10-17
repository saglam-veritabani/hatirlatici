import { config } from './config.js';
import { isReady, sendText } from './whatsapp.js';
import {
  fetchDueReminders,
  claimReminder,
  markSent,
  markFailed,
  setWaMessageId,
} from './supabase.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let running = false;
let lastOkAt = 0;

/** Son başarılı döngünün zamanı (veritabanına ulaşıldı ve WhatsApp hazırdı). İzleme için. */
export const getLastOkAt = () => lastOkAt;

/**
 * Bir döngüde: zamanı gelen kayıtları al, her birini claim et, gönder, durumunu güncelle.
 * Önceki döngü bitmeden yenisi başlamaz.
 */
export async function tick() {
  if (running) return;
  if (!isReady()) {
    console.log('WhatsApp hazır değil, bu tur atlanıyor.');
    return;
  }

  running = true;
  try {
    const due = await fetchDueReminders();
    lastOkAt = Date.now();
    if (due.length === 0) return;

    console.log(`${due.length} hatırlatma gönderilecek.`);

    for (const reminder of due) {
      const claimed = await claimReminder(reminder);
      if (!claimed) continue;

      try {
        const waId = await sendText(reminder.phone, reminder.message);
        if (waId) {
          // Mesaj gitti; kimliği yazılamazsa sadece okundu bilgisi görünmez, gönderim başarısız sayılmaz.
          try { await setWaMessageId(reminder.id, waId); }
          catch (e) { console.error(`[#${reminder.id}] mesaj kimliği yazılamadı: ${e.message}`); }
        }
        await markSent(reminder.id);
        console.log(`[#${reminder.id}] gönderildi → ${reminder.phone}`);
      } catch (err) {
        const status = await markFailed(reminder, err.message);
        console.error(`[#${reminder.id}] hata (${status}): ${err.message}`);
      }

      await sleep(config.sendDelayMs);
    }
  } catch (err) {
    console.error('Zamanlayıcı döngüsünde hata:', err.message);
  } finally {
    running = false;
  }
}
