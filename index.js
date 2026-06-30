const { connectDB } = require('./db');
const { createSession, listSessions, deleteSession } = require('./sessionManager');
const { startTelegram } = require('./telegram/panel');
const config = require('./config');

global.BOT_START = Date.now();

async function onConnected(sock, sessionId) {
  console.log(`✅ Connected: ${sessionId} as ${sock.user?.id}`);
  try {
    const TelegramBot = require('node-telegram-bot-api');
    const tg = new (TelegramBot.default || TelegramBot)(config.TELEGRAM_TOKEN, { polling: false });
    tg.sendMessage(config.TELEGRAM_OWNER_ID, `✅ *Session Connected*\n\n📱 +${sessionId}\n👤 ${sock.user?.id}`, { parse_mode: 'Markdown' });
  } catch (_) {}
}

function onDisconnected(sessionId) {
  console.log(`❌ Session permanently disconnected: ${sessionId}`);
  try {
    const TelegramBot = require('node-telegram-bot-api');
    const tg = new (TelegramBot.default || TelegramBot)(config.TELEGRAM_TOKEN, { polling: false });
    tg.sendMessage(config.TELEGRAM_OWNER_ID, `❌ *Session Logged Out*\n\n📱 +${sessionId}\n\nUse /addsession to reconnect`, { parse_mode: 'Markdown' });
  } catch (_) {}
}

async function main() {
  await connectDB();

  const existingSessions = listSessions();
  console.log(`📱 Found ${existingSessions.length} existing session(s)`);

  if (existingSessions.length === 0) {
    console.log('No sessions found. Creating owner session...');
    await createSession(
      config.OWNER_NUMBER,
      (code, sessionId, err) => {
        if (err) { console.log('Pairing error:', err); return; }
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`🔑 PAIRING CODE: ${code}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('WhatsApp → Linked Devices → Link with phone number');
        try {
          const TelegramBot = require('node-telegram-bot-api');
          const tg = new (TelegramBot.default || TelegramBot)(config.TELEGRAM_TOKEN, { polling: false });
          tg.sendMessage(config.TELEGRAM_OWNER_ID, `🔑 *PAIRING CODE*\n\n\`${code}\`\n\nWhatsApp → Linked Devices → Link with phone number`, { parse_mode: 'Markdown' });
        } catch (_) {}
      },
      onConnected,
      onDisconnected
    );
  } else {
    for (const sessionId of existingSessions) {
      console.log(`Loading session: ${sessionId}`);
      await createSession(sessionId, null, onConnected, onDisconnected);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  startTelegram(createSession, deleteSession, listSessions);
}

main().catch(console.error);
