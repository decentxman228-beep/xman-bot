const TelegramBot = require('node-telegram-bot-api');
const Bot = TelegramBot.default || TelegramBot;
const config = require('../config');
const { formatUptime } = require('../utils/helpers');

let botInstance = null;
let _createSession, _deleteSession, _listSessions;

function startTelegram(createFn, deleteFn, listFn) {
  if (botInstance) return;
  _createSession = createFn;
  _deleteSession = deleteFn;
  _listSessions = listFn;

  const bot = new Bot(config.TELEGRAM_TOKEN, {
    polling: { interval: 3000, params: { timeout: 10 } }
  });
  botInstance = bot;
  const OWNER = parseInt(config.TELEGRAM_OWNER_ID);

  bot.on('polling_error', (err) => {
    if (!err.message?.includes('409') && err.code !== 'EFATAL') {
      console.error('Telegram error:', err.message);
    }
  });

  const kb = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📊 STATUS', callback_data: 'status' }, { text: '📱 SESSIONS', callback_data: 'sessions' }],
        [{ text: '➕ ADD SESSION', callback_data: 'addsession' }, { text: '🗑️ DEL SESSION', callback_data: 'delsession' }],
        [{ text: '🔄 RESTART', callback_data: 'restart' }, { text: '📁 LOGS', callback_data: 'logs' }],
        [{ text: '👥 GROUPS', callback_data: 'groups' }, { text: '👑 OWNER', callback_data: 'owner' }],
      ]
    }
  };

  bot.onText(/\/start/, msg => {
    if (msg.chat.id !== OWNER) return bot.sendMessage(msg.chat.id, '❌ Unauthorized');
    bot.sendMessage(msg.chat.id,
      `╔══════════════════════════════╗\n║      🤖 XMAN𓅂 BOT         ║\n╚══════════════════════════════╝\n\n👋 Hello, 𝔹𝕃𝔸ℂ𝕂 𝔹𝕆𝕐.\n\n🔧 MULTI-SESSION CONTROL PANEL\n\n📋 COMMANDS:\n/addsession <number> — Add WhatsApp session\n/delsession <number> — Remove session\n/sessions — List all sessions\n/status — Bot status\n/restart — Restart bot\n/logs — View logs\n\n> XMAN𓅂 ${config.VERSION}`,
      kb
    );
  });

  bot.onText(/\/addsession (.+)/, async (msg, match) => {
    if (msg.chat.id !== OWNER) return bot.sendMessage(msg.chat.id, '❌ Unauthorized');
    const number = match[1].replace(/[^0-9]/g, '');
    bot.sendMessage(msg.chat.id, `⏳ Creating session for *+${number}*...`, { parse_mode: 'Markdown' });
    try {
      await _createSession(number,
        (code, sid, err) => {
          if (err) { bot.sendMessage(msg.chat.id, `❌ Pairing failed: ${err}`); return; }
          bot.sendMessage(msg.chat.id, `✅ *Pairing Code for +${number}:*\n\n\`${code}\`\n\n📱 WhatsApp → Linked Devices → Link with phone number\n\n⏰ Expires in ~60 seconds!`, { parse_mode: 'Markdown' });
        },
        (sock, sid) => { bot.sendMessage(msg.chat.id, `✅ *+${number} Connected!*\n👤 ${sock.user?.id}`, { parse_mode: 'Markdown' }); },
        (sid) => { bot.sendMessage(msg.chat.id, `❌ +${number} was logged out`, { parse_mode: 'Markdown' }); }
      );
    } catch (e) { bot.sendMessage(msg.chat.id, `❌ Error: ${e.message}`); }
  });

  bot.onText(/\/pair (.+)/, async (msg, match) => {
    if (msg.chat.id !== OWNER) return bot.sendMessage(msg.chat.id, '❌ Unauthorized');
    const number = match[1].replace(/[^0-9]/g, '');
    bot.sendMessage(msg.chat.id, `⏳ Generating code for *+${number}*...`, { parse_mode: 'Markdown' });
    try {
      await _createSession(number,
        (code, sid, err) => {
          if (err) { bot.sendMessage(msg.chat.id, `❌ ${err}`); return; }
          bot.sendMessage(msg.chat.id, `✅ *Pairing Code:*\n\n\`${code}\`\n\nWhatsApp → Linked Devices → Link with phone number`, { parse_mode: 'Markdown' });
        },
        (sock) => { bot.sendMessage(msg.chat.id, `✅ Connected as ${sock.user?.id}`); },
        () => { bot.sendMessage(msg.chat.id, `❌ Session logged out`); }
      );
    } catch (e) { bot.sendMessage(msg.chat.id, `❌ Error: ${e.message}`); }
  });

  bot.onText(/\/delsession (.+)/, (msg, match) => {
    if (msg.chat.id !== OWNER) return bot.sendMessage(msg.chat.id, '❌ Unauthorized');
    const number = match[1].replace(/[^0-9]/g, '');
    _deleteSession(number);
    bot.sendMessage(msg.chat.id, `✅ Session *+${number}* deleted`, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/sessions/, msg => {
    if (msg.chat.id !== OWNER) return bot.sendMessage(msg.chat.id, '❌ Unauthorized');
    const s = _listSessions();
    bot.sendMessage(msg.chat.id, `📱 *Sessions (${s.length}):*\n${s.map(x=>`• +${x}`).join('\n')||'None'}`, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/status/, msg => {
    if (msg.chat.id !== OWNER) return bot.sendMessage(msg.chat.id, '❌ Unauthorized');
    const s = _listSessions();
    bot.sendMessage(msg.chat.id, `📊 *Status*\n\n📱 Sessions: ${s.length}\n⏱️ Uptime: ${formatUptime(Date.now()-global.BOT_START)}\n🏃 Memory: ${(process.memoryUsage().heapUsed/1024/1024).toFixed(2)} MB\n📦 ${config.VERSION}`, { parse_mode: 'Markdown', ...kb });
  });

  bot.onText(/\/restart/, msg => {
    if (msg.chat.id !== OWNER) return bot.sendMessage(msg.chat.id, '❌ Unauthorized');
    bot.sendMessage(msg.chat.id, '🔄 Restarting...');
    setTimeout(() => process.exit(0), 1000);
  });

  bot.onText(/\/logs/, msg => {
    if (msg.chat.id !== OWNER) return bot.sendMessage(msg.chat.id, '❌ Unauthorized');
    bot.sendMessage(msg.chat.id, `📁 *Logs*\n\nUptime: ${formatUptime(Date.now()-global.BOT_START)}\nMemory: ${(process.memoryUsage().heapUsed/1024/1024).toFixed(2)} MB\nSessions: ${_listSessions().length}`, { parse_mode: 'Markdown' });
  });

  bot.on('callback_query', async query => {
    const chatId = query.message.chat.id;
    if (chatId !== OWNER) return bot.answerCallbackQuery(query.id, { text: '❌ Unauthorized' });
    try {
      const sessions = _listSessions();
      let text2 = '';
      switch (query.data) {
        case 'status': text2=`📊 *Status*\n\n📱 Sessions: ${sessions.length}\n⏱️ Uptime: ${formatUptime(Date.now()-global.BOT_START)}\n💾 Memory: ${(process.memoryUsage().heapUsed/1024/1024).toFixed(2)} MB\n📦 ${config.VERSION}`; break;
        case 'sessions': text2=`📱 *Sessions (${sessions.length}):*\n${sessions.map(s=>`• +${s}`).join('\n')||'No sessions'}`; break;
        case 'addsession': text2=`➕ *Add Session*\n\nSend:\n/addsession <phone_number>\n\nExample:\n/addsession 2348012345678`; break;
        case 'delsession': text2=`🗑️ *Delete Session*\n\nSend:\n/delsession <phone_number>\n\nActive:\n${sessions.map(s=>`• +${s}`).join('\n')||'None'}`; break;
        case 'restart': await bot.editMessageText('🔄 Restarting...', { chat_id: chatId, message_id: query.message.message_id }); setTimeout(()=>process.exit(0),1000); return;
        case 'logs': text2=`📁 *Logs*\n\nUptime: ${formatUptime(Date.now()-global.BOT_START)}\nMemory: ${(process.memoryUsage().heapUsed/1024/1024).toFixed(2)} MB`; break;
        case 'owner': text2=`👑 *Owner*\n\n📱 ${config.OWNER_NUMBER}\n📦 ${config.VERSION}\n🤖 ${config.BOT_NAME}`; break;
        case 'groups': text2=`👥 *Groups*\n\nUse /sessions to see active sessions`; break;
        default: text2='Unknown action';
      }
      await bot.editMessageText(text2, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown', ...kb });
    } catch (e) { /* ignore */ }
    bot.answerCallbackQuery(query.id);
  });

  console.log('✅ Telegram panel started');
  return bot;
}

module.exports = { startTelegram };
