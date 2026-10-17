// Türkçe doğal dil hatırlatma çözücü.
// "yarın 14:00'te Ahmet'le toplantıyı hatırlat" gibi cümleyi tarih, saat, tekrar, ön hatırlatma
// ve metne ayırır. Saf fonksiyondur: ağ, veritabanı ya da saat okumaz, "şimdi" dışarıdan verilir.
// Tüm zamanlar İstanbul saatidir (UTC+3, yaz saati yok).

const OFFSET_MS = 3 * 3600e3;
const APOS = /[’‘ʼ´`]/g;
const FOLD = { 'ı': 'i', 'İ': 'i', 'ş': 's', 'Ş': 's', 'ğ': 'g', 'Ğ': 'g', 'ü': 'u', 'Ü': 'u', 'ö': 'o', 'Ö': 'o', 'ç': 'c', 'Ç': 'c' };

// Küçük harfe ve ASCII'ye çevirir. Her karakter tek karaktere döndüğü için uzunluk korunur,
// böylece eşleşme konumları orijinal metinle birebir örtüşür.
function fold(s) {
  let out = '';
  for (const ch of s) out += FOLD[ch] ?? ch.toLowerCase();
  return out;
}

const MONTHS = { ocak: 0, subat: 1, mart: 2, nisan: 3, mayis: 4, haziran: 5, temmuz: 6, agustos: 7, eylul: 8, ekim: 9, kasim: 10, aralik: 11 };
const WDAYS = { pazar: 0, pazartesi: 1, sali: 2, carsamba: 3, persembe: 4, cuma: 5, cumartesi: 6 };
const NUMW = { bir: 1, iki: 2, uc: 3, dort: 4, bes: 5, alti: 6, yedi: 7, sekiz: 8, dokuz: 9, on: 10, onbes: 15, yirmi: 20, otuz: 30, kirk: 40, kirkbes: 45, elli: 50, yarim: 0.5 };
const UNIT_MIN = { dakika: 1, dk: 1, saat: 60, gun: 1440, hafta: 10080 };

const NUMN = '\\d+(?:[.,]\\d+)?|yarim|bir|iki|uc|dort|bes|alti|yedi|sekiz|dokuz|on\\s*bes|on|yirmi|otuz|kirk\\s*bes|kirk|elli';
const UNITN = 'dakika|dk|saat|gun|hafta';
const MONTHN = Object.keys(MONTHS).join('|');
const WDAYN = 'pazartesi|sali|carsamba|persembe|cumartesi|cuma|pazar';
const PERIODN = 'sabah|oglen|ogle|ogleden sonra|aksam|gece';
const SUFFIX = "(?:\\s*'\\s*(?:te|de|ta|da|ye|ya|e|a)\\b|\\s*(?:te|de|ta|da)\\b)?";

const parseNum = (tok) => {
  const t = tok.replace(/\s+/g, '');
  return NUMW[t] ?? parseFloat(t.replace(',', '.'));
};

// ---- Gün hesabı (İstanbul duvar saati) ----
const toLocal = (ms) => new Date(ms + OFFSET_MS);
const addDays = (dt, n) => {
  const x = new Date(Date.UTC(dt.y, dt.m, dt.d + n));
  return { y: x.getUTCFullYear(), m: x.getUTCMonth(), d: x.getUTCDate() };
};
const dow = (dt) => new Date(Date.UTC(dt.y, dt.m, dt.d)).getUTCDay();   // 0 = Pazar
const mk = (dt, hh, mm) => new Date(Date.UTC(dt.y, dt.m, dt.d, hh, mm) - OFFSET_MS);
const dim = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const validDate = (y, m, d) => m >= 0 && m <= 11 && d >= 1 && d <= dim(y, m);

// Metin üzerinde "tüket" mantığı: bulunan parçalar maskelenir, sonunda geri kalan metin hatırlatma metni olur.
class Doc {
  constructor(raw) {
    this.raw = raw.replace(APOS, "'");
    this.g = fold(this.raw);
    this.cuts = [];
  }
  find(re) {
    const m = re.exec(this.g);
    if (!m) return null;
    this.consume(m.index, m.index + m[0].length);
    return m;
  }
  peek(re) { return re.exec(this.g); }
  consume(a, b) {
    this.cuts.push([a, b]);
    this.g = this.g.slice(0, a) + ' '.repeat(b - a) + this.g.slice(b);
  }
  rest() {
    let out = this.raw;
    for (const [a, b] of this.cuts) out = out.slice(0, a) + ' '.repeat(b - a) + out.slice(b);
    return out;
  }
}

function resolveHour(h, period) {
  if (h >= 13 || h === 0) return h;
  switch (period) {
    case 'sabah': return h;
    case 'oglen': case 'ogle': return h <= 3 ? h + 12 : h;
    case 'ogleden sonra': return h < 12 ? h + 12 : h;
    case 'aksam': return h < 12 ? h + 12 : h;
    case 'gece': return h === 12 ? 0 : h >= 6 ? h + 12 : h;
    default: return h <= 6 ? h + 12 : h;   // "saat 3" büyük olasılıkla 15:00
  }
}
const PERIOD_DEFAULT = { sabah: [9, 0], oglen: [12, 0], ogle: [12, 0], 'ogleden sonra': [15, 0], aksam: [19, 0], gece: [22, 0] };

const CANCEL = /^(iptal(\s+et)?|vazgec|geri\s+al)(\s+(bunu|onu|son(uncu)?))?[\s.!]*$/;
const LIST = /^(liste|listele|neler\s+var|hatirlatmalarim|hatirlatmalari\s+(goster|listele)|bekleyenler)[\s?.!]*$/;

const cleanText = (s) => {
  let t = s.replace(/\s+/g, ' ').trim();
  t = t.replace(/(^|\s)'(?:te|de|ta|da|ye|ya|e|a|i|u)(?=\s|$)/g, '$1');
  t = t.replace(/\s+([,.;:!?])/g, '$1').replace(/([,.;:])\1+/g, '$1');
  t = t.replace(/^[\s,.;:!?\-–—'"]+|[\s,.;:!?\-–—'"]+$/g, '');
  t = t.replace(/^(ve|de|da|ki|ama)\s+/i, '');
  return t.charAt(0).toLocaleUpperCase('tr') + t.slice(1);
};

/**
 * @param {string} rawText   Mesaj metni
 * @param {Date}   now       Mesajın gönderildiği an (göreli ifadeler buna göre çözülür)
 * @param {{quoted?: string}} opts  Cevap olarak yazıldıysa alıntılanan mesajın metni
 * @returns {{kind:'none'}|{kind:'cancel'}|{kind:'list'}|{kind:'error',reason:string}|{kind:'create',...}}
 */
export function parseCommand(rawText, now = new Date(), opts = {}) {
  const raw = String(rawText ?? '').trim();
  if (!raw) return { kind: 'none' };
  const f = fold(raw.replace(APOS, "'")).trim();

  if (CANCEL.test(f)) return { kind: 'cancel' };
  if (LIST.test(f)) return { kind: 'list' };
  if (!/hatirlat/.test(f)) return { kind: 'none' };

  // Tek mesajda tek zaman: birden fazlası sessizce ilkine indirgenmesin
  const days = new Set((f.match(new RegExp(`\\b(?:${WDAYN})(?![a-z])`, 'g')) || []));
  const clocks = new Set((f.match(/\b\d{1,2}:\d{2}\b/g) || []));
  if (days.size > 1 || clocks.size > 1) return { kind: 'error', reason: 'multi' };

  const d = new Doc(raw);
  const nowL = toLocal(now.getTime());
  const today = { y: nowL.getUTCFullYear(), m: nowL.getUTCMonth(), d: nowL.getUTCDate() };

  if (d.peek(/\bher\s+(yil|sene)\b|\byillik\b/)) return { kind: 'error', reason: 'yearly' };

  // ---------- Tekrar ----------
  let rec = 'none';
  let recWeekday = null;
  let recMonthDay = null;
  let m;
  if ((m = d.find(new RegExp(`\\bher\\s+(${WDAYN})(?:\\s+gunu?)?(?![a-z])`)))) { rec = 'weekly'; recWeekday = WDAYS[m[1]]; }
  else if (d.find(/\bher\s+hafta\b/)) rec = 'weekly';
  else if ((m = d.find(/\bher\s+ay(?:in)?\s+(\d{1,2})\s*(?:'\s*)?(?:i|u|inde|inci|si|sinde|nde)?(?![a-z])/))) { rec = 'monthly'; recMonthDay = +m[1]; }
  else if (d.find(/\bher\s+ay\b/)) rec = 'monthly';
  else if (d.find(/\bher\s+gun\b/)) rec = 'daily';
  else if (d.find(/\bher(?=\s+(?:sabah|oglen|ogle|aksam|gece)\b)/)) rec = 'daily';

  // ---------- Önce ifadeleri: "1 saat önce", "1 gün ve 1 saat önce de" ----------
  let leads = [];
  let shiftMin = null;
  const leadRe = new RegExp(`\\b(?:(?:${NUMN})\\s*(?:${UNITN})(?:\\s*(?:,|ve)\\s*)?)+\\s*once(\\s+de)?(?![a-z])`);
  if ((m = d.find(leadRe))) {
    const mins = [];
    for (const p of m[0].matchAll(new RegExp(`(${NUMN})\\s*(${UNITN})`, 'g'))) {
      const v = Math.round(parseNum(p[1]) * UNIT_MIN[p[2]]);
      if (v > 0) mins.push(v);
    }
    const additional = !!m[1] || mins.length > 1 || !!d.find(/\bayrica\b/);
    if (additional) leads = [...new Set(mins)].sort((a, b) => b - a);
    else shiftMin = mins[0] ?? null;
  } else d.find(/\bayrica\b/);

  // ---------- Göreli süre: "2 saat sonra", "yarım saat sonra", "3 gün sonra" ----------
  let instant = null;       // dakika/saat: kesin an
  let relDays = null;       // gün/hafta: tarih kayması
  const durRe = new RegExp(`\\b(${NUMN})(\\s+bucuk)?\\s*(${UNITN})\\s+(?:sonra|icinde)(?![a-z])`);
  if ((m = d.find(durRe))) {
    const n = parseNum(m[1]) + (m[2] ? 0.5 : 0);
    const unit = m[3];
    if ((unit === 'gun' || unit === 'hafta') && Number.isInteger(n)) relDays = n * (unit === 'gun' ? 1 : 7);
    else instant = Math.round(n * UNIT_MIN[unit]);
  }

  // ---------- Tarih ----------
  let date = null;          // {y,m,d}
  let dateExplicit = false;
  const yearFor = (mo, da) => {
    let y = today.y;
    if (mk({ y, m: mo, d: da }, 23, 59) < now) y += 1;
    return y;
  };
  if ((m = d.find(new RegExp(`\\b(\\d{1,2})\\s*(${MONTHN})(?:\\s*(\\d{4}))?${SUFFIX}`)))) {
    const da = +m[1], mo = MONTHS[m[2]], y = m[3] ? +m[3] : yearFor(mo, da);
    if (!validDate(y, mo, da)) return { kind: 'error', reason: 'date' };
    date = { y, m: mo, d: da }; dateExplicit = true;
  } else if ((m = d.find(/\b(\d{1,2})\s*[./]\s*(\d{1,2})\s*[./]\s*(\d{4}|\d{2})\b/))) {
    const da = +m[1], mo = +m[2] - 1, y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    if (!validDate(y, mo, da)) return { kind: 'error', reason: 'date' };
    date = { y, m: mo, d: da }; dateExplicit = true;
  }

  // ---------- Saat ----------
  d.find(/\bbu(?=\s+(?:sabah|oglen|ogle|aksam|gece)\b)/);   // "bu akşam"
  let time = null;          // {h, m}
  let period = null;
  const setClock = (hStr, minStr, buc, per) => {
    const h = +hStr;
    const mi = minStr != null ? +minStr : (buc ? 30 : 0);
    period = per ?? period;
    // "01:00" gibi başında sıfır olan saat 24 saatlik yazılmıştır, olduğu gibi alınır
    time = { h: /^0\d$/.test(hStr) && !per ? h : resolveHour(h, per), m: mi };
  };

  if ((m = d.find(new RegExp(`\\b(${PERIODN})\\s*(?:saat\\s*)?([01]?\\d|2[0-3])(?:\\s*[:.]\\s*([0-5]\\d))?(\\s*bucuk(?:ta|te)?)?${SUFFIX}(?![a-z0-9])`)))) {
    setClock(m[2], m[3], m[4], m[1]);
  } else if ((m = d.find(new RegExp(`\\b([01]?\\d|2[0-3])\\s*:\\s*([0-5]\\d)\\b${SUFFIX}`)))) {
    setClock(m[1], m[2], false, null);
  } else if ((m = d.find(new RegExp(`\\bsaat\\s*([01]?\\d|2[0-3])(?:\\s*[:.]\\s*([0-5]\\d))?(\\s*bucuk(?:ta|te)?)?${SUFFIX}(?![a-z0-9])`)))) {
    setClock(m[1], m[2], m[3], null);
  } else if ((m = d.find(/\b([01]?\d|2[0-3])(?:\s*'\s*|(?<=\d))(?:te|de|ta|da)\b/))) {
    setClock(m[1], null, false, null);
  } else if (!date && (m = d.peek(/\b(\d{1,2})[./](\d{1,2})\b(?![./]\d)/))) {
    const a = +m[1], b = +m[2];
    d.consume(m.index, m.index + m[0].length);
    if (a >= 1 && a <= 31 && b >= 1 && b <= 12) {
      const y = yearFor(b - 1, a);
      if (validDate(y, b - 1, a)) { date = { y, m: b - 1, d: a }; dateExplicit = true; }
    } else if (a <= 23 && b <= 59) setClock(a, b, false, null);
  }

  // "sabah", "akşam" gibi tek başına duran gün bölümü
  const per = d.find(new RegExp(`\\b(${PERIODN})\\b`));
  if (per) {
    period = per[1];
    if (time && time.h <= 12 && time.h >= 1) time.h = resolveHour(time.h, period);   // "sabah toplantı 9'da"
    if (!time) { const [h, mi] = PERIOD_DEFAULT[period]; time = { h, m: mi }; time.fromPeriod = true; }
  }

  // ---------- Göreli günler ve hafta günleri ----------
  let weekday = null;
  let nextWeek = false;
  if (d.find(/\bbu\s*gun\b/)) { date = date ?? today; dateExplicit = true; }
  if (d.find(/\bobur\s+gun\b|\byarindan\s+sonra\b/)) { date = date ?? addDays(today, 2); dateExplicit = true; }
  else if (d.find(/\byarin\b/)) { date = date ?? addDays(today, 1); dateExplicit = true; }
  if (d.find(/\b(?:haftaya|gelecek\s+hafta|seneye)\b/)) nextWeek = true;
  if ((m = d.find(new RegExp(`\\b(${WDAYN})(?:\\s*(?:ya|ye|da|de|ta|te|ci|si|yi|yu))?(?:\\s+gunu?)?(?![a-z])`)))) weekday = WDAYS[m[1]];
  let adhocMonthDay = null;     // "ayın 15'inde"
  if (!date && (m = d.find(/\bayin\s+(\d{1,2})\s*(?:'\s*)?(?:i|u|inde|inci|si|sinde|nde)?(?![a-z])/))) adhocMonthDay = +m[1];
  d.find(/\bsaat\b(?!\s*\d)/);

  // ---------- Tarih/saat birleştir ----------
  const hasAnyTime = instant != null || relDays != null || date || time || weekday != null || nextWeek || rec !== 'none' || adhocMonthDay;
  if (!hasAnyTime) return { kind: 'error', reason: 'time' };

  let when;
  let defaultedTime = false;
  if (instant != null) {
    when = new Date(Math.ceil((now.getTime() + instant * 60e3) / 60e3) * 60e3);
  } else {
    if (!time) { time = { h: 9, m: 0 }; defaultedTime = true; }
    const { h, m: mi } = time;

    if (date) {
      // açık tarih
    } else if (relDays != null) {
      date = addDays(today, relDays);
      dateExplicit = true;
    } else if (rec === 'weekly' && recWeekday != null || weekday != null) {
      const wd = recWeekday ?? weekday;
      if (nextWeek) {
        const monIdx = (dow(today) + 6) % 7;
        date = addDays(addDays(today, 7 - monIdx), (wd + 6) % 7);
      } else {
        let diff = (wd - dow(today) + 7) % 7;
        if (diff === 0 && mk(today, h, mi) <= now) diff = 7;
        date = addDays(today, diff);
      }
      dateExplicit = true;
    } else if (nextWeek) {
      date = addDays(today, 7); dateExplicit = true;
    } else if ((rec === 'monthly' && recMonthDay) || adhocMonthDay) {
      const day = recMonthDay ?? adhocMonthDay;
      let y = today.y, mo = today.m;
      const at = (yy, mm) => ({ y: yy, m: mm, d: Math.min(day, dim(yy, mm)) });
      if (mk(at(y, mo), h, mi) <= now) { mo += 1; if (mo > 11) { mo = 0; y += 1; } }
      date = at(y, mo); dateExplicit = true;
    } else {
      date = today;
      if (mk(date, h, mi) <= now) date = addDays(today, 1);   // "saat 14'te" → bir sonraki 14:00
    }
    when = mk(date, h, mi);
    // "bu gece 1'de" gibi gece yarısını geçen saatler ertesi güne düşer
    if (!dateExplicit && when <= now) when = new Date(when.getTime() + 864e5);
  }

  const eventWhen = when;
  if (shiftMin != null) when = new Date(when.getTime() - shiftMin * 60e3);
  if (when.getTime() <= now.getTime() + 15e3) return { kind: 'error', reason: 'past', when };

  leads = leads.filter((mn) => when.getTime() - mn * 60e3 > now.getTime() + 60e3);

  // ---------- Metin ----------
  let rest = d.rest();
  let rf = fold(rest);
  const blank = (re) => {
    let mm;
    while ((mm = re.exec(rf))) {
      rest = rest.slice(0, mm.index) + ' '.repeat(mm[0].length) + rest.slice(mm.index + mm[0].length);
      rf = rf.slice(0, mm.index) + ' '.repeat(mm[0].length) + rf.slice(mm.index + mm[0].length);
      if (mm[0].length === 0) break;
    }
  };
  blank(/\bhatirla\w*/);
  blank(/\b(?:istiyorum|istiyoruz|istiyom|rica\s+(?:ederim|ediyorum)|ederim|ediyorum|lutfen|ayrica|misin|musun)\b/);
  blank(/\b(?:bunu|sunu|bana|beni|bize)\b/);
  blank(/\bdiye\b/);
  blank(/\b(?:bu|su)?\s*(?:tarihte|tarihlerde|tarihinde|saatte|saatlerde|saatinde|zamanda)\b/);
  let text = cleanText(rest);
  if (!text && opts.quoted) text = cleanText(String(opts.quoted));
  if (!text) return { kind: 'error', reason: 'empty', when };
  if (shiftMin != null) {
    const hh = String(toLocal(eventWhen.getTime()).getUTCHours()).padStart(2, '0');
    const mm2 = String(toLocal(eventWhen.getTime()).getUTCMinutes()).padStart(2, '0');
    text = `${text} (saat ${hh}:${mm2})`;
  }

  const wl = toLocal(when.getTime());
  const rule = rec === 'weekly' ? String(wl.getUTCDay()) : rec === 'monthly' ? String(wl.getUTCDate()) : null;

  return { kind: 'create', when, eventWhen, shiftMin, text, rec, rule, leads, defaultedTime };
}

export const _internal = { fold };
