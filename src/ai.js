// Gemini ile serbest yazılmış hatırlatma cümlesini yapıya çevirir.
// Modelin cevabına GÜVENİLMEZ: tarih, tekrar, ön hatırlatma ve alıcı burada kontrol edilir;
// alıcı ismi ancak kayıtlı kişilerle yerelde eşleşirse kullanılır (kişi listesi Google'a gönderilmez).
// Başarısız olursa (anahtar yok, internet yok, limit dolu, bozuk cevap) null döner; çağıran kurallara geri döner.

const OFFSET_MS = 3 * 3600e3;
const LEADS = [30, 60, 180, 1440, 10080];
const WD = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
const MAX_AHEAD_MS = 2 * 365 * 864e5;

const ITEM = {
  type: 'OBJECT',
  properties: {
    is_reminder: { type: 'BOOLEAN' },
    for_self: { type: 'BOOLEAN' },
    recipient_name: { type: 'STRING', nullable: true },
    message: { type: 'STRING' },
    datetime: { type: 'STRING', nullable: true },
    recurrence: { type: 'STRING', enum: ['none', 'daily', 'weekly', 'monthly'] },
    recurrence_rule: { type: 'STRING', nullable: true },
    lead_minutes: { type: 'ARRAY', items: { type: 'INTEGER' } },
  },
  required: ['is_reminder', 'for_self', 'message', 'recurrence'],
};
const SCHEMA = ITEM;
const AUDIO_SCHEMA = {
  type: 'OBJECT',
  properties: { transcript: { type: 'STRING' }, reminders: { type: 'ARRAY', items: ITEM } },
  required: ['transcript', 'reminders'],
};

// Model adları zamanla değişir; yeni anahtarlar eski modellere erişemeyebilir (HTTP 404). Sırayla yenilerini dener.
const FALLBACK_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
const working = new Map();   // istenen model → çalışan model

async function generate({ apiKey, model, body, fetchFn, timeoutMs }) {
  const first = working.get(model) ?? model;
  const order = [...new Set([first, model, ...FALLBACK_MODELS])];
  let last = null;
  for (const m of order) {
    const res = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      if (m !== model && working.get(model) !== m) {
        working.set(model, m);
        console.warn(`Gemini: «${model}» kullanılamadı, «${m}» ile devam ediliyor. .env içinde GEMINI_MODEL=${m} yazabilirsin.`);
      }
      return res.json();
    }
    let detail = '';
    try { detail = String((await res.json())?.error?.message ?? '').slice(0, 200); } catch { /* gövde yok */ }
    last = new Error(`Gemini HTTP ${res.status}${detail ? ' - ' + detail : ''} (model: ${m})`);
    if (res.status !== 404) throw last;   // yalnızca "model yok" durumunda başka model dene
  }
  throw last;
}

