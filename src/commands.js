// Grup mesajını hatırlatma komutuna çevirir ve gruba cevap yazar.
// WhatsApp'a bağımlı değildir: veritabanı ve cevap fonksiyonu dışarıdan verilir (test edilebilsin diye).
import { randomUUID } from 'node:crypto';
import { parseCommand, _internal } from './parser.js';
import { findRecipient, matchName } from './recipient.js';

const TZ = 'Europe/Istanbul';
const OFFSET_MS = 3 * 3600e3;
const MAX_AGE_MS = 24 * 3600e3;          // bundan eski mesajlar işlenmez (yeniden bağlanınca eski mesaj gelebilir)
const CANCEL_WINDOW_MS = 60 * 60e3;      // "iptal" yalnızca son 1 saatteki kayıt için geçerli
const MAX_VOICE_SEC = 180;
const NO_TARGET = '⚠️ Hatırlatmanın kime gideceğini belirleyemedim. Servisin .env dosyasına BOSS_PHONE=90xxxxxxxxxx ekle.';
const WD = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];

export const leadLabel = (m) =>
  m % 10080 === 0 ? `${m / 10080} hafta` : m % 1440 === 0 ? `${m / 1440} gün` : m % 60 === 0 ? `${m / 60} saat` : `${m} dk`;

