import 'dotenv/config';

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Eksik ortam değişkeni: ${key} (.env dosyasını kontrol et)`);
  }
}

// 0555 123 45 67 / 555 123 45 67 → 905551234567. Boşsa null.
function normalizePhone(raw) {
  let p = String(raw ?? '').replace(/\D/g, '');
  if (!p) return null;
  if (/^0\d{10}$/.test(p)) p = '90' + p.slice(1);
  else if (/^5\d{9}$/.test(p)) p = '90' + p;
  return p;
}

export const config = {
  // WhatsApp grubundan komut alma (boşsa kapalı). Grup tam olarak iki kişi olmalı: sen ve patron.
  commandGroupName: (process.env.COMMAND_GROUP_NAME ?? '').trim(),
  bossPhone: normalizePhone(process.env.BOSS_PHONE),
  commandAllowSelf: process.env.COMMAND_ALLOW_SELF === 'true',
  // Başkasına giden hatırlatmaların başına eklenir: "Patron hatırlatıyor: Kapakları al". Boşsa "Hatırlatma: ".
  bossName: (process.env.BOSS_NAME ?? '').trim(),
  // Serbest cümleleri anlamak için Gemini (boşsa kapalı, yalnızca kurallar çalışır). Ücretsiz anahtar: aistudio.google.com
  geminiApiKey: (process.env.GEMINI_API_KEY ?? '').trim(),
  geminiModel: (process.env.GEMINI_MODEL ?? 'gemini-3.8-flash').trim(),
  // Servis kapanınca haber veren izleme adresi (healthchecks.io Ping URL). Boşsa kapalı.
  healthcheckUrl: (process.env.HEALTHCHECK_URL ?? '').trim(),
  // Başkasına giden hatırlatmaları Gemini ile kibar bir metne çevirme: onay (grupta önce göster, evet de) | otomatik | kapali
  politeMode: ['onay', 'otomatik', 'kapali'].includes((process.env.KIBAR_MESAJ ?? '').trim().toLowerCase()) ? process.env.KIBAR_MESAJ.trim().toLowerCase() : 'onay',
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 30_000),
  maxAttempts: Number(process.env.MAX_ATTEMPTS ?? 3),
  sendDelayMs: Number(process.env.SEND_DELAY_MS ?? 3_000),
  authDir: process.env.AUTH_DIR ?? './auth',
};
