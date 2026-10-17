// "İsrafil Reise pazartesi saat 5'te kapakları al diye hatırlat" gibi cümlelerde hatırlatmanın
// kime gideceğini, KAYITLI KİŞİLER arasından bulur. Ücretli bir yapay zeka servisi kullanmaz:
// Türkçe yönelme hâli eki (-e/-a/-ye/-ya), ünvanlar (bey, hanım, abi...) ve küçük yazım hatalarını tanır.
//
// Sonuç:
//   { kind: 'self' }                          → hatırlatma patronun kendisine
//   { kind: 'contact', contact, span }        → o kişiye; span = isim parçasının metindeki [başlangıç, bitiş)
//   { kind: 'ambiguous', name, options }      → aynı isimde birden fazla kişi var
//   { kind: 'unknown', name }                 → isim var gibi ama kayıtlı kişi bulunamadı
import { _internal } from './parser.js';

const { fold } = _internal;
const TITLES = new Set(['bey', 'hanim', 'abi', 'abla', 'usta', 'hoca', 'dr', 'doktor']);
const FILL = new Set(['diye', 'lutfen', 'de', 'da', 'bunu', 'sunu']);
const DAT = new Set(['e', 'a', 'ye', 'ya']);

function lev(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const eq = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && lev(a, b) <= 1);   // küçük yazım hatası payı

