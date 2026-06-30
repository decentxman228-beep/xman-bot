const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const { getGroup } = require('./db');
const { handleMessage } = require('./handlers/message');
const config = require('./config');

const sessions = new Map();

async function autoJoinChannel(sock) {
  try {
    await sock.newsletterFollow(config.CHANNEL_ID);
    console.log('✅ Auto-joined WhatsApp channel');
  } catch (e) {
    console.log('Channel join note:', e.message);
  }
}

async function sendOwnerWelcome(sock, sessionId) {
  try {
    const ownerJid = `${config.OWNER_NUMBER}@s.whatsapp.net`;
    await sock.sendMessage(ownerJid, {
      text:
        `╭───〔 *ULTRA 𝖝𝖒𝖆𝖓𓅂 CONNECTED* 〕──────┈⊷\n` +
        `│\n` +
        `│ ✅ *Bot is now online!*\n` +
        `│ 📱 Session: +${sessionId}\n` +
        `│ 📦 Version: ${config.VERSION}\n` +
        `│ ⚡ Prefix: ${config.PREFIX}\n` +
        `│ ⚙️ Mode: ${config.MODE}\n` +
        `│\n` +
        `│ Send *.menu* to get started!\n` +
        `│\n` +
        `╰─────────────────────┈⊷\n\n` +
        `> 📢 *JOIN OUR CHANNEL*\n> ${config.CHANNEL_LINK}`
    });
  } catch (_) {}
}

async function handleListResponse(sock, msg, sessionId) {
  try {
    const jid = msg.key.remoteJid;
    const listResponse = msg.message?.listResponseMessage;
    if (!listResponse) return;

    const selectedId = listResponse.singleSelectReply?.selectedRowId;
    if (!selectedId) return;

    console.log(`[LIST RESPONSE] session:${sessionId} id:${selectedId}`);

    const { getMainMenu, getCategoryMenu, TOTAL_COMMANDS } = require('./commands/menu');
    const { sendListMenu, sendCategoryList, sendCommandInfo } = require('./utils/buttons');
    const { formatUptime } = require('./utils/helpers');
    const channelFooter = `\n\n> 📢 *JOIN OUR CHANNEL*\n> ${config.CHANNEL_LINK}`;

    if (selectedId === 'nav_back_menu') {
      const pushName = msg.pushName || jid.split('@')[0];
      const uptime = formatUptime(Date.now() - (global.BOT_START || Date.now()));
      const sent = await sendListMenu(sock, jid, msg, pushName, uptime, TOTAL_COMMANDS);
      if (!sent) {
        await sock.sendMessage(jid, {
          text: getMainMenu(pushName, TOTAL_COMMANDS, uptime) + channelFooter
        }, { quoted: msg });
      }
      return;
    }

    if (selectedId.startsWith('menu_cat_')) {
      const catNum = parseInt(selectedId.replace('menu_cat_', ''));
      const sent = await sendCategoryList(sock, jid, msg, catNum);
      if (!sent) {
        const catMenu = getCategoryMenu(catNum);
        if (catMenu) await sock.sendMessage(jid, { text: catMenu + channelFooter }, { quoted: msg });
      }
      return;
    }

    if (selectedId.startsWith('cmd_info_')) {
      const cmdName = selectedId.replace('cmd_info_', '');
      await sendCommandInfo(sock, jid, msg, cmdName);
      return;
    }
  } catch (e) {
    console.error(`[${sessionId}] List response error:`, e.message);
  }
}

