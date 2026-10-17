// Servis sağlıklıysa dakikada bir dış bir izleme servisine (healthchecks.io) "yaşıyorum" der.
// Servis ya da bilgisayar kapanırsa bu haber kesilir ve izleme servisi sana e-posta/bildirim gönderir.
// Bot kapalıyken kendisi haber veremeyeceği için kontrol dışarıdan yapılır.

/**
 * @returns {{beat:()=>Promise<void>, stop:()=>void}|null} adres yoksa null
 */
export function startHeartbeat({ url, isReady, getLastOkAt, pollIntervalMs, fetchFn = fetch, now = Date.now, log = console, everyMs = 60_000 }) {
  if (!url) return null;
  const base = url.replace(/\/+$/, '');
  const staleMs = pollIntervalMs * 3 + 30_000;
  let badSince = null;
  let lastFailAt = 0;

  const ping = async (path, body) => {
    try {
      await fetchFn(base + path, { method: 'POST', body, signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      log.warn?.(`İzleme servisine ulaşılamadı: ${e.message}`);
    }
  };

  async function beat() {
    const t = now();
    const healthy = isReady() && t - getLastOkAt() < staleMs;
    if (healthy) {
      badSince = null;
      lastFailAt = 0;
      return ping('', 'ok');
    }
    badSince ??= t;
    // 2 dakikadan uzun süredir sağlıksızsa nedenini bildirerek hemen alarm ver (5 dakikada bir tekrar)
    if (t - badSince >= 120_000 && t - lastFailAt >= 300_000) {
      lastFailAt = t;
      return ping('/fail', isReady() ? 'Veritabanina ulasilamiyor veya donguler calismiyor' : 'WhatsApp baglantisi yok');
    }
  }

  const timer = setInterval(beat, everyMs);
  timer.unref?.();
  beat();
  log.log('İzleme açık: servis sağlıklıyken dakikada bir haber verilecek.');
  return { beat, stop: () => clearInterval(timer) };
}
