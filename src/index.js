import express from 'express';
import { config } from './config.js';
import { startWhatsApp, onMessagesUpsert, onMessagesUpdate, getSocket, isReady } from './whatsapp.js';
import { createReceiptHandler } from './receipts.js';
import * as db from './supabase.js';
import { resetStuckSending } from './supabase.js';
import { createGroupCommands } from './groupcmd.js';
import { tick, getLastOkAt } from './scheduler.js';
import { startHeartbeat } from './heartbeat.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Render'ın port taramasını geçmesi ve ping servislerinin uyutmaması için HTTP endpoint'i
app.get('/', (req, res) => {
  res.status(200).send('Hatırlatıcı servisi aktif ve çalışıyor!');
});

async function main() {
  console.log('Hatırlatıcı servisi başlatılıyor...');

  const stuck = await resetStuckSending();
  if (stuck > 0) {
    console.log(`Yarım kalmış ${stuck} kayıt tekrar 'pending' yapıldı.`);
  }

  await startWhatsApp();

  // WhatsApp grubundan "yarın 14:00'te ... hatırlat" gibi komut alma (COMMAND_GROUP_NAME ayarlıysa)
  const groupCommands = createGroupCommands({ getSocket, config, db });
  if (groupCommands) onMessagesUpsert(groupCommands);

  // Gönderdiğimiz mesajların iletildi/okundu bilgisi
  onMessagesUpdate(createReceiptHandler({ markReceipt: db.markReceipt }));

  // İlk turu hemen çalıştır, sonra aralıklı olarak devam et
  await tick();
  const timer = setInterval(tick, config.pollIntervalMs);

  startHeartbeat({ url: config.healthcheckUrl, isReady, getLastOkAt, pollIntervalMs: config.pollIntervalMs });

  const shutdown = (signal) => {
    console.log(`${signal} alındı, kapatılıyor.`);
    clearInterval(timer);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Önce Express sunucusunu belirtilen porta bağla, ardından botu başlat
app.listen(PORT, async () => {
  console.log(`Web sunucusu ${PORT} portunda dinlemede.`);
  try {
    await main();
  } catch (err) {
    console.error('Başlatma hatası:', err);
    process.exit(1);
  }
});