function localParts(now) {
  const d = new Date(now.getTime() + OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return {
    iso: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
    weekday: WD[d.getUTCDay()],
  };
}

export function buildPrompt(now) {
  const { iso, weekday } = localParts(now);
  return `Sen bir WhatsApp hatırlatma asistanısın. Patron grupta Türkçe, serbest bir cümleyle hatırlatma ister. Cümleyi JSON'a çevir.
Şu an (İstanbul saati): ${iso}, ${weekday}.

Kurallar:
- is_reminder: Cümle bir şeyi belirli bir zamanda hatırlatma isteği değilse false yap (diğer alanları boş geç).
- for_self: Hatırlatma patronun kendisine ise true ("bana", "kendime" ya da hiç kişi yoksa). Cümle başka bir kişiye mesaj gönderilmesini istiyorsa ("İsrafil'e pazartesi 5'te kapakları al diye hatırlat") false ve recipient_name o kişinin adı (ekler olmadan, yazıldığı gibi, ünvansız: "İsrafil Reise" → "İsrafil Reis"). Bir isim sadece konunun parçasıysa ("Ahmet'le toplantıyı hatırlat") hatırlatma patrona gider: for_self true.
- message: Hatırlatılacak asıl metin. Kişi adını, zamanı ve "hatırlat" kelimesini çıkar. Kısa, düzgün Türkçe, ilk harf büyük, nokta yok. Örnek: "kapakları al", "Faturaların ödemesi". Alıntılanan mesaj varsa ve cümlede başka konu yoksa message = alıntılanan metin.
- datetime: Hatırlatmanın GÖNDERİLECEĞİ an, İstanbul saatiyle "YYYY-MM-DDTHH:mm". Göreli ifadeleri ("yarın", "2 saat sonra", "pazartesi", "haftaya", "ayın 15'i") yukarıdaki şu andan hesapla. Gün adı verildiyse en yakın gelecek o gün (bugünse ve saat geçmediyse bugün). Sabah/akşam yoksa "saat 1-6" öğleden sonra (13-18), diğerleri yazıldığı gibi. Tarih var saat yoksa 09:00. Ne tarih ne saat varsa null. "Toplantıdan 1 saat önce" gibi ifadelerde hatırlatma anını hesapla.
- recurrence: none | daily | weekly | monthly. "her gün" daily, "her pazartesi" weekly, "her ayın 15'i" monthly. Yıllık yok, none yap.
- recurrence_rule: weekly için gün numarası (Pazar=0, Pazartesi=1 ... Cumartesi=6), monthly için ayın günü (1-28), diğerlerinde null.
- lead_minutes: "1 gün önce de hatırlat" gibi EK ön hatırlatma istekleri. Sadece şu değerlerden: 30, 60, 180, 1440, 10080. Yoksa boş liste.
Sadece JSON döndür.`;
}

/** Modelin ham JSON'unu doğrular ve işleyicinin kullandığı biçime çevirir. */
export function normalize(raw, now, quotedText) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.is_reminder !== true) return { kind: 'none' };

  const recipientName = raw.for_self === false && typeof raw.recipient_name === 'string' && raw.recipient_name.trim()
    ? raw.recipient_name.trim().slice(0, 80) : null;

  let text = String(raw.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
  text = text.charAt(0).toLocaleUpperCase('tr') + text.slice(1);
  if (!text && quotedText) text = String(quotedText).trim().slice(0, 500);

  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(raw.datetime ?? '').trim());
  if (!m) return { kind: 'error', reason: 'time', recipientName };
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const when = new Date(Date.UTC(y, mo - 1, d, h, mi) - OFFSET_MS);
  const back = new Date(when.getTime() + OFFSET_MS);
  const valid = h < 24 && mi < 60 && back.getUTCDate() === d && back.getUTCMonth() === mo - 1;
  if (!valid || when.getTime() - now.getTime() > MAX_AHEAD_MS) return { kind: 'error', reason: 'date', recipientName };

  if (!text) return { kind: 'error', reason: 'empty', when, recipientName };
  if (when.getTime() <= now.getTime()) return { kind: 'error', reason: 'past', when, recipientName };

  let rec = ['daily', 'weekly', 'monthly'].includes(raw.recurrence) ? raw.recurrence : 'none';
  let rule = null;
  if (rec === 'weekly') {
    const n = Number(raw.recurrence_rule);
    if (Number.isInteger(n) && n >= 0 && n <= 6) rule = String(n);
    else rec = 'none';
  } else if (rec === 'monthly') {
    const n = Number(raw.recurrence_rule);
    if (Number.isInteger(n) && n >= 1 && n <= 28) rule = String(n);
    else rec = 'none';
  }

  const leads = [...new Set((Array.isArray(raw.lead_minutes) ? raw.lead_minutes : []).map(Number))]
    .filter((l) => LEADS.includes(l) && when.getTime() - l * 60e3 > now.getTime())
    .sort((a, b) => b - a);

  return { kind: 'create', when, text, rec, rule, leads, shiftMin: null, defaultedTime: false, recipientName };
}

/**
 * @returns {Promise<object|null>} normalize() sonucu; ulaşılamazsa null (kurallara dön).
 */
