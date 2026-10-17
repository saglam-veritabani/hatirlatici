import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { config } from './config.js';

let sock = null;
let ready = false;
const upsertListeners = [];
const updateListeners = [];

export function isReady() {
  return ready;
}

export function getSocket() {
  return sock;
}

/** Gelen mesajları dinlemek için işleyici ekler. Bağlantı yenilense de çalışmaya devam eder. */
export function onMessagesUpsert(fn) {
  upsertListeners.push(fn);
}

/** Gönderdiğimiz mesajların durum değişikliklerini (iletildi, okundu) dinler. */
export function onMessagesUpdate(fn) {
  updateListeners.push(fn);
}

/**
 * WhatsApp bağlantısını başlatır. İlk kez bağlanınca (open) Promise çözülür.
 * Bağlantı koparsa otomatik yeniden bağlanır.
 */
export async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  const { version } = await fetchLatestBaileysVersion();

  return new Promise((resolve) => {
    let firstOpen = true;

    const connect = () => {
      sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
      });

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('messages.upsert', (ev) => {
        for (const fn of upsertListeners) {
          Promise.resolve(fn(ev)).catch((err) => console.error('Mesaj işleyici hatası:', err.message));
        }
      });

      sock.ev.on('messages.update', (updates) => {
        for (const fn of updateListeners) {
          Promise.resolve(fn(updates)).catch((err) => console.error('Durum işleyici hatası:', err.message));
        }
      });

      sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          console.log('WhatsApp için bu QR kodu telefonunla tara (Bağlı Cihazlar → Cihaz Bağla):');
          qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
          ready = true;
          console.log('WhatsApp bağlandı.');
          if (firstOpen) {
            firstOpen = false;
            resolve();
          }
        }

        if (connection === 'close') {
          ready = false;
          const statusCode = lastDisconnect?.error?.output?.statusCode;

          if (statusCode === DisconnectReason.loggedOut) {
            console.error(
              'WhatsApp oturumu kapatılmış. auth klasörünü sil ve QR kodu yeniden tara.',
            );
            process.exit(1);
          }

          console.log(`Bağlantı koptu (kod: ${statusCode}). 5 sn sonra yeniden bağlanılıyor...`);
          setTimeout(connect, 5_000);
        }
      });
    };

    connect();
  });
}

/**
 * Verilen numaraya metin mesajı gönderir ve WhatsApp mesaj kimliğini döner.
 * phone: ülke kodlu, başında + olmadan. Örn: 905551234567
 */
export async function sendText(phone, text) {
  if (!ready || !sock) {
    throw new Error('WhatsApp bağlı değil');
  }

  const [result] = await sock.onWhatsApp(phone);
  if (!result?.exists) {
    throw new Error(`Bu numara WhatsApp'ta kayıtlı değil: ${phone}`);
  }

  const sent = await sock.sendMessage(result.jid, { text });
  return sent?.key?.id ?? null;   // iletildi/okundu takibi için mesaj kimliği
}