const dayFmt = new Intl.DateTimeFormat('tr-TR', { timeZone: TZ, day: 'numeric', month: 'long', weekday: 'long' });
const timeFmt = new Intl.DateTimeFormat('tr-TR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayNum = (d) => Math.floor((d.getTime() + OFFSET_MS) / 864e5);

function whenText(d, now) {
  const rel = ['Bugün', 'Yarın', 'Öbür gün'][dayNum(d) - dayNum(now)];
  return `${rel ? rel + ' · ' : ''}${dayFmt.format(d)} saat ${timeFmt.format(d)}`;
}

function recText(rec, rule) {
  if (rec === 'daily') return 'Her gün';
  if (rec === 'weekly') return `Her ${WD[+rule]}`;
  if (rec === 'monthly') return `Her ayın ${rule}. günü`;
  return '';
}

const EXAMPLES =
  '• yarın 14:00\'te Ahmet\'le toplantıyı hatırlat\n• 2 saat sonra ilacı hatırlat\n• her pazartesi 09:00 raporu hatırlat';

function errorText(res, now) {
  switch (res.reason) {
    case 'time': return `❓ Zamanı anlayamadım. Şöyle yazabilirsin:\n${EXAMPLES}`;
    case 'empty': return `❓ Neyi hatırlatayım? Zamanı anladım (${whenText(res.when, now)}) ama konu yok. Örnek: “yarın 10:00'da faturayı öde hatırlat”. Bir mesaja cevap vererek de yazabilirsin.`;
    case 'past': return `⚠️ Bu zaman geçmişte kalıyor (${whenText(res.when, now)}). Yeni bir zaman yazar mısın?`;
    case 'yearly': return '⚠️ Yıllık tekrar henüz yok. Şimdilik tek seferlik yazabilirsin.';
    case 'date': return '⚠️ Geçersiz bir tarih yazmışsın. Kontrol edip tekrar yazar mısın?';
    case 'multi': return '⚠️ Tek mesajda tek zaman yazabilirsin. Birden fazla hatırlatma için her birini ayrı mesajla yaz.';
    default: return `❓ Anlayamadım. Şöyle yazabilirsin:\n${EXAMPLES}`;
  }
}

/**
 * @param {{db: {insertReminders, cancelLatestChatReminder, listPendingForBoss, listContacts}, prefix?: string, nowFn?: () => number, ai?: (a:{text,quotedText,now})=>Promise<object|null>, aiAudio?: (a:{audio,mimeType,now})=>Promise<{transcript:string,items:object[]}>, polite?: (a:{recipientName,text})=>Promise<string|null>, politeMode?: 'onay'|'otomatik'|'kapali'}} deps
 */
export function createHandler({ db, prefix = 'Hatırlatma: ', nowFn = () => Date.now(), ai = null, aiAudio = null, polite = null, politeMode = 'onay' }) {
  const pendings = new Map();   // sohbet → onay bekleyen kibar mesaj
  const PENDING_MS = 10 * 60e3;
  const seen = new Set();   // aynı mesaj aynı süreçte iki kez işlenmesin

  /** Başkasına gidecek metnin kibar hali. Kapalıysa, Gemini yoksa ya da anlam değişmişse null (eski metin gider). */
  async function makePolite(recipient, text) {
    if (!polite || politeMode === 'kapali' || !recipient) return null;
    try { return (await polite({ recipientName: recipient.name, text })) || null; }
    catch (err) { console.error('Kibar mesaj üretilemedi, olduğu gibi gönderilecek:', err.message); return null; }
  }

  /** Hatırlatmayı (ve ön hatırlatmalarını) kaydeder. Onay satırlarını döner. */
  async function persist(res, recipient, bossPhone, sourceId, now, outText = null) {
    const target = recipient ? recipient.phone : bossPhone;
    if (!target) return { status: 'noTarget' };
    const gid = res.leads.length ? randomUUID() : null;
    const rows = [{
      phone: target, message: outText ?? (recipient ? `${prefix}${res.text}` : res.text), remind_at: res.when.toISOString(), status: 'pending',
      recurrence: res.rec, recurrence_rule: res.rule, group_id: gid, leads: res.leads.length ? res.leads : null,
      lead_min: null, source_id: sourceId,
    }];
    for (const m of res.leads) {
      rows.push({
        phone: target, message: `⏰ ${leadLabel(m)} kaldı: ${res.text}`,
        remind_at: new Date(res.when.getTime() - m * 60e3).toISOString(), status: 'pending',
        recurrence: 'none', recurrence_rule: null, group_id: gid, leads: null, lead_min: m, source_id: null,
      });
    }
    const r = await db.insertReminders(rows);
    if (r.duplicate) return { status: 'dup' };
    if (r.error) { console.error('Grup komutu kaydedilemedi:', r.error.message); return { status: 'error' }; }

    const lines = [];
    if (recipient) lines.push(`👤 Kime: ${recipient.name}`);
    if (outText) lines.push(`✉️ Gidecek mesaj: “${outText}”`);
    lines.push(`📅 ${whenText(res.when, now)}`, `📝 ${res.text}`);
    const rt = recText(res.rec, res.rule);
    if (rt) lines.push(`🔁 ${rt}`);
    if (res.shiftMin != null) lines.push(`⏳ Etkinlikten ${leadLabel(res.shiftMin)} önce hatırlatacağım.`);
    if (res.leads.length) lines.push(`🔔 Ön hatırlatma: ${res.leads.map((m) => `${leadLabel(m)} önce`).join(', ')}`);
    if (res.defaultedTime) lines.push('🕘 Saat yazmadığın için 09:00 olarak ayarladım.');
    return { status: 'ok', lines };
  }

  /**
   * @param {{text:string, quotedText?:string, msgId:string, ts:number, bossPhone:string|null, reply:(t:string)=>Promise<void>}} ctx
   */
  async function handle(ctx) {
    const { text, quotedText, msgId, ts, bossPhone, reply, chatId = 'default' } = ctx;
    if (seen.has(msgId)) return;
    if (nowFn() - ts > MAX_AGE_MS) return;
    const now = new Date(ts);

    // Onay bekleyen kibar mesaj varsa: evet / olduğu gibi / iptal
    const pend = pendings.get(chatId);
    if (pend && nowFn() - pend.at > PENDING_MS) pendings.delete(chatId);
    else if (pend) {
      const w = _internal.fold(text).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
      const yes = /^(evet|tamam|onay|onayla|olur|ok|okey|gonder|dogru|uygun)$/.test(w);
      const asIs = /^(oldugu gibi|aynen|aynen gonder|orijinal|kendi sozumle|degistirme)$/.test(w);
      const no = /^(iptal|iptal et|vazgec|hayir|yok)$/.test(w);
      if (yes || asIs || no) {
        seen.add(msgId);
        pendings.delete(chatId);
        if (no) return reply('🗑️ Vazgeçildi, kaydedilmedi.');
        const saved = await persist(pend.res, pend.recipient, pend.bossPhone, pend.sourceId, new Date(pend.ts), yes ? pend.outText : null);
        if (saved.status === 'dup') return;
        if (saved.status !== 'ok') return reply('⚠️ Kaydedemedim, bir hata oluştu. Birkaç dakika sonra tekrar dener misin?');
        return reply(['✅ Kaydedildi', ...saved.lines, '↩️ Mesaj zamanı gelince ona gider. Yanlışsa “iptal” yaz.'].join('\n'));
      }
    }

    if (pendings.has(chatId) && /hatirlat/.test(_internal.fold(text))) pendings.delete(chatId);   // yeni komut gelince eski onay beklemesi düşer

    const fail = (t) => { seen.add(msgId); return reply(t); };
    const askAmbiguous = (f) => fail(`❓ “${f.name}” için birden fazla kişi var: ${f.options.join(', ')}. Soyadıyla birlikte yazar mısın?`);
    const askUnknown = (f) => fail(`❓ “${f.name}” adında kayıtlı bir kişi bulamadım. Kişi önce uygulamaya eklenmeli. Kendine hatırlatmak istiyorsan cümleye “bana” ekleyip tekrar yaz.`);

    let res = null;
    let recipient = null;

    // 1) Yapay zekâ (açıksa): serbest cümleyi anlar. İptal/liste komutları ve ulaşılamama durumunda kurallara düşer.
    if (ai && /hatirlat/.test(_internal.fold(text))) {
      const quick = parseCommand(text, now, { quoted: quotedText });
      if (quick.kind !== 'cancel' && quick.kind !== 'list') {
        let out = null;
        try { out = await ai({ text, quotedText, now }); }
        catch (err) { console.error('Yapay zekâ kullanılamadı, kurallara dönülüyor:', err.message); }
        if (out) {
          if (out.kind === 'none') { seen.add(msgId); return; }
          if (out.recipientName) {
            const f = matchName(out.recipientName, await db.listContacts());
            if (f.kind === 'ambiguous') return askAmbiguous(f);
            if (f.kind === 'unknown') return askUnknown(f);
            recipient = f.contact;
          }
          res = out;
        }
      }
    }

    // 2) Kurallar: yukarıdan sonuç gelmediyse. Hatırlatma kime? Cümlede kayıtlı bir kişi yönelme hâlinde geçiyorsa ("İsrafil Reise ... hatırlat") o kişiye.
    if (!res) {
      let parseText = text;
      if (/hatirlat/.test(_internal.fold(text))) {
        const found = findRecipient(text, await db.listContacts());
        if (found.kind === 'contact') {
          recipient = found.contact;
          const [a, b] = found.span;
          parseText = text.slice(0, a) + ' '.repeat(b - a) + text.slice(b);
        } else if (found.kind === 'ambiguous') return askAmbiguous(found);
        else if (found.kind === 'unknown') return askUnknown(found);
      }
      res = parseCommand(parseText, now, { quoted: quotedText });
    }
    if (res.kind === 'none') return;
    seen.add(msgId);
    if (seen.size > 500) seen.delete(seen.values().next().value);

    if (res.kind === 'cancel') {
      const row = await db.cancelLatestChatReminder(CANCEL_WINDOW_MS);
      return reply(row
        ? `🗑️ İptal edildi: ${row.message}`
        : '❓ Son 1 saatte gruptan kaydedilmiş bekleyen bir hatırlatma bulamadım. Eskileri uygulamadan iptal edebilirsin.');
    }

    if (res.kind === 'list') {
      if (!bossPhone) return reply('⚠️ Hatırlatmanın kime gideceğini belirleyemedim. Servisin .env dosyasına BOSS_PHONE=90xxxxxxxxxx ekle.');
      const [rows, contacts] = await Promise.all([db.listPendingForBoss(bossPhone, 10), db.listContacts()]);
      if (!rows.length) return reply('📋 Bekleyen hatırlatman yok.');
      const nameOf = new Map(contacts.map((c) => [c.phone, c.name]));
      const lines = rows.map((r, i) => {
        const rt = recText(r.recurrence, r.recurrence_rule);
        const to = r.phone !== bossPhone ? ` → ${nameOf.get(r.phone) ?? r.phone}` : '';
        return `${i + 1}. ${whenText(new Date(r.remind_at), now)}${rt ? ` (${rt.toLowerCase()})` : ''}${to}\n   ${r.message}`;
      });
      return reply(`📋 Bekleyen hatırlatmaların (${rows.length}):\n${lines.join('\n')}`);
    }

    if (res.kind === 'error') return reply(errorText(res, now));

    // Başkasına gidiyorsa: kibar metin üret. "onay" modunda önce grupta göster.
    const outText = await makePolite(recipient, res.text);
    if (outText && politeMode === 'onay') {
      if (!bossPhone && !recipient) return reply(NO_TARGET);
      pendings.set(chatId, { res, recipient, outText, bossPhone, sourceId: msgId, ts: now.getTime(), at: nowFn() });
      const prev = ['✍️ Şu mesajı göndereceğim:', `“${outText}”`, `👤 Kime: ${recipient.name}`, `📅 ${whenText(res.when, now)}`];
      const rt0 = recText(res.rec, res.rule); if (rt0) prev.push(`🔁 ${rt0}`);
      prev.push('Onay için “evet”, kendi yazdığın gibi göndermek için “olduğu gibi”, vazgeçmek için “iptal” yaz.');
      return reply(prev.join('\n'));
    }

    const saved = await persist(res, recipient, bossPhone, msgId, now, outText);
    if (saved.status === 'dup') return;   // bu mesaj daha önce kaydedilmiş
    if (saved.status === 'noTarget') return reply(NO_TARGET);
    if (saved.status === 'error') return reply('⚠️ Kaydedemedim, bir hata oluştu. Birkaç dakika sonra tekrar dener misin?');
    return reply(['✅ Kaydedildi', ...saved.lines, recipient ? '↩️ Mesaj zamanı gelince ona gider. Yanlışsa “iptal” yaz.' : '↩️ Yanlışsa “iptal” yaz.'].join('\n'));
  };

  /**
   * Gruba gelen sesli mesaj: Gemini dinler, içindeki her hatırlatmayı ayrı kayıt yapar.
   * @param {{audio:Buffer, mimeType?:string, seconds?:number, msgId:string, ts:number, bossPhone:string|null, reply:(t:string)=>Promise<void>}} ctx
   */
  async function handleVoice(ctx) {
    const { audio, mimeType, seconds, msgId, ts, bossPhone, reply } = ctx;
    if (seen.has(msgId)) return;
    if (nowFn() - ts > MAX_AGE_MS) return;
    seen.add(msgId);
    if (seen.size > 500) seen.delete(seen.values().next().value);
    const now = new Date(ts);

    if (!aiAudio) return reply('⚠️ Sesli mesajı anlamak için servise GEMINI_API_KEY eklenmeli. Şimdilik yazarak gönderebilirsin.');
    if (seconds > MAX_VOICE_SEC) return reply('⚠️ Sesli mesaj çok uzun (en fazla 3 dakika). Kısaltıp tekrar gönderir misin?');
    if (!bossPhone) return reply(NO_TARGET);

    let out;
    try { out = await aiAudio({ audio, mimeType, now }); }
    catch (err) {
      console.error('Sesli mesaj anlaşılamadı:', err.message);
      return reply('⚠️ Sesli mesajı şu an anlayamadım. Yazarak gönderir misin?');
    }
    const heard = out.transcript ? `\n🎙️ Anladığım: “${out.transcript}”` : '';
    if (!out.items.length) return reply(`❓ Sesli mesajda bir hatırlatma bulamadım.${heard}`);

    const contacts = out.items.some((x) => x.recipientName) ? await db.listContacts() : [];
    const blocks = [];
    let ok = 0;
    for (let i = 0; i < out.items.length; i++) {
      const item = out.items[i];
      const n = out.items.length > 1 ? `${i + 1}. ` : '';
      if (item.kind !== 'create') { blocks.push(`${n}${errorText(item, now).replace(/^[❓⚠️]+\s*/u, '⚠️ ')}`); continue; }
      let rcp = null;
      if (item.recipientName) {
        const f = matchName(item.recipientName, contacts);
        if (f.kind === 'ambiguous') { blocks.push(`${n}❓ “${f.name}” için birden fazla kişi var (${f.options.join(', ')}). Bunu yazıyla, soyadıyla gönder.`); continue; }
        if (f.kind === 'unknown') { blocks.push(`${n}❓ “${f.name}” kayıtlı değil, bu hatırlatmayı kaydetmedim.`); continue; }
        rcp = f.contact;
      }
      const nice = politeMode === 'otomatik' ? await makePolite(rcp, item.text) : null;   // sesli mesajda onay adımı yok
      const r = await persist(item, rcp, bossPhone, `${msgId}#${i + 1}`, now, nice);
      if (r.status === 'ok') { ok++; blocks.push(`${n}${r.lines.join('\n   ')}`); }
      else if (r.status !== 'dup') blocks.push(`${n}⚠️ Kaydedemedim, bir hata oluştu.`);
    }
    if (!blocks.length) return;
    const head = ok ? `✅ Sesli mesajdan ${ok} hatırlatma kaydettim:` : '⚠️ Hiçbirini kaydedemedim:';
    return reply(`${head}\n${blocks.join('\n')}${heard}${ok ? '\n↩️ Yanlışsa “iptal” yaz (her seferinde en sonuncuyu siler).' : ''}`);
  }

  return { handle, handleVoice };
}
