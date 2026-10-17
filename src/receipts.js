// Gönderdiğimiz hatırlatmaların WhatsApp'ta iletildi (✓✓) ve okundu (mavi ✓✓) olduğunu veritabanına yazar.
// WhatsApp durum kodları: 2 sunucuya ulaştı, 3 iletildi, 4 okundu, 5 dinlendi (sesli mesaj).
// Not: karşı taraf "okundu bilgisini" kapattıysa okundu hiç gelmez, iletildi yine gelir.

const RETRY_MS = [3_000, 10_000, 30_000];   // mesaj kimliği kayda henüz yazılmadıysa tekrar dene

/**
 * @param {{markReceipt:(waId:string, kind:'delivered'|'read', iso:string)=>Promise<number>, retryMs?:number[], log?:Console}} deps
 */
export function createReceiptHandler({ markReceipt, retryMs = RETRY_MS, log = console }) {
  async function apply(waId, kind, iso, attempt = 0) {
    let matched = 0;
    try { matched = await markReceipt(waId, kind, iso); }
    catch (e) { log.error?.(`Okundu bilgisi yazılamadı: ${e.message}`); return; }
    if (matched === 0 && attempt < retryMs.length) {
      const t = setTimeout(() => apply(waId, kind, iso, attempt + 1), retryMs[attempt]);
      t.unref?.();
    }
  }

  return async function onUpdate(updates) {
    for (const u of updates ?? []) {
      if (!u?.key?.fromMe || !u.key.id) continue;
      if (String(u.key.remoteJid ?? '').endsWith('@g.us')) continue;   // hatırlatmalar birebir sohbete gider
      const st = Number(u.update?.status);
      if (!Number.isFinite(st) || st < 3) continue;
      await apply(u.key.id, st >= 4 ? 'read' : 'delivered', new Date().toISOString());
    }
  };
}
