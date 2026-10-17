import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  proto,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { config } from './config.js';
import { supabase } from './supabase.js'; // Supabase bağlantınızı içeri aktarıyoruz

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

export function onMessagesUpsert(fn) {
  upsertListeners.push(fn);
}

export function onMessagesUpdate(fn) {
  updateListeners.push(fn);
}

/**
 * Supabase tabanlı özel Auth State yöneticisi
 */
async function useSupabaseAuthState(sessionId = 'primary_session') {
  const writeData = async (data, key) => {
    const stringified = JSON.stringify(data, (k, v) => (v instanceof Buffer ? Buffer.from(v).toString('base64') : v), 2);
    await supabase
      .from('whatsapp_sessions')
      .upsert({ key: `${sessionId}_${key}`, value: stringified });
  };

  const readData = async (key) => {
    try {
      const { data, error } = await supabase
        .from('whatsapp_sessions')
        .select('value')
        .eq('key', `${sessionId}_${key}`)
        .single();
      
      if (error || !data) return null;

      return JSON.parse(data.value, (k, v) => {
        if (v !== null && typeof v === 'object' && v.type === 'Buffer' && Array.isArray(v.data)) {
          return Buffer.from(v.data);
        }
        return v;
      });
    } catch {
      return null;
    }
  };

  const removeData = async (key) => {
    try {
      await supabase
        .from('whatsapp_sessions')
        .delete()
        .eq('key', `${sessionId}_${key}`);
    } catch {}
  };

  const creds = await readData('creds') || (await import('@whiskeysockets/baileys')).initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              if (value) {
                tasks.push(writeData(value, key));
              } else {
                tasks.push(removeData(key));
              }
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => writeData(creds, 'creds')
  };
}

/**
 * WhatsApp bağlantısını başlatır.
 */
export async function startWhatsApp() {
  const { state, saveCreds } = await useSupabaseAuthState('bot_session');
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
              'WhatsApp oturumu kapatılmış. Supabase tablosunu temizle ve QR kodu yeniden tara.',
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

export async function sendText(phone, text) {
  if (!ready || !sock) {
    throw new Error('WhatsApp bağlı değil');
  }

  const [result] = await sock.onWhatsApp(phone);
  if (!result?.exists) {
    throw new Error(`Bu numara WhatsApp'ta kayıtlı değil: ${phone}`);
  }

  const sent = await sock.sendMessage(result.jid, { text });
  return sent?.key?.id ?? null;
}