async function createSession(sessionId, onPairingCode, onConnected, onDisconnected) {
  const sessionDir = path.join(__dirname, 'sessions', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    generateHighQualityLinkPreview: true,
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
    retryRequestDelayMs: 2000,
  });

  sessions.set(sessionId, sock);
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      console.log(`✅ Session [${sessionId}] connected as ${sock.user.id}`);
      setTimeout(() => autoJoinChannel(sock), 3000);
      setTimeout(() => sendOwnerWelcome(sock, sessionId), 5000);
      if (onConnected) onConnected(sock, sessionId);
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect =
        statusCode !== DisconnectReason.loggedOut &&
        statusCode !== DisconnectReason.forbidden;

      console.log(`Session [${sessionId}] closed. Code: ${statusCode} | Reconnect: ${shouldReconnect}`);
      sessions.delete(sessionId);

      if (shouldReconnect) {
        console.log(`Reconnecting [${sessionId}] in 5s...`);
        setTimeout(() => createSession(sessionId, null, onConnected, onDisconnected), 5000);
      } else {
        console.log(`Session [${sessionId}] permanently logged out`);
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
        if (onDisconnected) onDisconnected(sessionId);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message) continue;

      if (msg.message.listResponseMessage) {
        await handleListResponse(sock, msg, sessionId);
        continue;
      }

      if (msg.message.buttonsResponseMessage) {
        console.log('[BUTTON RESPONSE]', msg.message.buttonsResponseMessage?.selectedButtonId);
        continue;
      }

      try { await handleMessage(sock, msg, sessionId); }
      catch (e) { console.error(`[${sessionId}] Message error:`, e.message); }
    }
  });

  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    try {
      const groupDoc = await getGroup(id);
      const meta = await sock.groupMetadata(id);
      for (let p of participants) {
        if (typeof p === 'object') p = p.id || p.jid || '';
        if (!p || typeof p !== 'string') continue;
        const num = p.split('@')[0];
        if (action === 'add' && groupDoc.welcome) {
          const wMsg = groupDoc.welcomeMsg ||
            `╭───〔 *WELCOME* 〕──────┈⊷\n│👋 Welcome @${num}!\n│📛 Group: ${meta.subject}\n│👥 Members: ${meta.participants.length}\n╰─────────────────────┈⊷\n\n> 📢 ${config.CHANNEL_LINK}`;
          await sock.sendMessage(id, { text: wMsg, mentions: [p] });
        }
        if (action === 'remove' && groupDoc.goodbye) {
          const gMsg = groupDoc.goodbyeMsg || `👋 *Goodbye @${num}!*\nWe'll miss you in *${meta.subject}* 🌟`;
          await sock.sendMessage(id, { text: gMsg, mentions: [p] });
        }
        if (action === 'add' && groupDoc.autokickList?.includes(p)) {
          await sock.groupParticipantsUpdate(id, [p], 'remove');
        }
      }
    } catch (e) { console.error(`[${sessionId}] Group update error:`, e.message); }
  });

  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    try {
      const groupDoc = await getGroup(id);
      if (action === 'demote' && groupDoc.antidemote) {
        for (let p of participants) {
          if (typeof p === 'object') p = p.id || p.jid || '';
          if (!p) continue;
          await sock.groupParticipantsUpdate(id, [p], 'promote');
          await sock.sendMessage(id, { text: `🛡️ Anti-demote: @${p.split('@')[0]} re-promoted!`, mentions: [p] });
        }
      }
      if (action === 'promote' && groupDoc.antipromote) {
        const meta2 = await sock.groupMetadata(id);
        const botAdmin = meta2.participants.find(
          x => jidNormalizedUser(x.id) === jidNormalizedUser(sock.user.id)
        )?.admin;
        if (botAdmin) {
          for (let p of participants) {
            if (typeof p === 'object') p = p.id || p.jid || '';
            if (!p) continue;
            await sock.groupParticipantsUpdate(id, [p], 'demote');
            await sock.sendMessage(id, { text: `🛡️ Anti-promote: @${p.split('@')[0]} demoted!`, mentions: [p] });
          }
        }
      }
    } catch (e) { console.error(`[${sessionId}] Anti-demote/promote error:`, e.message); }
  });

  if (!state.creds.registered) {
    const phoneNumber = sessionId.replace(/[^0-9]/g, '');
    if (phoneNumber) {
      await new Promise(resolve => {
        const check = setInterval(() => {
          if (sock.ws?.readyState === 1) { clearInterval(check); resolve(); }
        }, 500);
        setTimeout(() => { clearInterval(check); resolve(); }, 8000);
      });
      await new Promise(r => setTimeout(r, 2000));
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        console.log(`\n🔑 [${sessionId}] PAIRING CODE: ${code}\n`);
        if (onPairingCode) onPairingCode(code, sessionId, null);
      } catch (e) {
        console.log(`Pairing error [${sessionId}]:`, e.message);
        if (onPairingCode) onPairingCode(null, sessionId, e.message);
      }
    }
  }

  return sock;
}

function getSession(sessionId) { return sessions.get(sessionId); }
function getAllSessions() { return sessions; }
function deleteSession(sessionId) {
  const sessionDir = path.join(__dirname, 'sessions', sessionId);
  sessions.delete(sessionId);
  try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
}
function listSessions() {
  const sessionsDir = path.join(__dirname, 'sessions');
  if (!fs.existsSync(sessionsDir)) return [];
  return fs.readdirSync(sessionsDir).filter(f =>
    fs.statSync(path.join(sessionsDir, f)).isDirectory()
  );
}

module.exports = { createSession, getSession, getAllSessions, deleteSession, listSessions };