export async function interpretWithGemini({ text, quotedText, now, apiKey, model = 'gemini-3.8-flash', fetchFn = fetch, timeoutMs = 15000 }) {
  if (!apiKey) return null;
  const userText = quotedText ? `Alıntılanan mesaj: «${quotedText}»\nPatronun yazdığı: ${text}` : text;
  const body = await generate({
    apiKey, model, fetchFn, timeoutMs,
    body: {
      systemInstruction: { parts: [{ text: buildPrompt(now) }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA },
    },
  });
  const out = body?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  let json;
  try { json = JSON.parse(out); } catch { throw new Error('Gemini cevabı JSON değil'); }
  return normalize(json, now, quotedText);
}

const AUDIO_EXTRA = `

Girdi bir SES KAYDI. Önce ne söylendiğini transcript alanına kısaca yaz (en fazla 2 cümle). Kayıtta birden fazla hatırlatma varsa her birini reminders listesinde AYRI öğe yap; yukarıdaki kurallar her öğe için geçerli. Hatırlatma isteği yoksa reminders boş liste olsun. Sadece JSON döndür.`;

const MAX_AUDIO_BYTES = 6 * 1024 * 1024;

/**
 * Sesli mesajı dinler. Ulaşılamazsa fırlatır (çağıran kullanıcıya haber verir).
 * @returns {Promise<{transcript:string, items:object[]}>} items: normalize() sonuçları (kind none olanlar ayıklanır)
 */
export async function interpretAudio({ audio, mimeType = 'audio/ogg', now, apiKey, model = 'gemini-3.8-flash', fetchFn = fetch, timeoutMs = 45000 }) {
  if (!apiKey) throw new Error('GEMINI_API_KEY yok');
  if (!audio?.length || audio.length > MAX_AUDIO_BYTES) throw new Error('Ses dosyası boş ya da çok büyük');
  const body = await generate({
    apiKey, model, fetchFn, timeoutMs,
    body: {
      systemInstruction: { parts: [{ text: buildPrompt(now) + AUDIO_EXTRA }] },
      contents: [{ role: 'user', parts: [
        { inlineData: { mimeType: String(mimeType).split(';')[0].trim() || 'audio/ogg', data: Buffer.from(audio).toString('base64') } },
        { text: 'Bu sesli mesajdaki hatırlatma isteklerini çıkar.' },
      ] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: AUDIO_SCHEMA },
    },
  });
  const out = body?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  let json;
  try { json = JSON.parse(out); } catch { throw new Error('Gemini cevabı JSON değil'); }
  const items = (Array.isArray(json.reminders) ? json.reminders : []).slice(0, 8)
    .map((r) => normalize(r, now, ''))
    .filter((r) => r && r.kind !== 'none');
  return { transcript: String(json.transcript ?? '').replace(/\s+/g, ' ').trim().slice(0, 300), items };
}


/* ---------- Kibar mesaj ---------- */

const fold = (t) => String(t ?? '').toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * Yapay zekânın yazdığı kibar metin, orijinal anlamı korumuyorsa reddedilir (null döner).
 * Kontroller: uzunluk, link yok, orijinalde olmayan sayı yok, orijinalin anahtar kelimelerinin çoğu duruyor.
 */
export function checkPolite(original, out) {
  let t = String(out ?? '').replace(/\s+/g, ' ').trim().replace(/^["“”']+|["“”']+$/g, '').trim();
  if (t.length < 8 || t.length > 400) return null;
  if (/https?:|www\./i.test(t)) return null;
  const nums = (x) => String(x).match(/\d+/g) ?? [];
  const have = new Set(nums(original));
  if (nums(t).some((n) => !have.has(n))) return null;           // uydurma saat/miktar/numara
  const words = fold(original).split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  if (words.length) {
    const tw = fold(t).split(/[^a-z0-9]+/).filter(Boolean);
    const kept = words.filter((w) => tw.some((x) => x.startsWith(w.slice(0, 4)))).length;
    if (kept / words.length < 0.5) return null;                  // başka bir şeyden bahsediyor
  }
  return t;
}

function politePrompt({ recipientName, bossName }) {
  return `Patron, bir kişiye gidecek kısa bir WhatsApp hatırlatması yazdırıyor. Verilen hatırlatma metnini nazik, saygılı ve doğal bir Türkçe mesaja çevir.
Kurallar:
- Anlamı AYNEN koru. Yeni bilgi (saat, gün, tarih, sayı, yer, isim, miktar) ekleme, hiçbirini çıkarma.
- En fazla 2 kısa cümle. Emoji, link ve imza yok.
- Hitap: alıcının yalnızca ilk adı ("${String(recipientName).split(/\s+/)[0]}"). "Bey", "Hanım", "Abi" gibi ek kullanma, cinsiyeti bilmiyoruz. Kısa bir "Merhaba" olabilir.
- Mesaj tam hatırlatma anında gönderilecek; "bugün", "yarın", "birazdan" gibi göreli zaman ekleme.
- Emir kipini rica kipine çevir ("kapakları al" → "kapakları almayı unutmayın").
${bossName ? `- Mesajın içinde bunun "${bossName}" tarafından hatırlatıldığı geçsin (örnek: "${bossName} hatırlatıyor: ...").` : '- Kimin adına olduğunu yazma.'}
Sadece {"message": "..."} biçiminde JSON döndür.`;
}

/**
 * Başkasına giden hatırlatmayı kibar bir metne çevirir.
 * Ulaşılamazsa fırlatır; anlam değişmişse null döner. Çağıran ikisinde de eski metne döner.
 */
export async function politeRewrite({ recipientName, bossName = '', text, apiKey, model = 'gemini-3.8-flash', fetchFn = fetch, timeoutMs = 15000 }) {
  if (!apiKey || !text) return null;
  const body = await generate({
    apiKey, model, fetchFn, timeoutMs,
    body: {
      systemInstruction: { parts: [{ text: politePrompt({ recipientName, bossName }) }] },
      contents: [{ role: 'user', parts: [{ text: `Hatırlatma metni: ${text}` }] }],
      generationConfig: { temperature: 0.3, responseMimeType: 'application/json', responseSchema: { type: 'OBJECT', properties: { message: { type: 'STRING' } }, required: ['message'] } },
    },
  });
  const raw = body?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  let json;
  try { json = JSON.parse(raw); } catch { throw new Error('Gemini cevabı JSON değil'); }
  return checkPolite(text, json?.message);
}