function tokenize(text) {
  const out = [];
  const re = /(\p{L}+)(?:['’](\p{L}+))?/gu;
  let m;
  while ((m = re.exec(text))) {
    out.push({
      start: m.index, end: m.index + m[0].length, raw: m[0], word: m[1],
      base: fold(m[1]), suf: m[2] ? fold(m[2]) : null, apos: !!m[2], cap: /^\p{Lu}/u.test(m[1]),
    });
  }
  return out;
}

// Bu sözcük yönelme hâlindeyse olası kökleri: "Reise" → ["reis"], "Ali'ye" → ["ali"], "Eceye" → ["ece"]
function datBases(t) {
  if (t.apos) return DAT.has(t.suf) ? [t.base] : [];
  const b = t.base, out = [];
  if (b.length > 3 && /(ye|ya)$/.test(b)) out.push(b.slice(0, -2));
  if (b.length > 2 && /[ea]$/.test(b)) out.push(b.slice(0, -1));
  return out;
}
const nom = (t, n) => eq(t.base, n);
const dat = (t, n) => datBases(t).some((b) => eq(b, n));
const titleDat = (t) => datBases(t).some((b) => TITLES.has(b));

// seq (isim parçaları) için eşleşmeleri bulur: son parça yönelme hâlinde ya da ardından "Bey'e/Hanım'a" gibi ünvan gelir
function spans(tokens, seq) {
  const found = [];
  for (let i = 0; i < tokens.length; i++) {
    let allNom = true, lastDat = true;
    for (let k = 0; k < seq.length; k++) {
      const t = tokens[i + k];
      if (!t) { allNom = false; lastDat = false; break; }
      if (!nom(t, seq[k])) allNom = false;
      if (!(k === seq.length - 1 ? dat(t, seq[k]) : nom(t, seq[k]))) lastDat = false;
    }
    let j = null;
    if (lastDat) j = i + seq.length - 1;
    else if (allNom && tokens[i + seq.length] && titleDat(tokens[i + seq.length])) j = i + seq.length;
    if (j != null) {
      const start = i > 0 && TITLES.has(tokens[i - 1].base) ? i - 1 : i;
      found.push({ i, start, j });
    }
  }
  return found;
}

export function findRecipient(text, contacts) {
  const tokens = tokenize(text);
  const trig = tokens.findIndex((t) => t.base.startsWith('hatirlat'));
  if (trig < 0) return { kind: 'self' };
  if (tokens.some((t) => t.base === 'bana' || t.base === 'kendime')) return { kind: 'self' };
  const hasDiye = tokens.some((t) => t.base === 'diye');

  // ---- adaylar ----
  const cands = [];
  for (const c of contacts ?? []) {
    const parts = fold(String(c.name ?? '')).split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    const tries = [{ seq: parts, score: parts.length > 1 ? 2 * parts.length : 3 }];
    if (parts.length > 1) { tries.push({ seq: [parts[0]], score: 1 }, { seq: [parts[parts.length - 1]], score: 1 }); }
    let best = null;
    for (const tr of tries) for (const s of spans(tokens, tr.seq)) {
      if (!best || tr.score > best.score) best = { contact: c, score: tr.score, ...s };
    }
    if (best) cands.push(best);
  }

  // ---- hangi yönelme gerçekten "alıcı" ----
  const accepted = [];
  for (const c of cands) {
    let adjacent = c.j < trig;
    for (let k = c.j + 1; k < trig && adjacent; k++) if (!FILL.has(tokens[k].base)) adjacent = false;   // "…Reise (diye) hatırlat"
    const early = c.i <= 2;                                                                            // cümle başında
    const outside = tokens.filter((_, k) => k < c.start || k > c.j);
    const selfCue = outside.some((t) => /(mayi|meyi|mak|mek)$/.test(t.base));       // "göndermeyi hatırlat" → bana
    const otherCue = outside.some((t) => /(masini|mesini|masi|mesi)$/.test(t.base)); // "göndermesini hatırlat" → ona
    const ok = adjacent || hasDiye || (early && !(selfCue && !otherCue));
    if (ok) accepted.push({ ...c, adjacent });
  }

  if (accepted.length) {
    const rank = (c) => (c.adjacent ? 100 : 0) + c.score;
    const top = Math.max(...accepted.map(rank));
    const best = accepted.filter((c) => rank(c) === top);
    const distinct = [...new Map(best.map((c) => [c.contact.phone, c])).values()];
    if (distinct.length > 1) {
      const t = tokens[best[0].i];
      return { kind: 'ambiguous', name: t.word, options: distinct.map((c) => c.contact.name) };
    }
    const c = best[0];
    return { kind: 'contact', contact: c.contact, span: [tokens[c.start].start, tokens[c.j].end] };
  }

  // ---- isim gibi duran ama kayıtlı olmayan yönelme: sessizce kendine yazılmasın ----
  let k = trig - 1;
  while (k >= 0 && FILL.has(tokens[k].base)) k--;
  const adjTok = k >= 0 ? tokens[k] : null;
  const nameLike = (t) => t && !TITLES.has(t.base) && datBases(t).length > 0 && (t.apos || t.cap) && t.cap;
  if (cands.length === 0) {
    if (nameLike(adjTok) && adjTok.apos === true) return { kind: 'unknown', name: adjTok.word };
    if (nameLike(adjTok) && adjTok.cap) return { kind: 'unknown', name: adjTok.word };
    if (hasDiye) {
      const t = tokens.find((x) => x.apos && x.cap && DAT.has(x.suf));
      if (t) return { kind: 'unknown', name: t.word };
    }
  }
  return { kind: 'self' };
}

/**
 * Yapay zekânın verdiği isim ("İsrafil Reis") kayıtlı kişilerden hangisi?
 * @returns {{kind:'contact', contact}|{kind:'ambiguous', name, options}|{kind:'unknown', name}}
 */
export function matchName(name, contacts) {
  const q = fold(String(name ?? '')).split(/[^a-z0-9]+/).filter((t) => t && !TITLES.has(t));
  if (!q.length) return { kind: 'unknown', name };
  const hits = [];
  for (const c of contacts ?? []) {
    const parts = fold(String(c.name ?? '')).split(/[^a-z0-9]+/).filter(Boolean);
    if (q.every((w) => parts.some((p) => eq(w, p)))) hits.push({ c, exact: parts.length === q.length });
  }
  const pool = hits.some((h) => h.exact) ? hits.filter((h) => h.exact) : hits;
  const distinct = [...new Map(pool.map((h) => [h.c.phone, h.c])).values()];
  if (distinct.length === 1) return { kind: 'contact', contact: distinct[0] };
  if (distinct.length > 1) return { kind: 'ambiguous', name, options: distinct.map((c) => c.name) };
  return { kind: 'unknown', name };
}
