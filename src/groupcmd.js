// WhatsApp (Baileys) ile komut modülü arasındaki köprü: grubu doğrular, mesaj metnini çıkarır, cevabı yazar.
import { createHandler } from './commands.js';
import { interpretWithGemini, interpretAudio, politeRewrite } from './ai.js';

const norm = (s) => String(s ?? '').trim().toLocaleLowerCase('tr');
const numOf = (jid) => String(jid ?? '').split('@')[0].split(':')[0];
async function defaultDownload(m, sock) {
  const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
  return downloadMediaMessage(m, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
}
const BOT_MARKERS = ['✅', '⚠️', '❓', '📋', '🗑️', '✍️'];    // botun kendi cevapları bunlarla başlar

function unwrap(message) {
  let m = message;
  for (let i = 0; i < 4 && m; i++) {
    if (m.ephemeralMessage) m = m.ephemeralMessage.message;
    else if (m.viewOnceMessage) m = m.viewOnceMessage.message;
    else if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;
    else break;
  }
  return m;
}
const textOf = (m) => m?.conversation ?? m?.extendedTextMessage?.text ?? m?.imageMessage?.caption ?? '';
const quotedTextOf = (m) => {
  const q = m?.extendedTextMessage?.contextInfo?.quotedMessage;
  return q ? textOf(unwrap(q)) : '';
};
const tsOf = (m) => {
  const t = m.messageTimestamp;
  const n = typeof t === 'object' && t !== null && typeof t.toNumber === 'function' ? t.toNumber() : Number(t);
  return Number.isFinite(n) && n > 0 ? n * 1000 : Date.now();
};

/**
 * @returns {((ev:{messages:any[], type:string}) => Promise<void>) | null} messages.upsert işleyicisi; ayar yoksa null
 */
export function createGroupCommands({ getSocket, config, db, download = defaultDownload, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console }) {
  // Birden fazla grup: COMMAND_GROUP_NAME=asistan,Hatırlatıcı (virgül veya noktalı virgülle ayrılır)
  const groupNames = String(config.commandGroupName ?? '').split(/[,;|]/).map(norm).filter(Boolean);
  if (!groupNames.length) {
    log.log('Grup komutları kapalı (.env içinde COMMAND_GROUP_NAME yok).');
    return null;
  }
  log.log(`Grup komutları açık: ${groupNames.map((g) => `«${g}»`).join(', ')} ${groupNames.length > 1 ? 'grupları' : 'grubu'} dinleniyor.`);

  const ai = config.geminiApiKey
    ? (a) => interpretWithGemini({ ...a, apiKey: config.geminiApiKey, model: config.geminiModel })
    : null;
  if (ai) log.log(`Gemini açık (${config.geminiModel}): serbest cümleler yapay zekâyla anlaşılacak.`);
  const aiAudio = config.geminiApiKey
    ? (a) => interpretAudio({ ...a, apiKey: config.geminiApiKey, model: config.geminiModel })
    : null;
  const polite = config.geminiApiKey && config.politeMode !== 'kapali'
    ? (a) => politeRewrite({ ...a, bossName: config.bossName, apiKey: config.geminiApiKey, model: config.geminiModel })
    : null;
  if (polite) log.log(`Kibar mesaj açık (${config.politeMode ?? 'onay'}): başkasına giden hatırlatmalar nazik bir metne çevrilecek.`);
  const { handle: handler, handleVoice } = createHandler({ db, ai, aiAudio, polite, politeMode: config.politeMode ?? 'onay', prefix: config.bossName ? `${config.bossName} hatırlatıyor: ` : 'Hatırlatma: ' });
  const cache = new Map();           // grup kimliği → { at, name, allowed, boss }
  const sentIds = new Set();
  const told = new Set();
  let queue = Promise.resolve();     // mesajlar sırayla işlensin

  async function resolveGroup(sock, jid) {
    const c = cache.get(jid);
    if (c && Date.now() - c.at < 10 * 60e3) return c;
    let meta;
    try { meta = await sock.groupMetadata(jid); }
    catch (e) { log.error('Grup bilgisi alınamadı:', e.message); return c ?? null; }

    const info = { at: Date.now(), name: meta.subject, allowed: false, boss: null };
    if (groupNames.includes(norm(meta.subject))) {
      const parts = meta.participants ?? [];
      if (parts.length > 2) {
        log.error(`«${meta.subject}» grubunda ${parts.length} kişi var. Güvenlik için komutlar yalnızca iki kişilik grupta çalışır (sen + patron).`);
      } else {
        info.allowed = true;
        const self = [sock.user?.id, sock.user?.lid].filter(Boolean).map(numOf);
        const other = parts.find((p) => ![p.id, p.lid, p.phoneNumber].filter(Boolean).map(numOf).some((n) => self.includes(n)));
        const jidWithPhone = [other?.phoneNumber, other?.id].find((x) => x && String(x).endsWith('@s.whatsapp.net'));
        info.boss = config.bossPhone || (jidWithPhone ? numOf(jidWithPhone) : null);
      }
    }
    cache.set(jid, info);
    return info;
  }

  async function processOne(sock, m) {
    const jid = m.key?.remoteJid;
    if (!jid?.endsWith('@g.us') || !m.message) return;
    const msg = unwrap(m.message);
    const text = textOf(msg).trim();
    const voice = msg?.audioMessage;
    if (!text && !voice) return;

    const fromMe = !!m.key.fromMe;
    if (fromMe) {
      if (!config.commandAllowSelf) return;                          // kendi yazdıklarını ve botun cevaplarını yok say
      if (text && BOT_MARKERS.some((x) => text.startsWith(x))) return;
      if (sentIds.has(m.key.id)) return;
    }

    const info = await resolveGroup(sock, jid);
    if (!info) return;
    if (!info.allowed) {
      if (!told.has(jid)) { told.add(jid); log.log(`Başka bir gruptan mesaj geldi: «${info.name}» (komut grubu değil, yok sayılıyor).`); }
      return;
    }

    const send = async (t) => {
      await sleep(1200);   // insan gibi, anında değil
      const sent = await sock.sendMessage(jid, { text: t }, { quoted: m });
      if (sent?.key?.id) { sentIds.add(sent.key.id); if (sentIds.size > 200) sentIds.delete(sentIds.values().next().value); }
    };

    if (voice && !text) {
      let audio = null;
      try {
        if ((voice.seconds ?? 0) <= 180) audio = await download(m, sock);
      } catch (e) {
        log.error('Sesli mesaj indirilemedi:', e.message);
        return send('⚠️ Sesli mesajı indiremedim. Tekrar gönderir misin?');
      }
      return handleVoice({
        audio, mimeType: voice.mimetype, seconds: voice.seconds ?? 0,
        msgId: m.key.id, ts: tsOf(m), bossPhone: info.boss, reply: send,
      });
    }

    await handler({
      text,
      quotedText: quotedTextOf(msg),
      msgId: m.key.id,
      ts: tsOf(m),
      bossPhone: info.boss,
      chatId: jid,
      reply: send,
    });
  }

  return async function onUpsert({ messages, type }) {
    if (type !== 'notify') return;
    const sock = getSocket();
    if (!sock) return;
    for (const m of messages) {
      queue = queue.then(() => processOne(sock, m)).catch((e) => log.error('Grup komutu hatası:', e.message));
    }
    await queue;
  };
}
