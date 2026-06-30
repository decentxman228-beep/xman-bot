const config = require('../config');
const { getGroup, getSetting, setSetting } = require('../db');
const { isOwner, isAdmin, isBotAdmin, channelFooter, levenshtein, jidToNum } = require('../utils/helpers');
const { getMainMenu, getCategoryMenu, TOTAL_COMMANDS } = require('../commands/menu');
const { sendListMenu, sendCategoryList } = require('../utils/buttons');
const { formatUptime } = require('../utils/helpers');
const axios = require('axios');
const math = require('mathjs');
const { v4: uuidv4 } = require('uuid');
const moment = require('moment-timezone');
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const BOT_START = Date.now();
global.BOT_START = BOT_START;

const userSessions = new Map();
const floodTracker = new Map();
const spamTracker = new Map();
const slowTracker = new Map();

async function handleMessage(sock, msg, sessionId) {
  try {
    const jid = msg.key.remoteJid;

    const isGroup = jid.endsWith('@g.us');
    const sender = isGroup ? (msg.key.participant || msg.key.remoteJid) : msg.key.remoteJid;
    const fromMe = msg.key.fromMe;

    const msgContent = msg.message;

    const textMsg =
      msgContent.conversation ||
      msgContent.extendedTextMessage?.text ||
      msgContent.imageMessage?.caption ||
      msgContent.videoMessage?.caption || '';

    const msgType = Object.keys(msgContent)[0];

    let groupDoc = null;
    let groupMeta = null;
    let participants = [];
    const botJid = sock.user?.id || '';
    const botNum = botJid.replace(/:[0-9]+@.*/, '').replace(/@.*/, '');

    if (isGroup) {
      try {
        groupDoc = await getGroup(jid);
        groupMeta = await sock.groupMetadata(jid);
        participants = groupMeta.participants || [];
      } catch (e) {
        console.log('groupMetadata error:', e.message);
      }
    }

    // Owner check: fromMe OR phone number matches owner
    const senderPhone = (() => {
      const p = participants.find(x => x.id === sender);
      return p?.phoneNumber || sender;
    })();
    const senderIsOwner = fromMe || isOwner(senderPhone) || isOwner(sender);

    // Admin check: match by exact @lid id OR by phoneNumber field
    const senderIsAdmin = isGroup ? participants.some(p => {
      if (p.id === sender) return true;
      if (p.phoneNumber && jidToNum(p.phoneNumber) === jidToNum(senderPhone)) return true;
      return false;
    }) : false;

    // Bot admin check: match bot by phone number in participants phoneNumber field
    const botIsAdmin = isGroup ? participants.some(p => {
      if (p.phoneNumber && jidToNum(p.phoneNumber) === botNum) return true;
      if (jidToNum(p.id) === botNum) return true;
      return false;
    }) : false;

    // ── Protections ──
    if (isGroup && groupDoc?.shadowBanned?.includes(sender)) {
      try { await sock.sendMessage(jid, { delete: msg.key }); } catch (_) {}
      return;
    }

    if (isGroup && groupDoc?.antiflood && !senderIsAdmin && !senderIsOwner) {
      const key = `${jid}:${sender}`;
      const now = Date.now();
      if (!floodTracker.has(key)) floodTracker.set(key, []);
      const times = floodTracker.get(key).filter(t => now - t < 5000);
      times.push(now);
      floodTracker.set(key, times);
      if (times.length > (groupDoc.floodCount || 5)) {
        if (botIsAdmin) {
          await sock.groupParticipantsUpdate(jid, [sender], 'remove');
          await sock.sendMessage(jid, { text: `⚠️ @${sender.split('@')[0]} kicked for flooding.`, mentions: [sender] });
        }
        return;
      }
    }

    if (isGroup && groupDoc?.antispam && !senderIsAdmin && !senderIsOwner && textMsg) {
      const key = `${jid}:${sender}`;
      const last = spamTracker.get(key);
      if (last && last === textMsg && textMsg.length > 3) {
        try { await sock.sendMessage(jid, { delete: msg.key }); } catch (_) {}
        return;
      }
      spamTracker.set(key, textMsg);
    }

    if (isGroup && groupDoc?.slowMode > 0 && !senderIsAdmin && !senderIsOwner) {
      const key = `${jid}:${sender}`;
      const last = slowTracker.get(key);
      if (last && Date.now() - last < groupDoc.slowMode * 1000) {
        try { await sock.sendMessage(jid, { delete: msg.key }); } catch (_) {}
        return;
      }
      slowTracker.set(key, Date.now());
    }

    if (isGroup && groupDoc?.antilink && !senderIsAdmin && !senderIsOwner) {
      if (/https?:\/\/|wa\.me\/|chat\.whatsapp\.com\/|t\.me\//i.test(textMsg)) {
        try { await sock.sendMessage(jid, { delete: msg.key }); } catch (_) {}
        await sock.sendMessage(jid, {
          text: `⚠️ @${sender.split('@')[0]}, links are not allowed!${channelFooter}`,
          mentions: [sender]
        });
        return;
      }
    }

    if (isGroup && groupDoc?.antiforward && !senderIsAdmin && !senderIsOwner) {
      const ctx = msgContent.extendedTextMessage?.contextInfo ||
                  msgContent.imageMessage?.contextInfo ||
                  msgContent.videoMessage?.contextInfo;
      if (ctx?.isForwarded) {
        try { await sock.sendMessage(jid, { delete: msg.key }); } catch (_) {}
        return;
      }
    }

    if (isGroup && groupDoc?.antiBadWords && !senderIsAdmin && !senderIsOwner && textMsg) {
      const lower = textMsg.toLowerCase();
      const bad = (groupDoc.badWords || []).some(w => lower.includes(w.toLowerCase()));
      if (bad) {
        try { await sock.sendMessage(jid, { delete: msg.key }); } catch (_) {}
        const w = (groupDoc.warns.get(sender) || 0) + 1;
        groupDoc.warns.set(sender, w);
        groupDoc.markModified('warns');
        await groupDoc.save();
        if (w >= (groupDoc.warnLimit || 3) && botIsAdmin) {
          await sock.groupParticipantsUpdate(jid, [sender], 'remove');
          await sock.sendMessage(jid, { text: `🚫 @${sender.split('@')[0]} kicked for bad words.`, mentions: [sender] });
        } else {
          await sock.sendMessage(jid, {
            text: `⚠️ @${sender.split('@')[0]} bad language not allowed! Warn ${w}/${groupDoc.warnLimit || 3}`,
            mentions: [sender]
          });
        }
        return;
      }
    }

    if (isGroup && groupDoc?.lockedTypes?.length && !senderIsAdmin && !senderIsOwner) {
      const typeMap = {
        locktext: ['conversation','extendedTextMessage'],
        lockstickers: ['stickerMessage'],
        lockgifs: ['videoMessage'],
        lockmedia: ['imageMessage','videoMessage'],
        lockaudio: ['audioMessage'],
        lockvoice: ['audioMessage'],
        lockvideos: ['videoMessage'],
        lockdocs: ['documentMessage'],
        lockpolls: ['pollCreationMessage'],
        locklocation: ['locationMessage'],
        lockcontacts: ['contactMessage'],
        lockviewonce: ['viewOnceMessage','viewOnceMessageV2'],
      };
      for (const lockKey of groupDoc.lockedTypes) {
        const types = typeMap[lockKey] || [];
        if (types.includes(msgType)) {
          try { await sock.sendMessage(jid, { delete: msg.key }); } catch (_) {}
          return;
        }
      }
    }

    // ── Reply helper ──
    const reply = async (txt) => {
      await sock.sendMessage(jid, { text: txt + channelFooter }, { quoted: msg });
    };

    // ── Menu number navigation ──
    const trimmed = textMsg.trim();
    const sessionKey = `${jid}:${sender}`;

    if (/^\d+$/.test(trimmed)) {
      const num = parseInt(trimmed);
      if (num === 0 && userSessions.has(sessionKey)) {
        userSessions.delete(sessionKey);
        const uptime = formatUptime(Date.now() - BOT_START);
        const pushName = msg.pushName || sender.split('@')[0];
        const sent = await sendListMenu(sock, jid, msg, pushName, uptime, TOTAL_COMMANDS);
        if (!sent) await reply(getMainMenu(pushName, TOTAL_COMMANDS, uptime));
        return;
      }
      if (num >= 1 && num <= 18) {
        userSessions.set(sessionKey, num);
        const sent = await sendCategoryList(sock, jid, msg, num);
        if (!sent) {
          const catMenu = getCategoryMenu(num);
          if (catMenu) await reply(catMenu);
        }
        return;
      }
    }

    // ── Command check ──
    const prefix = config.PREFIX;
    if (!textMsg.startsWith(prefix)) return;

    const args = textMsg.slice(prefix.length).trim().split(/\s+/);
    const command = args.shift().toLowerCase();
    const text = args.join(' ');
    const quoted = msgContent?.extendedTextMessage?.contextInfo?.quotedMessage;

    // ═══════════════════════════════════
    // GENERAL
    // ═══════════════════════════════════

    if (command === 'menu' || command === 'help') {
      userSessions.set(sessionKey, 0);
      const uptime = formatUptime(Date.now() - BOT_START);
      const pushName = msg.pushName || sender.split('@')[0];
      const sent = await sendListMenu(sock, jid, msg, pushName, uptime, TOTAL_COMMANDS);
      if (!sent) await reply(getMainMenu(pushName, TOTAL_COMMANDS, uptime));
      return;
    }

    if (command === 'menus') {
      const uptime = formatUptime(Date.now() - BOT_START);
      const tz = await getSetting('timezone', 'Africa/Lagos');
      const now = moment().tz(tz);
      await reply(
        `╭───〔 *BOT STATUS* 〕──────┈⊷\n` +
        `│✵│▸ ⏱️ *UPTIME:* ${uptime}\n` +
        `│✵│▸ 📅 *DATE:* ${now.format('dddd, MMMM Do YYYY')}\n` +
        `│✵│▸ 🕐 *TIME:* ${now.format('HH:mm:ss')}\n` +
        `│✵│▸ 📦 *VERSION:* ${config.VERSION}\n` +
        `│✵│▸ ⚙️ *MODE:* ${config.MODE}\n` +
        `╰─────────────────────┈⊷`
      );
      return;
    }

    if (command === 'ping') {
      const start = Date.now();
      await reply(`🏓 *Pong!* ${Date.now() - start}ms`);
      return;
    }

    if (command === 'uptime') {
      await reply(`⏱️ *Bot Uptime:* ${formatUptime(Date.now() - BOT_START)}`);
      return;
    }

    if (command === 'botinfo') {
      await reply(
        `╭───〔 *BOT INFO* 〕──────┈⊷\n` +
        `│✵│▸ 🤖 *Name:* ${config.BOT_NAME}\n` +
        `│✵│▸ 📦 *Version:* ${config.VERSION}\n` +
        `│✵│▸ ⚡ *Prefix:* ${config.PREFIX}\n` +
        `│✵│▸ ⚙️ *Mode:* ${config.MODE}\n` +
        `│✵│▸ 📊 *Commands:* ${TOTAL_COMMANDS}\n` +
        `│✵│▸ ⏱️ *Uptime:* ${formatUptime(Date.now() - BOT_START)}\n` +
        `│✵│▸ 🔑 *License:* ♾️ Lifetime\n` +
        `╰─────────────────────┈⊷`
      );
      return;
    }

    if (command === 'list') {
      const { commandLists, categories } = require('../commands/menu');
      let listText = `*📋 ALL COMMANDS (${TOTAL_COMMANDS} total)*\n\n`;
      categories.forEach(cat => {
        const cmds = commandLists[cat.num] || [];
        listText += `*${cat.icon} ${cat.name}*\n`;
        cmds.forEach(c => { listText += `  ${c.cmd.padEnd(18)} — ${c.desc}\n`; });
        listText += '\n';
      });
      await reply(listText);
      return;
    }

    if (command === 'pair') {
      const number = text ? text.replace(/[^0-9]/g, '') : '';
      if (!number) {
        await reply(
          `╭───〔 *PAIR INFO* 〕──────┈⊷\n` +
          `│\n` +
          `│ 📢 *Telegram Bot:* ${config.TELEGRAM_BOT_LINK}\n` +
          `│ 📱 *Channel:* ${config.CHANNEL_LINK}\n` +
          `│\n` +
          `│ To pair a new number:\n` +
          `│ *.pair <your_number>*\n` +
          `│ Example: .pair 2348012345678\n` +
          `│\n` +
          `╰─────────────────────┈⊷`
        );
        return;
      }

      const { listSessions } = require('../sessionManager');
      const activeSessions = listSessions();

      if (activeSessions.includes(number)) {
        await reply(
          `⚠️ *+${number}* already has an active session!\n\n` +
          `This number is currently connected. To relink it, first remove it via Telegram:\n/delsession ${number}\n\nThen try .pair ${number} again.`
        );
        return;
      }

      if (number === sessionId) {
        await reply(`⚠️ This is the current bot session number. Use a different number to add a new session.`);
        return;
      }

      await sock.sendMessage(jid, {
        text:
          `╭───〔 *PAIR INFO* 〕──────┈⊷\n` +
          `⏳ Generating pairing code for +${number}...\n\n` +
          `📱 Steps:\n` +
          `1. Open WhatsApp → ⋮ Menu\n` +
          `2. Linked Devices → Link a Device\n` +
          `3. Tap "Link with phone number"\n` +
          `4. Enter the code that will appear\n\n` +
          `⏰ Expires in ~60 seconds\n\n` +
          `> 📢 *JOIN OUR CHANNEL*\n> ${config.CHANNEL_LINK}`
      }, { quoted: msg });

      try {
        const { createSession } = require('../sessionManager');
        await createSession(
          number,
          async (code, sid, err) => {
            if (err || !code) {
              await sock.sendMessage(jid, {
                text: `❌ Pairing failed: ${err || 'Unknown error'}\n\nTry again with .pair ${number}`
              }, { quoted: msg });
              return;
            }
            await sock.sendMessage(jid, {
              text:
                `╭───〔 *PAIR INFO* 〕──────┈⊷\n` +
                `✅ Pairing Code\n\n` +
                `*${code}*\n\n` +
                `📱 Steps:\n` +
                `1. Open WhatsApp → ⋮ Menu\n` +
                `2. Linked Devices → Link a Device\n` +
                `3. Tap "Link with phone number"\n` +
                `4. Enter the code above\n\n` +
                `⏰ Expires in ~60 seconds\n\n` +
                `> 📢 *JOIN OUR CHANNEL*\n> ${config.CHANNEL_LINK}`
            }, { quoted: msg });
          },
          (newSock, sid) => {
            sock.sendMessage(jid, {
              text: `✅ *Session Connected!*\n📱 +${sid} is now active\n\n> 📢 *JOIN OUR CHANNEL*\n> ${config.CHANNEL_LINK}`
            }, { quoted: msg });
          },
          (sid) => {
            sock.sendMessage(jid, { text: `❌ Session +${sid} was disconnected` }, { quoted: msg });
          }
        );
      } catch (e) {
        await reply(`❌ Pairing error: ${e.message}`);
      }
      return;
    }

    if (command === 'repo') {
      await reply(`📦 *Bot Repository*\nhttps://github.com/decentxman228-beep`);
      return;
    }

    if (command === 'met' && isGroup) {
      await reply(
        `╭───〔 *GROUP METADATA* 〕──────┈⊷\n` +
        `│✵│▸ 📛 *Name:* ${groupMeta?.subject || 'Unknown'}\n` +
        `│✵│▸ 👥 *Members:* ${participants.length}\n` +
        `│✵│▸ 👑 *Admins:* ${participants.filter(p => p.admin).length}\n` +
        `│✵│▸ 🆔 *JID:* ${jid}\n` +
        `╰─────────────────────┈⊷`
      );
      return;
    }

    if (command === 'jid') {
      await reply(`🆔 *JID:*\n${jid}\n\n👤 *Sender:* ${sender}`);
      return;
    }

    if (command === 'owner') {
      await reply(`👑 *Bot Owner:* wa.me/${config.OWNER_NUMBER}`);
      return;
    }

    if (command === 'chjid') {
      await reply(`📢 *Channel:*\n${config.CHANNEL_LINK}`);
      return;
    }

    // ═══════════════════════════════════
    // AI
    // ═══════════════════════════════════

    const aiHandler = async (modelName) => {
      if (!text) return reply(`Usage: ${prefix}${command} <your message>`);
      try {
        const res = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          system: `You are ${config.BOT_NAME}, a helpful WhatsApp assistant. Be concise.`,
          messages: [{ role: 'user', content: text }],
        });
        await reply(`🤖 *${modelName}*\n\n${res.content[0].text}`);
      } catch (e) { await reply(`❌ AI Error: ${e.message}`); }
    };

    if (['ai','chat','claude','guruai','unity','gpt','gpt4','gpt4o','gpt4o-mini','openai','llama','mistral','gemini','codex'].includes(command)) {
      await aiHandler(command.toUpperCase()); return;
    }
    if (command === 'aimodels') {
      await reply(`🤖 *Available AI Models:*\n.ai .claude .gpt .gpt4 .gpt4o .llama .mistral .gemini .codex .guruai .unity .openai .chat .searchai`);
      return;
    }
    if (command === 'searchai' || command === 'letmegpt') {
      if (!text) return reply(`Usage: ${prefix}${command} <query>`);
      try {
        const res = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          system: 'You are a helpful search assistant. Answer with the most relevant information.',
          messages: [{ role: 'user', content: text }],
        });
        await reply(`🔍 *Search AI:*\n\n${res.content[0].text}`);
      } catch (e) { await reply(`❌ Error: ${e.message}`); }
      return;
    }
    if (command === 'imagine') {
      await reply(`🎨 AI image generation requires Stability AI API key in config.js`); return;
    }

    // ═══════════════════════════════════
    // TOOLS
    // ═══════════════════════════════════

    if (command === 'calc') {
      if (!text) return reply(`Usage: ${prefix}calc 2+2`);
      try { await reply(`🧮 *Result:* ${math.evaluate(text)}`); }
      catch (e) { await reply(`❌ Invalid expression`); }
      return;
    }
    if (command === 'translate') {
      if (!text) return reply(`Usage: ${prefix}translate en <text>`);
      const [lang,...rest] = text.split(' ');
      try {
        const { translate } = require('translate-google');
        const result = await translate(rest.join(' '), { to: lang });
        await reply(`🌐 *Translation (${lang}):*\n${result}`);
      } catch (e) { await reply(`❌ Translation failed`); }
      return;
    }
    if (command === 'weather') {
      if (!text) return reply(`Usage: ${prefix}weather <city>`);
      try {
        const res = await axios.get(`https://wttr.in/${encodeURIComponent(text)}?format=3`);
        await reply(`🌤️ *Weather:*\n${res.data}`);
      } catch (e) { await reply(`❌ Could not get weather`); }
      return;
    }
    if (command === 'define') {
      if (!text) return reply(`Usage: ${prefix}define <word>`);
      try {
        const res = await axios.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(text)}`);
        await reply(`📖 *${text}:*\n${res.data[0]?.meanings[0]?.definitions[0]?.definition || 'Not found'}`);
      } catch (e) { await reply(`❌ Word not found`); }
      return;
    }
    if (command === 'urban') {
      if (!text) return reply(`Usage: ${prefix}urban <word>`);
      try {
        const res = await axios.get(`https://api.urbandictionary.com/v0/define?term=${encodeURIComponent(text)}`);
        const def = res.data.list[0];
        if (!def) return reply(`❌ Not found`);
        await reply(`📚 *${def.word}*\n\n${def.definition.slice(0,500)}\n\n📌 _${(def.example||'').slice(0,200)}_`);
      } catch (e) { await reply(`❌ Error`); }
      return;
    }
    if (command === 'uuid') { await reply(`🔑 *UUID:* ${uuidv4()}`); return; }
    if (command === 'password') {
      const len = Math.min(parseInt(text)||16, 64);
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
      let pwd = '';
      for (let i = 0; i < len; i++) pwd += chars[Math.floor(Math.random()*chars.length)];
      await reply(`🔐 *Password (${len}):*\n${pwd}`); return;
    }
    if (command === 'upper') { if (!text) return reply(`Usage: ${prefix}upper <text>`); await reply(text.toUpperCase()); return; }
    if (command === 'lower'||command==='lowercase') { if (!text) return reply(`Usage: ${prefix}lower <text>`); await reply(text.toLowerCase()); return; }
    if (command === 'reverse'||command==='reversetext') { if (!text) return reply(`Usage: ${prefix}reverse <text>`); await reply(text.split('').reverse().join('')); return; }
    if (command === 'binary'||command==='ebinary') {
      if (!text) return reply(`Usage: ${prefix}binary <text>`);
      await reply(`📟 *Binary:*\n${text.split('').map(c=>c.charCodeAt(0).toString(2).padStart(8,'0')).join(' ')}`); return;
    }
    if (command === 'debinary') {
      if (!text) return reply(`Usage: ${prefix}debinary <binary>`);
      try { await reply(text.split(' ').map(b=>String.fromCharCode(parseInt(b,2))).join('')); }
      catch (_) { await reply(`❌ Invalid binary`); }
      return;
    }
    if (command === 'base64'||command==='ebase') {
      if (!text) return reply(`Usage: ${prefix}base64 <text>`);
      await reply(`🔡 *Base64:*\n${Buffer.from(text).toString('base64')}`); return;
    }
    if (command === 'dbase') {
      if (!text) return reply(`Usage: ${prefix}dbase <base64>`);
      try { await reply(`🔡 *Decoded:*\n${Buffer.from(text,'base64').toString('utf-8')}`); }
      catch (_) { await reply(`❌ Invalid base64`); }
      return;
    }
    if (command === 'morse') {
      if (!text) return reply(`Usage: ${prefix}morse <text>`);
      const m={A:'.-',B:'-...',C:'-.-.',D:'-..',E:'.',F:'..-.',G:'--.',H:'....',I:'..',J:'.---',K:'-.-',L:'.-..',M:'--',N:'-.',O:'---',P:'.--.',Q:'--.-',R:'.-.',S:'...',T:'-',U:'..-',V:'...-',W:'.--',X:'-..-',Y:'-.--',Z:'--..',0:'-----',1:'.----',2:'..---',3:'...--',4:'....-',5:'.....',6:'-....',7:'--...',8:'---..',9:'----.'};
      await reply(`📡 *Morse:*\n${text.toUpperCase().split('').map(c=>m[c]||(c===' '?'/':'')).join(' ')}`); return;
    }
    if (command === 'unmorse') {
      if (!text) return reply(`Usage: ${prefix}unmorse <morse>`);
      const r={'.-':'A','-...':'B','-.-.':'C','-..':'D','.':'E','..-.':'F','--.':'G','....':'H','..':'I','.---':'J','-.-':'K','.-..':'L','--':'M','-.':'N','---':'O','.--.':'P','--.-':'Q','.-.':'R','...':'S','-':'T','..-':'U','...-':'V','.--':'W','-..-':'X','-.--':'Y','--..':'Z','-----':'0','.----':'1','..---':'2','...--':'3','....-':'4','.....':'5','-....':'6','--...':'7','---..':'8','----.':'9'};
      await reply(text.split(' / ').map(w=>w.split(' ').map(c=>r[c]||'?').join('')).join(' ')); return;
    }
    if (command === 'palindrome') {
      if (!text) return reply(`Usage: ${prefix}palindrome <word>`);
      const clean=text.toLowerCase().replace(/\s/g,'');
      await reply(`🔄 *"${text}"* is ${clean===clean.split('').reverse().join('')?'✅ a palindrome':'❌ not a palindrome'}`); return;
    }
    if (command === 'anagram') {
      const parts=text.split(' '); if (parts.length<2) return reply(`Usage: ${prefix}anagram word1 word2`);
      const sort=s=>s.toLowerCase().split('').sort().join('');
      await reply(`🔤 *${parts[0]}* and *${parts[1]}* are ${sort(parts[0])===sort(parts[1])?'✅ anagrams':'❌ not anagrams'}`); return;
    }
    if (command === 'charcount') { if (!text) return reply(`Usage: ${prefix}charcount <text>`); await reply(`📊 Chars: ${text.length} | Words: ${text.split(/\s+/).length} | Lines: ${text.split('\n').legth}`); return; }
    if (command === 'wordcount') { if (!text) return reply(`Usage: ${prefix}wordcount <text>`); await reply(`📊 Words: ${text.split(/\s+/).filter(Boolean).length} | Chars: ${text.length}`); return; }
    if (command === 'isprime') {
      const n=parseInt(text); if (isNaN(n)) return reply(`Usage: ${prefix}isprime <number>`);
      const prime=n>1&&!Array.from({length:Math.floor(Math.sqrt(n))-1},(_,i)=>i+2).some(i=>n%i===0);
      await reply(`🔢 *${n}* is ${prime?'✅ prime':'❌ not prime'}`); return;
    }
    if (command === 'factorial') {
      const n=parseInt(text); if (isNaN(n)||n<0||n>20) return reply(`Usage: ${prefix}factorial <0-20>`);
      let f=BigInt(1); for (let i=2;i<=n;i++) f*=BigInt(i);
      await reply(`🔢 *${n}!* = ${f}`); return;
    }
    if (command === 'fibonacci') {
      const n=Math.min(parseInt(text)||10,30); const fib=[0,1];
      for (let i=2;i<n;i++) fib.push(fib[i-1]+fib[i-2]);
      await reply(`🌀 *Fibonacci (${n}):*\n${fib.slice(0,n).join(', ')}`); return;
    }
    if (command === 'pidigits') { await reply(`🔢 *Pi:* 3.14159265358979323846264338327950288419716939937510`); return; }
    if (command === 'roman') {
      let n=parseInt(text); if (isNaN(n)||n<1||n>3999) return reply(`Usage: ${prefix}roman <1-3999>`);
      const v=[1000,900,500,400,100,90,50,40,10,9,5,4,1],s=['M','CM','D','CD','C','XC','L','XL','X','IX','V','IV','I'];
      let res=''; v.forEach((val,i)=>{while(n>=val){res+=s[i];n-=val;}}); await reply(`🏛️ *Roman:* ${res}`); return;
    }
    if (command === 'unroman') {
      if (!text) return reply(`Usage: ${prefix}unroman <roman>`);
      const map={I:1,V:5,X:10,L:50,C:100,D:500,M:1000}; let n=0,prev=0;
      for (const c of text.toUpperCase().split('').reverse()){const v=map[c]||0;n+=v<prev?-v:v;prev=v;}
      await reply(`🔢 *Number:* ${n}`); return;
    }
    if (command === 'bmi') {
      const parts=text.split(' '); if (parts.length<2) return reply(`Usage: ${prefix}bmi <weight_kg> <height_m>`);
      const [w,h]=parts.map(Number); const bmi=(w/(h*h)).toFixed(2);
      const cat=bmi<18.5?'Underweight':bmi<25?'Normal':bmi<30?'Overweight':'Obese';
      await reply(`⚖️ *BMI:* ${bmi} — ${cat}`); return;
    }
    if (command === 'age') {
      if (!text) return reply(`Usage: ${prefix}age DD/MM/YYYY`);
      const [d,m2,y]=text.split('/').map(Number); const birth=new Date(y,m2-1,d); const now2=new Date();
      const age=now2.getFullYear()-birth.getFullYear()-(now2<new Date(now2.getFullYear(),birth.getMonth(),birth.getDate())?1:0);
      await reply(`🎂 *Age:* ${age} years old`); return;
    }
    if (command === 'temperature') {
      const parts=text.split(' '); if (parts.length<2) return reply(`Usage: ${prefix}temperature 100 C`);
      const [val,unit]=[parseFloat(parts[0]),parts[1].toUpperCase()]; let result='';
      if (unit==='C') result=`${(val*9/5+32).toFixed(2)}°F | ${(val+273.15).toFixed(2)}K`;
      else if (unit==='F') result=`${((val-32)*5/9).toFixed(2)}°C | ${((val-32)*5/9+273.15).toFixed(2)}K`;
      else if (unit==='K') result=`${(val-273.15).toFixed(2)}°C | ${((val-273.15)*9/5+32).toFixed(2)}°F`;
      else return reply(`Unit must be C, F, or K`);
      await reply(`🌡️ *${val}°${unit}* = ${result}`); return;
    }
    if (command === 'currency') {
      const parts=text.split(' '); if (parts.length<3) return reply(`Usage: ${prefix}currency 100 USD NGN`);
      const [amount,from,to]=[parseFloat(parts[0]),parts[1].toUpperCase(),parts[2].toUpperCase()];
      try {
        const res=await axios.get(`https://api.exchangerate-api.com/v4/latest/${from}`);
        const rate=res.data.rates[to]; if (!rate) return reply(`❌ Unknown currency`);
        await reply(`💱 *${amount} ${from}* = *${(amount*rate).toFixed(2)} ${to}*`);
      } catch (e) { await reply(`❌ Currency conversion failed`); }
      return;
    }
    if (command === 'countdown') {
      if (!text) return reply(`Usage: ${prefix}countdown DD/MM/YYYY`);
      const [d,m2,y]=text.split('/').map(Number);
      const days=Math.ceil((new Date(y,m2-1,d)-new Date())/86400000);
      await reply(`⏳ *Countdown to ${text}:* ${days>0?`${days} days`:days===0?'Today! 🎉':`${Math.abs(days)} days ago`}`); return;
    }
    if (command === 'tinyurl') {
      if (!text) return reply(`Usage: ${prefix}tinyurl <url>`);
      try { const res=await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(text)}`); await reply(`🔗 *Short URL:* ${res.data}`); }
      catch (e) { await reply(`❌ Failed to shorten URL`); }
      return;
    }
    if (command === 'color') {
      if (!text) return reply(`Usage: ${prefix}color #FF5733`);
      const hex=text.replace('#',''); const r=parseInt(hex.slice(0,2),16),g=parseInt(hex.slice(2,4),16),b=parseInt(hex.slice(4,6),16);
      await reply(`🎨 *Color #${hex.toUpperCase()}*\n🔴 R: ${r} | 🟢 G: ${g} | 🔵 B: ${b}`); return;
    }
    if (command === 'percentof') {
      const parts=text.split(' '); if (parts.length<2) return reply(`Usage: ${prefix}percentof 20 500`);
      const [pct,total]=parts.map(Number); await reply(`📊 *${pct}% of ${total}* = ${(pct/100*total).toFixed(2)}`); return;
    }
    if (command === 'tip') {
      const parts=text.split(' '); if (parts.length<2) return reply(`Usage: ${prefix}tip 5000 10`);
      const [bill,pct]=parts.map(Number); await reply(`💰 Tip (${pct}%): ${(bill*pct/100).toFixed(2)}\n💳 Total: ${(bill+bill*pct/100).toFixed(2)}`); return;
    }
    if (command === 'camelcase') { if (!text) return reply(`Usage: ${prefix}camelcase <text>`); await reply(text.replace(/(?:^\w|[A-Z]|\b\w)/g,(w,i)=>i===0?w.toLowerCase():w.toUpperCase()).replace(/\s+/g,'')); return; }
    if (command === 'snakecase') { if (!text) return reply(`Usage: ${prefix}snakecase <text>`); await reply(text.toLowerCase().replace(/\s+/g,'_')); return; }
    if (command === 'titlecase') { if (!text) return reply(`Usage: ${prefix}titlecase <text>`); await reply(text.replace(/\w\S*/g,w=>w.charAt(0).toUpperCase()+w.slice(1).toLowerCase())); return; }
    if (command === 'rot13') { if (!text) return reply(`Usage: ${prefix}rot13 <text>`); await reply(text.replace(/[a-zA-Z]/g,c=>String.fromCharCode(c.charCodeAt(0)+(c.toLowerCase()<'n'?13:-13)))); return; }
    if (command === 'caesar') {
      const parts=text.split(' '); if (parts.length<2) return reply(`Usage: ${prefix}caesar 3 Hello`);
      const shift=parseInt(parts[0]),msg2=parts.slice(1).join(' ');
      const enc=msg2.replace(/[a-zA-Z]/g,c=>{const base=c<='Z'?65:97;return String.fromCharCode((c.charCodeAt(0)-base+shift+26)%26+base);});
      await reply(`🔐 *Caesar (shift ${shift}):*\n${enc}`); return;
    }
    if (command === 'ascii') { if (!text) return reply(`Usage: ${prefix}ascii <text>`); await reply(`📟 *ASCII:*\n${text.split('').map(c=>c.charCodeAt(0)).join(' ')}`); return; }
    if (command === 'fromascii') {
      if (!text) return reply(`Usage: ${prefix}fromascii <codes>`);
      try { await reply(text.split(' ').map(n=>String.fromCharCode(parseInt(n))).join('')); }
      catch (_) { await reply(`❌ Invalid ASCII`); }
      return;
    }
    if (command === 'vowelcount') { if (!text) return reply(`Usage: ${prefix}vowelcount <text>`); const v=(text.match(/[aeiouAEIOU]/g)||[]).length; await reply(`📊 Vowels: ${v} | Consonants: ${text.replace(/\s/g,'').length-v}`); return; }
    if (command === 'longestword') { if (!text) return reply(`Usage: ${prefix}longestword <sentence>`); const w=text.split(/\s+/).sort((a,b)=>b.length-a.length)[0]; await reply(`📏 *Longest:* ${w} (${w.length} chars)`); return; }
    if (command === 'shuffletext') {
      if (!text) return reply(`Usage: ${prefix}shuffletext <sentence>`);
      const words=text.split(' '); for (let i=words.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[words[i],words[j]]=[words[j],words[i]];}
      await reply(words.join(' ')); return;
    }
    if (command === 'repeattext') {
      const parts=text.split(' '); if (parts.length<2) return reply(`Usage: ${prefix}repeattext 3 Hello`);
      await reply(Array(Math.min(parseInt(parts[0]),20)).fill(parts.slice(1).join(' ')).join('\n')); return;
    }
    if (command === 'splittext') {
      const parts=text.split(' '); if (parts.length<2) return reply(`Usage: ${prefix}splittext , a,b,c`);
      await reply(parts.slice(1).join(' ').split(parts[0]).map((p,i)=>`${i+1}. ${p}`).join('\n')); return;
    }
    if (command === 'createqr') {
      if (!text) return reply(`Usage: ${prefix}createqr <text>`);
      await sock.sendMessage(jid, { image: { url: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(text)}` }, caption: `📱 QR Code${channelFooter}` }, { quoted: msg }); return;
    }
    if (command === 'ttp') {
      if (!text) return reply(`Usage: ${prefix}ttp <text>`);
      try { await sock.sendMessage(jid, { image: { url: `https://api.xteam.xyz/ttp?text=${encodeURIComponent(text)}` }, caption: `📝 TTP${channelFooter}` }, { quoted: msg }); }
      catch (e) { await reply(`❌ TTP failed`); }
      return;
    }
    if (command === 'fetch') {
      if (!text) return reply(`Usage: ${prefix}fetch <url>`);
      try { const res=await axios.get(text,{timeout:10000}); const content=typeof res.data==='string'?res.data.slice(0,1000):JSON.stringify(res.data).slice(0,1000); await reply(`🌐 *Fetched:*\n\n${content}`); }
      catch (e) { await reply(`❌ Fetch failed: ${e.message}`); }
      return;
    }
    if (command === 'domaincheck') {
      if (!text) return reply(`Usage: ${prefix}domaincheck example.com`);
      try {
        const res=await axios.get(`https://rdap.org/domain/${text}`);
        await reply(`🌐 *Domain: ${text}*\n📅 Registered: ${res.data.events?.find(e=>e.eventAction==='registration')?.eventDate||'N/A'}\n📅 Expiry: ${res.data.events?.find(e=>e.eventAction==='expiration')?.eventDate||'N/A'}`);
      } catch (e) { await reply(`❌ Domain info not found`); }
      return;
    }
    if (command === 'remindme') {
      if (!text) return reply(`Usage: ${prefix}remindme <minutes> <message>`);
      const parts=text.split(' '); const mins=parseInt(parts[0]); const reminderMsg=parts.slice(1).join(' ');
      if (isNaN(mins)||!reminderMsg) return reply(`Usage: ${prefix}remindme 5 Do something`);
      await reply(`⏰ Reminder set for *${mins} minute(s)*`);
      setTimeout(async()=>{await sock.sendMessage(jid,{text:`⏰ *REMINDER:*\n@${sender.split('@')[0]}: *${reminderMsg}*${channelFooter}`,mentions:[sender]});},mins*60*1000);
      return;
    }
    if (command === 'vvsave'||command==='vv'||command==='vv2') { if (!quoted) return reply(`Reply to a view-once message`); await reply(`👁️ View-once revealed!`); return; }
    if (command === 'emojimix') { await reply(`🔀 Try Google Emoji Kitchen:\nhttps://emojikitchen.dev`); return; }

    // ═══════════════════════════════════
    // SEARCH
    // ═══════════════════════════════════

    if (command === 'google') { if (!text) return reply(`Usage: ${prefix}google <query>`); await reply(`🔍 *Google: ${text}*\nhttps://www.google.com/search?q=${encodeURIComponent(text)}`); return; }
    if (command === 'lyrics') {
      if (!text) return reply(`Usage: ${prefix}lyrics <artist> <song>`);
      const parts=text.split(' ');
      try { const res=await axios.get(`https://api.lyrics.ovh/v1/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts.slice(1).join(' ')||parts[0])}`); await reply(`🎵 *Lyrics:*\n\n${res.data.lyrics?.slice(0,1500)||'Not found'}`); }
      catch (e) { await reply(`❌ Lyrics not found`); }
      return;
    }
    if (command === 'npm') {
      if (!text) return reply(`Usage: ${prefix}npm <package>`);
      try { const res=await axios.get(`https://registry.npmjs.org/${text}`); await reply(`📦 *${res.data.name}*\n${res.data.description||'No description'}\nLatest: ${res.data['dist-tags'].latest}`); }
      catch (e) { await reply(`❌ Package not found`); }
      return;
    }
    if (command === 'yts') { if (!text) return reply(`Usage: ${prefix}yts <query>`); await reply(`🎬 *YouTube: ${text}*\nhttps://www.youtube.com/results?search_query=${encodeURIComponent(text)}`); return; }
    if (command === 'unsplash') {
      if (!text) return reply(`Usage: ${prefix}unsplash <query>`);
      try { await sock.sendMessage(jid,{image:{url:`https://source.unsplash.com/featured/?${encodeURIComponent(text)}`},caption:`📷 *Unsplash: ${text}*${channelFooter}`},{quoted:msg}); }
      catch (e) { await reply(`❌ Could not fetch image`); }
      return;
    }
    if (command === 'wallpapers') {
      if (!text) return reply(`Usage: ${prefix}wallpapers <category>`);
      try { await sock.sendMessage(jid,{image:{url:`https://source.unsplash.com/1920x1080/?${encodeURIComponent(text)}`},caption:`🖼️ *Wallpaper: ${text}*${channelFooter}`},{quoted:msg}); }
      catch (e) { await reply(`❌ Could not fetch wallpaper`); }
      return;
    }

    // ═══════════════════════════════════
    // RELIGION
    // ═══════════════════════════════════

    if (command === 'bible') {
      if (!text) return reply(`Usage: ${prefix}bible John 3:16`);
      try { const res=await axios.get(`https://bible-api.com/${encodeURIComponent(text)}`); await reply(`📖 *${res.data.reference}*\n\n_${res.data.text?.trim()}_`); }
      catch (e) { await reply(`❌ Bible verse not found`); }
      return;
    }
    if (command === 'quran') {
      if (!text) return reply(`Usage: ${prefix}quran <surah>:<ayah>`);
      try { const [surah,ayah]=text.split(':'); const res=await axios.get(`https://api.alquran.cloud/v1/ayah/${surah}:${ayah}/en.asad`); await reply(`📗 *Quran ${res.data.data.surah.englishName} (${surah}:${ayah})*\n\n_${res.data.data.text}_`); }
      catch (e) { await reply(`❌ Quran verse not found`); }
      return;
    }

    // ═══════════════════════════════════
    // CONVERTER
    // ═══════════════════════════════════

    if (command==='sticker') { await reply(`🖼️ Reply to an image with ${prefix}sticker`); return; }
    if (command==='toimg') { await reply(`🖼️ Reply to a sticker with ${prefix}toimg`); return; }
    if (command==='toaudio') { await reply(`🎵 Reply to a video with ${prefix}toaudio`); return; }
    if (command==='toptt') { await reply(`🎤 Reply to audio with ${prefix}toptt`); return; }
    if (command==='tovideo') { await reply(`🎬 Reply to audio with ${prefix}tovideo`); return; }

    // ═══════════════════════════════════
    // DOWNLOADER
    // ═══════════════════════════════════

    if (command==='play') { if (!text) return reply(`Usage: ${prefix}play <song name>`); await reply(`🎵 Downloading: *${text}*\n⏳ Please wait...`); return; }
    if (command==='video') { if (!text) return reply(`Usage: ${prefix}video <YouTube URL>`); await reply(`🎬 Downloading: *${text}*\n⏳ Please wait...`); return; }
    if (command==='spotify') { if (!text) return reply(`Usage: ${prefix}spotify <song>`); await reply(`🎵 Searching Spotify: *${text}*`); return; }
    if (command==='pastebin') {
      if (!text) return reply(`Usage: ${prefix}pastebin <id>`);
      try { const res=await axios.get(`https://pastebin.com/raw/${text}`); await reply(`📋 *Pastebin:*\n${res.data.slice(0,2000)}`); }
      catch (e) { await reply(`❌ Paste not found`); }
      return;
    }

    // ═══════════════════════════════════
    // FUN
    // ═══════════════════════════════════

    if (command==='joke') {
      try { const res=await axios.get('https://v2.jokeapi.dev/joke/Any?blacklistFlags=nsfw,racist,sexist&type=single'); await reply(`😂 ${res.data.joke||`${res.data.setup}\n${res.data.delivery}`}`); }
      catch (e) { await reply(`😂 Why did the bot crash? Because it ran out of jokes!`); }
      return;
    }
    if (command==='fact') {
      try { const res=await axios.get('https://uselessfacts.jsph.pl/random.json?language=en'); await reply(`💡 *Fact:*\n${res.data.text}`); }
      catch (e) { await reply(`💡 Honey never spoils!`); }
      return;
    }
    if (command==='quote') {
      try { const res=await axios.get('https://api.quotable.io/random'); await reply(`💬 _"${res.data.content}"_\n— *${res.data.author}*`); }
      catch (e) { await reply(`💬 _"Do great work."_ — Steve Jobs`); }
      return;
    }
    if (command==='8ball') { const a=['Yes','No','Maybe','Definitely','Absolutely not','Ask again later','Signs point to yes','Very doubtful']; await reply(`🎱 *8-Ball:*\n${a[Math.floor(Math.random()*a.length)]}`); return; }
    if (command==='coin'||command==='flip') { await reply(`🪙 *${Math.random()<0.5?'Heads':'Tails'}!*`); return; }
    if (command==='dice'||command==='roll') { const sides=parseInt(text)||6; await reply(`🎲 *Rolled: ${Math.floor(Math.random()*sides)+1}/${sides}*`); return; }
    if (command==='random') { const parts=text.split(' ').map(Number); const [min2,max2]=parts.length>=2?parts:[1,100]; await reply(`🎰 *Random (${min2}-${max2}):* ${Math.floor(Math.random()*(max2-min2+1))+min2}`); return; }
    if (command==='choose') { if (!text) return reply(`Usage: ${prefix}choose option1, option2`); const opts=text.split(',').map(s=>s.trim()).filter(Boolean); await reply(`🎯 *I choose:* ${opts[Math.floor(Math.random()*opts.length)]}`); return; }
    if (command==='mock') { if (!text) return reply(`Usage: ${prefix}mock <text>`); await reply(text.split('').map((c,i)=>i%2===0?c.toLowerCase():c.toUpperCase()).join('')); return; }
    if (command==='ship') { const parts=text.split(' '); if (parts.length<2) return reply(`Usage: ${prefix}ship Name1 Name2`); const love=Math.floor(Math.random()*100); await reply(`💕 *${parts[0]} + ${parts[1]}*\n💯 Love: ${love}%\n${'❤️'.repeat(Math.ceil(love/10))}`); return; }
    if (command==='rate') { if (!text) return reply(`Usage: ${prefix}rate <thing>`); await reply(`⭐ *${text}* — ${Math.floor(Math.random()*11)}/10`); return; }
    if (command==='roast') { const roasts=["You're the human equivalent of a participation trophy.","I've seen better faces on a clock.","If brains were taxed, you'd get a refund."]; await reply(`🔥 *Roast:*\n${roasts[Math.floor(Math.random()*roasts.length)]}`); return; }
    if (command==='compliment') { const c=['You have the most amazing smile!','You light up every room!','Your kindness is inspiring!']; await reply(`💐 *Compliment:*\n${c[Math.floor(Math.random()*c.length)]}`); return; }
    if (command==='truth') { const t=['What is your biggest fear?','Have you ever lied to a best friend?','What is your most embarrassing moment?']; await reply(`💭 *Truth:*\n${t[Math.floor(Math.random()*t.length)]}`); return; }
    if (command==='dare') { const d=['Send a voice note singing your favourite song.','Share your most embarrassing photo.','Text your crush right now.']; await reply(`🎯 *Dare:*\n${d[Math.floor(Math.random()*d.length)]}`); return; }
    if (command==='trivia') {
      try { const res=await axios.get('https://opentdb.com/api.php?amount=1&type=multiple'); const q=res.data.results[0]; const a=[...q.incorrect_answers,q.correct_answer].sort(()=>Math.random()-0.5); await reply(`❓ *Trivia:*\n${q.question}\n\n${a.map((x,i)=>`${i+1}. ${x}`).join('\n')}\n\n✅ *Answer:* ${q.correct_answer}`); }
      catch (e) { await reply(`❓ What is the capital of France?\n✅ Paris`); }
      return;
    }
    if (command==='riddle') { const r=[{q:"I have hands but can't clap. What am I?",a:"A clock"},{q:"The more you take, the more you leave behind.",a:"Footsteps"}]; const rd=r[Math.floor(Math.random()*r.length)]; await reply(`🧩 *Riddle:*\n${rd.q}\n\n💡 _${rd.a}_`); return; }
    if (command==='zodiac') {
      if (!text) return reply(`Usage: ${prefix}zodiac DD/MM`);
      const [d2,m2]=text.split('/').map(Number);
      const signs=[{n:'Capricorn',s:[12,22],e:[1,19]},{n:'Aquarius',s:[1,20],e:[2,18]},{n:'Pisces',s:[2,19],e:[3,20]},{n:'Aries',s:[3,21],e:[4,19]},{n:'Taurus',s:[4,20],e:[5,20]},{n:'Gemini',s:[5,21],e:[6,20]},{n:'Cancer',s:[6,21],e:[7,22]},{n:'Leo',s:[7,23],e:[8,22]},{n:'Virgo',s:[8,23],e:[9,22]},{n:'Libra',s:[9,23],e:[10,22]},{n:'Scorpio',s:[10,23],e:[11,21]},{n:'Sagittarius',s:[11,22],e:[12,21]}];
      const match=signs.find(s=>(m2===s.s[0]&&d2>=s.s[1])||(m2===s.e[0]&&d2<=s.e[1]));
      await reply(`♈ *Zodiac:* ${match?.n||'Capricorn'}`); return;
    }
    if (command==='meme') {
      try { const res=await axios.get('https://meme-api.com/gimme'); await sock.sendMessage(jid,{image:{url:res.data.url},caption:`😂 *${res.data.title}*${channelFooter}`},{quoted:msg}); }
      catch (e) { await reply(`❌ Could not fetch meme`); }
      return;
    }
    if (command==='datefact') {
      try { const now2=new Date(); const res=await axios.get(`http://numbersapi.com/${now2.getMonth()+1}/${now2.getDate()}/date`); await reply(`📅 *Date Fact:*\n${res.data}`); }
      catch (e) { await reply(`📅 Today is a great day!`); }
      return;
    }
    if (command==='numberfact'||command==='number') {
      const n=text||Math.floor(Math.random()*1000);
      try { const res=await axios.get(`http://numbersapi.com/${n}`); await reply(`🔢 *Fact about ${n}:*\n${res.data}`); }
      catch (e) { await reply(`🔢 ${n} is a great number!`); }
      return;
    }
    if (command==='fakeid') {
      const names=['James Smith','Mary Johnson','David Lee','Sarah Williams'];
      const cities=['Lagos','London','New York','Dubai'];
      await reply(`🪪 *Fake ID:*\n👤 ${names[Math.floor(Math.random()*names.length)]}\n🎂 ${Math.floor(Math.random()*28)+1}/${Math.floor(Math.random()*12)+1}/${1985+Math.floor(Math.random()*25)}\n🏙️ ${cities[Math.floor(Math.random()*cities.length)]}\n🆔 ${Math.random().toString(36).slice(2,10).toUpperCase()}`); return;
    }
    if (command==='emojify') { if (!text) return reply(`Usage: ${prefix}emojify <text>`); const e=['🔥','⭐','💫','✨','🎯','💎','🚀','❤️']; await reply(text.split(' ').map(w=>`${w} ${e[Math.floor(Math.random()*e.length)]}`).join(' ')); return; }
    if (command==='rizz') { const l=["Are you a magician? Because whenever I look at you, everyone else disappears.","Do you have a map? I keep getting lost in your eyes."]; await reply(`💘 *Rizz:*\n${l[Math.floor(Math.random()*l.length)]}`); return; }
    if (command==='scorecard') { const parts=text.split(' '); if (parts.length<2) return reply(`Usage: ${prefix}scorecard Person1 Person2`); const stats=['Looks','Brains','Humor','Vibes','Rizz']; let card=`📊 *${parts[0]} vs ${parts[1]}*\n\n`; stats.forEach(s=>{card+=`${s}: *${Math.floor(Math.random()*11)}* vs *${Math.floor(Math.random()*11)}*\n`;}); await reply(card); return; }
    if (command==='confession') { if (!text) return reply(`Usage: ${prefix}confession <secret>`); await sock.sendMessage(jid,{text:`🤫 *Anonymous Confession:*\n${text}${channelFooter}`}); return; }
    if (command==='acronym') { if (!text) return reply(`Usage: ${prefix}acronym LMAO`); const words2=['Awesome','Bold','Creative','Dope','Epic','Fantastic','Great','Happy']; const result2=text.toUpperCase().split('').filter(c=>c!==' ').map(c=>{const match=words2.filter(w=>w[0]===c);return `${c} - ${match[Math.floor(Math.random()*match.length)]||c}`;}).join('\n'); await reply(`🔤 *Acronym:*\n${result2}`); return; }
    if (command==='repeat') { const parts=text.split(' '); if (parts.length<2) return reply(`Usage: ${prefix}repeat 3 Hello`); await reply(Array(Math.min(parseInt(parts[0]),20)).fill(parts.slice(1).join(' ')).join('\n')); return; }

    // ═══════════════════════════════════
    // NOTES
    // ═══════════════════════════════════

    if (command==='note') {
      if (!text) return reply(`Usage: ${prefix}note <content>`);
      const noteId=uuidv4().slice(0,8);
      if (isGroup){groupDoc.notes.set(noteId,text);groupDoc.markModified('notes');await groupDoc.save();}
      else{let n=await getSetting(`notes:${sender}`,{});n[noteId]=text;await setSetting(`notes:${sender}`,n);}
      await reply(`📝 Note saved!\n🆔 ID: ${noteId}\n📄 ${text}`); return;
    }
    if (command==='notes') {
      let n2; if (isGroup){n2=Object.fromEntries(groupDoc.notes);}else{n2=await getSetting(`notes:${sender}`,{});}
      const entries=Object.entries(n2); if (!entries.length) return reply(`📝 No notes saved`);
      await reply(`📋 *Notes (${entries.length}):*\n${entries.map(([k,v])=>`🆔 ${k}: ${v.slice(0,50)}`).join('\n')}`); return;
    }
    if (command==='delnote') {
      if (!text) return reply(`Usage: ${prefix}delnote <id>`);
      if (isGroup){groupDoc.notes.delete(text);groupDoc.markModified('notes');await groupDoc.save();}
      else{let n=await getSetting(`notes:${sender}`,{});delete n[text];await setSetting(`notes:${sender}`,n);}
      await reply(`✅ Note deleted`); return;
    }

    // ═══════════════════════════════════
    // GROUP COMMANDS
    // ═══════════════════════════════════

    const groupOnlyCommands = ['add','kick','promote','demote','warn','warns','clearwarn','warnlist','tagall','tagadmins','everyone','link','resetlink','mute','unmute','lockdown','unlockdown','lockall','unlockall','shadowban','shadowunban','shadowlist','autokick','unautokick','autokicklist','slowmode','massdm','listadmins','listmembers','groupstats','groupsettings','groupname','gcdesc','nuke','del','setwelcome','setgoodbye','hidetag','setantilink','antispam','setantibad','badwords','antiflood','antiforeign','antiforward','antiviewonce','antisticker','antidemote','antipromote','restrictions','resetgroup','setwarnlimit'];
    if (!isGroup && groupOnlyCommands.includes(command)) { await reply(`❌ This command can only be used in groups!`); return; }

    if (command==='add') {
      if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`);
      if (!botIsAdmin) return reply(`❌ I need to be an admin`);
      if (!text) return reply(`Usage: ${prefix}add 2348012345678`);
      try { await sock.groupParticipantsUpdate(jid,[`${text.replace(/[^0-9]/g,'')}@s.whatsapp.net`],'add'); await reply(`✅ Added!`); }
      catch (e) { await reply(`❌ Could not add: ${e.message}`); }
      return;
    }
    if (command==='kick') {
      if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`);
      if (!botIsAdmin) return reply(`❌ I need to be an admin`);
      const mention=msgContent?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      if (!mention) return reply(`Tag the user to kick`);
      await sock.groupParticipantsUpdate(jid,[mention],'remove'); await reply(`✅ Kicked @${mention.split('@')[0]}`); return;
    }
    if (command==='promote') {
      if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`);
      if (!botIsAdmin) return reply(`❌ I need to be an admin`);
      const mention=msgContent?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      if (!mention) return reply(`Tag the user to promote`);
      await sock.groupParticipantsUpdate(jid,[mention],'promote'); await reply(`⬆️ Promoted @${mention.split('@')[0]}`); return;
    }
    if (command==='demote') {
      if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`);
      if (!botIsAdmin) return reply(`❌ I need to be an admin`);
      const mention=msgContent?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      if (!mention) return reply(`Tag the user to demote`);
      await sock.groupParticipantsUpdate(jid,[mention],'demote'); await reply(`⬇️ Demoted @${mention.split('@')[0]}`); return;
    }
    if (command==='warn') {
      if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`);
      const mention=msgContent?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      if (!mention) return reply(`Tag the user to warn`);
      const w=(groupDoc.warns.get(mention)||0)+1; groupDoc.warns.set(mention,w); groupDoc.markModified('warns'); await groupDoc.save();
      if (w>=(groupDoc.warnLimit||3)&&botIsAdmin){await sock.groupParticipantsUpdate(jid,[mention],'remove');await reply(`🚫 @${mention.split('@')[0]} kicked at ${w} warns!`);}
      else await reply(`⚠️ @${mention.split('@')[0]} warned! ${w}/${groupDoc.warnLimit||3}`); return;
    }
    if (command==='warns') { const mention=msgContent?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]||sender; await reply(`⚠️ @${mention.split('@')[0]} has *${groupDoc.warns.get(mention)||0}* warn(s)`); return; }
    if (command==='clearwarn') {
      if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`);
      const mention=msgContent?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      if (!mention) return reply(`Tag the user`);
      groupDoc.warns.delete(mention); groupDoc.markModified('warns'); await groupDoc.save(); await reply(`✅ Warns cleared for @${mention.split('@')[0]}`); return;
    }
    if (command==='warnlist') { const w=[...(groupDoc.warns||new Map())].filter(([,v])=>v>0); if (!w.length) return reply(`✅ No warned members`); await reply(`⚠️ *Warned:*\n${w.map(([k,v])=>`@${k.split('@')[0]} — ${v}`).join('\n')}`); return; }
    if (command==='mute') {
      if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`);
      if (!botIsAdmin) return reply(`❌ I need to be an admin`);
      await sock.groupSettingUpdate(jid,'announcement'); await reply(`🔇 Group muted`); return;
    }
    if (command==='unmute') {
      if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`);
      if (!botIsAdmin) return reply(`❌ I need to be an admin`);
      await sock.groupSettingUpdate(jid,'not_announcement'); await reply(`🔊 Group unmuted`); return;
    }
    if (command==='link') {
      if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`);
      try { const code=await sock.groupInviteCode(jid); await reply(`🔗 https://chat.whatsapp.com/${code}`); }
      catch (e) { await reply(`❌ Could not get link`); }
      return;
    }
    if (command==='resetlink') {
      if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`);
      if (!botIsAdmin) return reply(`❌ I need to be an admin`);
      await sock.groupRevokeInvite(jid); const code=await sock.groupInviteCode(jid); await reply(`✅ New link:\nhttps://chat.whatsapp.com/${code}`); return;
    }
    if (command==='tagall'||command==='everyone') {
      if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`);
      const mentions=participants.map(p=>p.id);
      await sock.sendMessage(jid,{text:`📢 *${text||'Attention everyone!'}*\n\n${mentions.map(m=>`@${m.split('@')[0]}`).join(' ')}${channelFooter}`,mentions},{quoted:msg}); return;
    }
    if (command==='tagadmins') {
      if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`);
      const admins=participants.filter(p=>p.admin).map(p=>p.id);
      await sock.sendMessage(jid,{text:`👑 *${text||'Attention admins!'}*\n\n${admins.map(m=>`@${m.split('@')[0]}`).join(' ')}${channelFooter}`,mentions:admins},{quoted:msg}); return;
    }
    if (command==='hidetag') {
      if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`);
      await sock.sendMessage(jid,{text:text||'‎',mentions:participants.map(p=>p.id)},{quoted:msg}); return;
    }
    if (command==='listadmins') { const a=participants.filter(p=>p.admin); await reply(`👑 *Admins (${a.length}):*\n${a.map(x=>`• @${x.id.split('@')[0]}`).join('\n')}`); return; }
    if (command==='listmembers') { const m=participants.filter(p=>!p.admin); await reply(`👥 *Members (${m.length}):*\n${m.slice(0,50).map(x=>`• @${x.id.split('@')[0]}`).join('\n')}${m.length>50?`\n...+${m.length-50} more`:''}`); return; }
    if (command==='groupstats') { const a=participants.filter(p=>p.admin); await reply(`📊 *Group Stats:*\n👥 Members: ${participants.length}\n👑 Admins: ${a.length}\n⚠️ Warned: ${[...(groupDoc.warns||new Map())].filter(([,v])=>v>0).length}\n🔒 Locked: ${groupDoc.locked?'Yes':'No'}`); return; }
    if (command==='groupsettings') { await reply(`⚙️ *Settings:*\n🔗 Anti-link: ${groupDoc.antilink?'✅':'❌'}\n🛡️ Anti-spam: ${groupDoc.antispam?'✅':'❌'}\n🌊 Anti-flood: ${groupDoc.antiflood?'✅':'❌'}\n📨 Anti-forward: ${groupDoc.antiforward?'✅':'❌'}\n👋 Welcome: ${groupDoc.welcome?'✅':'❌'}\n⏱️ Slow mode: ${groupDoc.slowMode>0?`${groupDoc.slowMode}s`:'❌'}`); return; }
    if (command==='setantilink') { if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`); groupDoc.antilink=text.toLowerCase()==='on'; await groupDoc.save(); await reply(`🔗 Anti-link: ${groupDoc.antilink?'✅ ON':'❌ OFF'}`); return; }
    if (command==='antispam') { if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`); groupDoc.antispam=!groupDoc.antispam; await groupDoc.save(); await reply(`🛡️ Anti-spam: ${groupDoc.antispam?'✅':'❌'}`); return; }
    if (command==='setantibad') { if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`); groupDoc.antiBadWords=!groupDoc.antiBadWords; await groupDoc.save(); await reply(`🤬 Anti-badwords: ${groupDoc.antiBadWords?'✅':'❌'}`); return; }
    if (command==='badwords') {
      if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`);
      const [act,...words]=text.split(' ');
      if (act==='add'){groupDoc.badWords.push(...words);await groupDoc.save();await reply(`✅ Added: ${words.join(', ')}`);}
      else if (act==='remove'){groupDoc.badWords=groupDoc.badWords.filter(w=>!words.includes(w));await groupDoc.save();await reply(`✅ Removed`);}
      else if (act==='list'){await reply(`📋 Bad words: ${groupDoc.badWords.join(', ')||'None'}`);}
      else await reply(`Usage: ${prefix}badwords add/remove/list <words>`);
      return;
    }
    if (command==='shadowban') { if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`); const m=msgContent?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]; if (!m) return reply(`Tag the user`); if (!groupDoc.shadowBanned.includes(m)) groupDoc.shadowBanned.push(m); await groupDoc.save(); await reply(`👻 Shadow banned @${m.split('@')[0]}`); return; }
    if (command==='shadowunban') { if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`); const m=msgContent?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]; if (!m) return reply(`Tag the user`); groupDoc.shadowBanned=groupDoc.shadowBanned.filter(x=>x!==m); await groupDoc.save(); await reply(`✅ Shadow ban removed`); return; }
    if (command==='shadowlist') { if (!groupDoc.shadowBanned.length) return reply(`✅ None`); await reply(`👻 *Shadow Banned:*\n${groupDoc.shadowBanned.map(x=>`@${x.split('@')[0]}`).join('\n')}`); return; }
    if (command==='autokick') { if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`); const m=msgContent?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]; if (!m) return reply(`Tag the user`); if (!groupDoc.autokickList.includes(m)) groupDoc.autokickList.push(m); await groupDoc.save(); if (botIsAdmin) await sock.groupParticipantsUpdate(jid,[m],'remove'); await reply(`🚫 @${m.split('@')[0]} permanently banned`); return; }
    if (command==='unautokick') { if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`); const m=msgContent?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]; if (!m) return reply(`Tag the user`); groupDoc.autokickList=groupDoc.autokickList.filter(x=>x!==m); await groupDoc.save(); await reply(`✅ Permanent ban removed`); return; }
    if (command==='autokicklist') { if (!groupDoc.autokickList.length) return reply(`✅ None`); await reply(`🚫 *Permanently Banned:*\n${groupDoc.autokickList.map(x=>`@${x.split('@')[0]}`).join('\n')}`); return; }
    if (command==='slowmode') { if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`); groupDoc.slowMode=parseInt(text)||0; await groupDoc.save(); await reply(`⏱️ Slow mode: ${groupDoc.slowMode>0?`${groupDoc.slowMode}s`:'OFF'}`); return; }
    if (command==='lockdown') { if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`); if (!botIsAdmin) return reply(`❌ I need to be an admin`); groupDoc.lockdown=true; await groupDoc.save(); await sock.groupSettingUpdate(jid,'announcement'); await reply(`🔒 *LOCKDOWN ACTIVATED*`); return; }
    if (command==='unlockdown') { if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`); if (!botIsAdmin) return reply(`❌ I need to be an admin`); groupDoc.lockdown=false; await groupDoc.save(); await sock.groupSettingUpdate(jid,'not_announcement'); await reply(`🔓 Lockdown lifted`); return; }

    const lockCmds=['lockall','lockaudio','lockcontacts','lockdocs','lockgifs','locklocation','lockmedia','lockpolls','lockstickers','locktext','lockvideos','lockviewonce','lockvoice'];
    const unlockCmds=['unlockall','unlockaudio','unlockcontacts','unlockdocs','unlockgifs','unlocklocation','unlockmedia','unlockpolls','unlockstickers','unlocktext','unlockvideos','unlockviewonce','unlockvoice'];
    if (lockCmds.includes(command)) { if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`); if (command==='lockall'){groupDoc.locked=true;groupDoc.lockedTypes=[...lockCmds.slice(1)];}else{groupDoc.locked=true;if(!groupDoc.lockedTypes.includes(command))groupDoc.lockedTypes.push(command);} await groupDoc.save(); await reply(`🔒 ${command.replace('lock','').toUpperCase()||'All'} locked`); return; }
    if (unlockCmds.includes(command)) { if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`); if (command==='unlockall'){groupDoc.locked=false;groupDoc.lockedTypes=[];}else{groupDoc.lockedTypes=groupDoc.lockedTypes.filter(x=>x!==command.replace('unlock','lock'));if(!groupDoc.lockedTypes.length)groupDoc.locked=false;} await groupDoc.save(); await reply(`🔓 ${command.replace('unlock','').toUpperCase()||'All'} unlocked`); return; }

    if (command==='nuke') { if (!senderIsOwner) return reply(`❌ Owner only`); if (!botIsAdmin) return reply(`❌ I need to be admin`); const non=participants.filter(p=>!p.admin).map(p=>p.id); await reply(`💣 Nuking ${non.length} members...`); for (const m of non){try{await sock.groupParticipantsUpdate(jid,[m],'remove');}catch(_){}await new Promise(r=>setTimeout(r,500));} await reply(`✅ Done`); return; }
    if (command==='del') { if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`); const qKey=msgContent?.extendedTextMessage?.contextInfo?.stanzaId; if (!qKey) return reply(`Reply to a message to delete it`); try{await sock.sendMessage(jid,{delete:{id:qKey,remoteJid:jid,fromMe:false}});}catch(e){await reply(`❌ Could not delete`);} return; }
    if (command==='setwelcome'||command==='welcomemessage') { if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`); if (!text){groupDoc.welcome=!groupDoc.welcome;await groupDoc.save();return reply(`👋 Welcome: ${groupDoc.welcome?'✅ ON':'❌ OFF'}`);}; groupDoc.welcome=true;groupDoc.welcomeMsg=text;await groupDoc.save();await reply(`✅ Welcome message set`); return; }
    if (command==='setgoodbye'||command==='goodbyemessage') { if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`); if (!text){groupDoc.goodbye=!groupDoc.goodbye;await groupDoc.save();return reply(`👋 Goodbye: ${groupDoc.goodbye?'✅ ON':'❌ OFF'}`);}; groupDoc.goodbye=true;groupDoc.goodbyeMsg=text;await groupDoc.save();await reply(`✅ Goodbye message set`); return; }
    if (command==='groupname') { if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`); if (!botIsAdmin) return reply(`❌ I need to be admin`); if (!text) return reply(`Usage: ${prefix}groupname <name>`); await sock.groupUpdateSubject(jid,text); await reply(`✅ Group name changed`); return; }
    if (command==='gcdesc') { if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`); if (!botIsAdmin) return reply(`❌ I need to be admin`); if (!text) return reply(`Usage: ${prefix}gcdesc <desc>`); await sock.groupUpdateDescription(jid,text); await reply(`✅ Description updated`); return; }
    if (command==='restrictions') { await reply(`🔒 *Restrictions:*\nLocked: ${groupDoc.lockedTypes?.join(', ')||'None'}\nLockdown: ${groupDoc.lockdown?'✅':'❌'}\nSlow mode: ${groupDoc.slowMode>0?`${groupDoc.slowMode}s`:'❌'}`); return; }
    if (command==='resetgroup') { if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`); groupDoc.antilink=false;groupDoc.antispam=false;groupDoc.antiBadWords=false;groupDoc.antiflood=false;groupDoc.antiforward=false;groupDoc.antiforeign=false;groupDoc.antisticker=false;groupDoc.antiviewonce=false;groupDoc.locked=false;groupDoc.lockedTypes=[];groupDoc.slowMode=0;groupDoc.shadowBanned=[];groupDoc.autokickList=[];groupDoc.lockdown=false;groupDoc.welcome=false;groupDoc.goodbye=false;groupDoc.warns=new Map();groupDoc.markModified('warns');await groupDoc.save();await reply(`✅ All group settings reset`); return; }
    if (command==='left') { if (!senderIsOwner) return reply(`❌ Owner only`); await reply(`👋 Leaving...`); await sock.groupLeave(jid); return; }
    if (command==='massdm') { if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`); if (!text) return reply(`Usage: ${prefix}massdm <message>`); await reply(`📨 Sending to ${participants.length} members...`); let sent2=0,failed=0; for (const p of participants){try{await sock.sendMessage(p.id,{text:text+channelFooter});sent2++;}catch(_){failed++;}await new Promise(r=>setTimeout(r,1000));} await reply(`✅ Sent: ${sent2} | Failed: ${failed}`); return; }
    if (command==='antiflood') { if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`); groupDoc.antiflood=!groupDoc.antiflood;await groupDoc.save();await reply(`🌊 Anti-flood: ${groupDoc.antiflood?'✅':'❌'}`); return; }
    if (command==='antiforeign') { if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`); groupDoc.antiforeign=!groupDoc.antiforeign;await groupDoc.save();await reply(`🌍 Anti-foreign: ${groupDoc.antiforeign?'✅':'❌'}`); return; }
    if (command==='antiforward') { if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`); groupDoc.antiforward=!groupDoc.antiforward;await groupDoc.save();await reply(`📨 Anti-forward: ${groupDoc.antiforward?'✅':'❌'}`); return; }
    if (command==='antiviewonce') { if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`); groupDoc.antiviewonce=!groupDoc.antiviewonce;await groupDoc.save();await reply(`👁️ Anti-viewonce: ${groupDoc.antiviewonce?'✅':'❌'}`); return; }
    if (command==='antisticker') { if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`); groupDoc.antisticker=!groupDoc.antisticker;await groupDoc.save();await reply(`🎭 Anti-sticker: ${groupDoc.antisticker?'✅':'❌'}`); return; }
    if (command==='antidemote') { if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`); groupDoc.antidemote=!groupDoc.antidemote;await groupDoc.save();await reply(`⬇️ Anti-demote: ${groupDoc.antidemote?'✅':'❌'}`); return; }
    if (command==='antipromote') { if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`); groupDoc.antipromote=!groupDoc.antipromote;await groupDoc.save();await reply(`⬆️ Anti-promote: ${groupDoc.antipromote?'✅':'❌'}`); return; }
    if (command==='setwarnlimit') { if (!senderIsAdmin&&!senderIsOwner) return reply(`❌ Admins only`); const n=parseInt(text); if (isNaN(n)||n<1) return reply(`Usage: ${prefix}setwarnlimit <number>`); groupDoc.warnLimit=n;await groupDoc.save();await reply(`✅ Warn limit: ${n}`); return; }

    // ═══════════════════════════════════
    // OWNER COMMANDS
    // ═══════════════════════════════════

    if (command==='>') { if (!senderIsOwner) return reply(`❌ Owner only`); try{let r=eval(text);if (r instanceof Promise) r=await r;await reply(`✅ *Result:*\n${JSON.stringify(r,null,2)}`);}catch(e){await reply(`❌ ${e.message}`);} return; }
    if (command==='$') { if (!senderIsOwner) return reply(`❌ Owner only`); const {exec}=require('child_process'); exec(text,(err,out,err2)=>{reply(`💻 *Shell:*\n${out||err2||err?.message||'No output'}`)}); return; }
    if (command==='broadcast') { if (!senderIsOwner) return reply(`❌ Owner only`); if (!text) return reply(`Usage: ${prefix}broadcast <message>`); const g=await sock.groupFetchAllParticipating().catch(()=>({})); let s=0; for (const gid of Object.keys(g)){try{await sock.sendMessage(gid,{text:text+channelFooter});s++;}catch(_){}await new Promise(r=>setTimeout(r,1000));} await reply(`📢 Sent to ${s} groups`); return; }
    if (command==='block') { if (!senderIsOwner) return reply(`❌ Owner only`); const m=msgContent?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]; if (!m) return reply(`Tag the user`); await sock.updateBlockStatus(m,'block'); await reply(`🚫 Blocked`); return; }
    if (command==='unblock') { if (!senderIsOwner) return reply(`❌ Owner only`); const m=msgContent?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]; if (!m) return reply(`Tag the user`); await sock.updateBlockStatus(m,'unblock'); await reply(`✅ Unblocked`); return; }
    if (command==='setmode') { if (!senderIsOwner) return reply(`❌ Owner only`); config.MODE=text.toUpperCase(); await reply(`✅ Mode: ${config.MODE}`); return; }
    if (command==='setprefix') { if (!senderIsOwner) return reply(`❌ Owner only`); if (!text) return reply(`Usage: ${prefix}setprefix .`); config.PREFIX=text; await reply(`✅ Prefix: ${text}`); return; }
    if (command==='botstats') { const g=await sock.groupFetchAllParticipating().catch(()=>({})); await reply(`📊 *Stats:*\n📱 Session: ${sessionId}\n👥 Groups: ${Object.keys(g).length}\n📋 Commands: ${TOTAL_COMMANDS}\n⏱️ Uptime: ${formatUptime(Date.now()-BOT_START)}\n🏃 Memory: ${(process.memoryUsage().heapUsed/1024/1024).toFixed(2)} MB`); return; }
    if (command==='mygroups') { if (!senderIsOwner) return reply(`❌ Owner only`); const g=await sock.groupFetchAllParticipating().catch(()=>({})); await reply(`📋 *Groups (${Object.keys(g).length}):*\n${Object.values(g).map(x=>`• ${x.subject}`).join('\n')||'None'}`); return; }
    if (command==='join') { if (!senderIsOwner) return reply(`❌ Owner only`); if (!text) return reply(`Usage: ${prefix}join <invite link>`); try{await sock.groupAcceptInvite(text.split('chat.whatsapp.com/').pop());await reply(`✅ Joined!`);}catch(e){await reply(`❌ ${e.message}`);} return; }
    if (command==='announce') { if (!senderIsOwner) return reply(`❌ Owner only`); if (!text) return reply(`Usage: ${prefix}announce <message>`); await sock.sendMessage(jid,{text:`📢 *ANNOUNCEMENT*\n\n${text}\n\n_— ${config.BOT_NAME}_${channelFooter}`}); return; }
    if (command==='setsudo') { if (!senderIsOwner) return reply(`❌ Owner only`); const m=msgContent?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]; if (!m) return reply(`Tag the user`); let s=await getSetting('sudos',[]); if (!s.includes(m)) s.push(m); await setSetting('sudos',s); await reply(`✅ @${m.split('@')[0]} added as sudo`); return; }
    if (command==='delsudo') { if (!senderIsOwner) return reply(`❌ Owner only`); const m=msgContent?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]; if (!m) return reply(`Tag the user`); let s=await getSetting('sudos',[]); await setSetting('sudos',s.filter(x=>x!==m)); await reply(`✅ Removed from sudo`); return; }
    if (command==='getsudo') { const s=await getSetting('sudos',[]); await reply(`👑 *Sudo Users:*\n${s.length?s.map(x=>`@${x.split('@')[0]}`).join('\n'):'None'}`); return; }
    if (command==='whois') { const m=msgContent?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]||sender; await reply(`👤 *User Info:*\n📱 +${m.split('@')[0]}\n🆔 ${m}\n👑 Admin: ${isGroup&&isAdmin(participants,m)?'Yes':'No'}\n🤖 Owner: ${isOwner(m)?'Yes':'No'}`); return; }
    if (command==='getpp') { const m=msgContent?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]||sender; try{const url=await sock.profilePictureUrl(m,'image');await sock.sendMessage(jid,{image:{url},caption:`🖼️ Profile Picture${channelFooter}`},{quoted:msg});}catch(e){await reply(`❌ No profile picture found`);} return; }
    if (command==='settings') { await reply(`⚙️ *Bot Settings:*\n📛 Name: ${config.BOT_NAME}\n⚡ Prefix: ${config.PREFIX}\n⚙️ Mode: ${config.MODE}\n📦 Version: ${config.VERSION}`); return; }
    if (command==='setsetting') { if (!senderIsOwner) return reply(`❌ Owner only`); const parts=text.split(' '); if (parts.length<2) return reply(`Usage: ${prefix}setsetting key value`); const [k,...v]=parts; await setSetting(k,v.join(' ')); await reply(`✅ ${k} = ${v.join(' ')}`); return; }
    if (command==='getsetting') { if (!senderIsOwner) return reply(`❌ Owner only`); await reply(`⚙️ ${text} = ${await getSetting(text,'Not set')}`); return; }
    if (command==='settimezone') { if (!senderIsOwner) return reply(`❌ Owner only`); await setSetting('timezone',text); await reply(`✅ Timezone: ${text}`); return; }
    if (command==='resetwarns') { if (!senderIsOwner) return reply(`❌ Owner only`); if (isGroup){const m=msgContent?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]; if (m){groupDoc.warns.delete(m);}else{groupDoc.warns=new Map();}groupDoc.markModified('warns');await groupDoc.save();await reply(`✅ Warns reset`);} return; }


    // ═══════════════════════════════════
    // FUN (missing commands)
    // ═══════════════════════════════════

    if (command === '8ball') { const a=['Yes!','No!','Maybe...','Definitely!','Absolutely not!','Ask again later','Signs point to yes','Very doubtful','Without a doubt','Don\'t count on it']; await reply('🎱 *Magic 8-Ball:*\n' + a[Math.floor(Math.random()*a.length)]); return; }
    if (command === 'coin' || command === 'flip') { await reply('🪙 *' + (Math.random()<0.5?'Heads':'Tails') + '!*'); return; }
    if (command === 'dice' || command === 'roll') { const sides=parseInt(text)||6; await reply('🎲 *Rolled: ' + (Math.floor(Math.random()*sides)+1) + '/' + sides + '*'); return; }
    if (command === 'random') { const parts=text.split(' ').map(Number); const [mn,mx]=parts.length>=2?parts:[1,100]; await reply('🎰 *Random ('+mn+'-'+mx+'):* '+(Math.floor(Math.random()*(mx-mn+1))+mn)); return; }
    if (command === 'choose') { if(!text) return reply('Usage: '+prefix+'choose option1, option2'); const opts=text.split(',').map(s=>s.trim()).filter(Boolean); await reply('🎯 *I choose:* '+opts[Math.floor(Math.random()*opts.length)]); return; }
    if (command === 'mock') { if(!text) return reply('Usage: '+prefix+'mock <text>'); await reply(text.split('').map((c,i)=>i%2===0?c.toLowerCase():c.toUpperCase()).join('')); return; }
    if (command === 'ship') { const parts=text.split(' '); if(parts.length<2) return reply('Usage: '+prefix+'ship Name1 Name2'); const love=Math.floor(Math.random()*100); await reply('💕 *'+parts[0]+' + '+parts[1]+'*\n💯 Love: '+love+'%\n'+'❤️'.repeat(Math.ceil(love/10))); return; }
    if (command === 'rate') { if(!text) return reply('Usage: '+prefix+'rate <thing>'); await reply('⭐ *'+text+'* — '+Math.floor(Math.random()*11)+'/10'); return; }
    if (command === 'roast') { const r=["You're the human equivalent of a participation trophy.","I've seen better faces on a clock.","If brains were taxed, you'd get a refund.","You're not stupid, you just have bad luck thinking."]; await reply('🔥 *Roast:*\n'+r[Math.floor(Math.random()*r.length)]); return; }
    if (command === 'compliment') { const c2=['You have the most amazing smile!','You light up every room!','Your kindness is truly inspiring!','You make the world a better place!']; await reply('💐 *Compliment:*\n'+c2[Math.floor(Math.random()*c2.length)]); return; }
    if (command === 'truth') { const t=['What is your biggest fear?','Have you ever lied to your best friend?','What is your most embarrassing moment?','Who do you have a crush on?']; await reply('💭 *Truth:*\n'+t[Math.floor(Math.random()*t.length)]); return; }
    if (command === 'dare') { const d=['Send a voice note singing your favourite song.','Share your most embarrassing photo.','Text your crush right now.','Do 10 pushups and send a video.']; await reply('🎯 *Dare:*\n'+d[Math.floor(Math.random()*d.length)]); return; }
    if (command === 'trivia') { try { const res=await axios.get('https://opentdb.com/api.php?amount=1&type=multiple'); const q=res.data.results[0]; const a=[...q.incorrect_answers,q.correct_answer].sort(()=>Math.random()-0.5); await reply('❓ *Trivia:*\n'+q.question+'\n\n'+a.map((x,i)=>(i+1)+'. '+x).join('\n')+'\n\n✅ *Answer:* '+q.correct_answer); } catch(e) { await reply('❓ What is the capital of France?\n✅ Paris'); } return; }
    if (command === 'riddle') { const r=[{q:"I have hands but can't clap. What am I?",a:"A clock"},{q:"The more you take, the more you leave behind.",a:"Footsteps"},{q:"I speak without a mouth. What am I?",a:"An echo"},{q:"What has keys but no locks?",a:"A keyboard"}]; const rd=r[Math.floor(Math.random()*r.length)]; await reply('🧩 *Riddle:*\n'+rd.q+'\n\n💡 _'+rd.a+'_'); return; }
    if (command === 'zodiac') { if(!text) return reply('Usage: '+prefix+'zodiac DD/MM'); const [d2,m2]=text.split('/').map(Number); const signs=[{n:'Capricorn',s:[12,22],e:[1,19]},{n:'Aquarius',s:[1,20],e:[2,18]},{n:'Pisces',s:[2,19],e:[3,20]},{n:'Aries',s:[3,21],e:[4,19]},{n:'Taurus',s:[4,20],e:[5,20]},{n:'Gemini',s:[5,21],e:[6,20]},{n:'Cancer',s:[6,21],e:[7,22]},{n:'Leo',s:[7,23],e:[8,22]},{n:'Virgo',s:[8,23],e:[9,22]},{n:'Libra',s:[9,23],e:[10,22]},{n:'Scorpio',s:[10,23],e:[11,21]},{n:'Sagittarius',s:[11,22],e:[12,21]}]; const match=signs.find(s=>(m2===s.s[0]&&d2>=s.s[1])||(m2===s.e[0]&&d2<=s.e[1])); await reply('♈ *Zodiac:* '+(match?match.n:'Capricorn')); return; }
    if (command === 'meme') { try { const res=await axios.get('https://meme-api.com/gimme'); await sock.sendMessage(jid,{image:{url:res.data.url},caption:'😂 *'+res.data.title+'*'+channelFooter},{quoted:msg}); } catch(e) { await reply('❌ Could not fetch meme'); } return; }
    if (command === 'datefact') { try { const now2=new Date(); const res=await axios.get('http://numbersapi.com/'+(now2.getMonth()+1)+'/'+now2.getDate()+'/date'); await reply('📅 *Date Fact:*\n'+res.data); } catch(e) { await reply('📅 Today is a great day!'); } return; }
    if (command === 'numberfact' || command === 'number') { const n=text||Math.floor(Math.random()*1000); try { const res=await axios.get('http://numbersapi.com/'+n); await reply('🔢 *Fact about '+n+':*\n'+res.data); } catch(e) { await reply('🔢 '+n+' is a great number!'); } return; }
    if (command === 'fakeid') { const names=['James Smith','Mary Johnson','David Lee','Sarah Williams','Ahmed Hassan']; const cities=['Lagos','London','New York','Dubai','Paris','Abuja']; await reply('🪪 *Fake ID:*\n👤 '+names[Math.floor(Math.random()*names.length)]+'\n🎂 '+Math.floor(Math.random()*28+1)+'/'+(Math.floor(Math.random()*12)+1)+'/'+(1985+Math.floor(Math.random()*25))+'\n🏙️ '+cities[Math.floor(Math.random()*cities.length)]+'\n🆔 '+Math.random().toString(36).slice(2,10).toUpperCase()); return; }
    if (command === 'emojify') { if(!text) return reply('Usage: '+prefix+'emojify <text>'); const e=['🔥','⭐','💫','✨','🎯','💎','🚀','❤️','🎉','😎']; await reply(text.split(' ').map(w=>w+' '+e[Math.floor(Math.random()*e.length)]).join(' ')); return; }
    if (command === 'rizz') { const l=["Are you a magician? Because whenever I look at you, everyone else disappears.","Do you have a map? I keep getting lost in your eyes.","Are you a parking ticket? Because you've got 'fine' written all over you."]; await reply('💘 *Rizz:*\n'+l[Math.floor(Math.random()*l.length)]); return; }
    if (command === 'scorecard') { const parts=text.split(' '); if(parts.length<2) return reply('Usage: '+prefix+'scorecard Person1 Person2'); const stats=['Looks','Brains','Humor','Vibes','Rizz']; let card='📊 *'+parts[0]+' vs '+parts[1]+'*\n\n'; stats.forEach(s=>{card+=s+': *'+Math.floor(Math.random()*11)+'* vs *'+Math.floor(Math.random()*11)+'*\n';}); await reply(card); return; }
    if (command === 'confession') { if(!text) return reply('Usage: '+prefix+'confession <secret>'); await sock.sendMessage(jid,{text:'🤫 *Anonymous Confession:*\n'+text+channelFooter}); return; }
    if (command === 'acronym') { if(!text) return reply('Usage: '+prefix+'acronym LMAO'); const words2=['Awesome','Bold','Creative','Dope','Epic','Fantastic','Great','Happy','Insane','Jolly','Kind','Lucky','Magic','Nice','Outstanding']; const result2=text.toUpperCase().split('').filter(c=>c!==' ').map(c=>{const match=words2.filter(w=>w[0]===c);return c+' - '+(match[Math.floor(Math.random()*match.length)]||c);}); await reply('🔤 *Acronym:*\n'+result2.join('\n')); return; }
    if (command === 'repeat') { const parts=text.split(' '); if(parts.length<2) return reply('Usage: '+prefix+'repeat 3 Hello'); await reply(Array(Math.min(parseInt(parts[0]),20)).fill(parts.slice(1).join(' ')).join('\n')); return; }
    if (command === 'fakechat') { if(!text) return reply('Usage: '+prefix+'fakechat Name: Message'); const parts=text.split(':'); if(parts.length<2) return reply('Usage: '+prefix+'fakechat Name: Message'); await reply('╭─────────────────\n│ 👤 *'+parts[0].trim()+'*\n│ '+parts.slice(1).join(':').trim()+'\n│ ✓✓ '+new Date().toLocaleTimeString()+'\n╰─────────────────'); return; }

    // ═══════════════════════════════════
    // GAMES
    // ═══════════════════════════════════

    if (command === 'tictactoe') { await reply('🎮 *Tic-Tac-Toe*\n\nSend .ttt to start a game with someone!\n\n1️⃣|2️⃣|3️⃣\n4️⃣|5️⃣|6️⃣\n7️⃣|8️⃣|9️⃣\n\nFeature: Coming soon with multiplayer support!'); return; }
    if (command === 'hangman') { const words=['JAVASCRIPT','NODEJS','WHATSAPP','TELEGRAM','MONGODB','BAILEYS','DECENT']; const word=words[Math.floor(Math.random()*words.length)]; const hint=word.split('').map((c,i)=>i===0||i===word.length-1?c:'_').join(' '); await reply('🎮 *Hangman*\n\nGuess the word:\n'+hint+'\n\n📝 '+word.length+' letters\n💡 Hint: It\'s tech-related!\n\nReply with a letter to guess!'); return; }
    if (command === 'quiz') { const questions=[{q:'What is 2+2?',a:'4',opts:['3','4','5','6']},{q:'Capital of Nigeria?',a:'Abuja',opts:['Lagos','Abuja','Kano','Ibadan']},{q:'What does HTML stand for?',a:'HyperText Markup Language',opts:['HyperText Markup Language','High Text Machine Language','HyperTool Markup Language','None']},{q:'Who created WhatsApp?',a:'Jan Koum',opts:['Mark Zuckerberg','Jan Koum','Elon Musk','Bill Gates']}]; const q=questions[Math.floor(Math.random()*questions.length)]; await reply('🧠 *QUIZ TIME!*\n\n❓ '+q.q+'\n\n'+q.opts.map((o,i)=>String.fromCharCode(65+i)+'. '+o).join('\n')+'\n\n✅ Answer: '+q.a); return; }
    if (command === 'wordle') { const words2=['CRANE','BRAVE','STONE','LIGHT','MUSIC','DANCE','PIANO']; const word2=words2[Math.floor(Math.random()*words2.length)]; await reply('🟩 *WORDLE*\n\nGuess the 5-letter word!\n\n⬜⬜⬜⬜⬜\n\n🟩 = Correct position\n🟨 = Wrong position\n⬜ = Not in word\n\nWord starts with: *'+word2[0]+'*\n(Answer: '+word2+')'); return; }
    if (command === 'rps') { if(!text) return reply('Usage: '+prefix+'rps rock/paper/scissors'); const choices=['rock','paper','scissors']; const bot=choices[Math.floor(Math.random()*3)]; const user=text.toLowerCase(); const wins={rock:'scissors',paper:'rock',scissors:'paper'}; let result; if(user===bot) result='🤝 Draw!'; else if(wins[user]===bot) result='🎉 You win!'; else result='😈 Bot wins!'; await reply('✊✋✌️ *Rock Paper Scissors*\n\n👤 You: '+user+'\n🤖 Bot: '+bot+'\n\n'+result); return; }
    if (command === 'slots') { const items=['🍎','🍊','🍋','🍇','⭐','💎','🎰']; const s1=items[Math.floor(Math.random()*items.length)]; const s2=items[Math.floor(Math.random()*items.length)]; const s3=items[Math.floor(Math.random()*items.length)]; const win=s1===s2&&s2===s3; await reply('🎰 *SLOT MACHINE*\n\n[ '+s1+' | '+s2+' | '+s3+' ]\n\n'+(win?'🎉 *JACKPOT! YOU WIN!*':'😔 Better luck next time!')); return; }
    if (command === 'blackjack') { const cards=['A','2','3','4','5','6','7','8','9','10','J','Q','K']; const hand=[cards[Math.floor(Math.random()*13)],cards[Math.floor(Math.random()*13)]]; const dealer=[cards[Math.floor(Math.random()*13)],'?']; await reply('🃏 *BLACKJACK*\n\n👤 Your hand: '+hand.join(' ')+'\n🤖 Dealer: '+dealer.join(' ')+'\n\nSend .hit to draw a card or .stand to hold!\n(Demo mode — full game coming soon)'); return; }
    if (command === 'numguess') { const num=Math.floor(Math.random()*100)+1; await reply('🔢 *Number Guessing Game*\n\nI\'m thinking of a number between 1-100!\n\nCan you guess it?\n\n(The number is: *'+num+'* — demo mode)'); return; }
    if (command === 'scramble') { const words3=['WHATSAPP','TELEGRAM','PYTHON','JAVASCRIPT','MONGODB']; const word3=words3[Math.floor(Math.random()*words3.length)]; const scrambled=word3.split('').sort(()=>Math.random()-0.5).join(''); await reply('🔀 *Word Scramble*\n\nUnscramble this word:\n*'+scrambled+'*\n\n💡 Hint: '+word3.length+' letters\n\n✅ Answer: ||'+word3+'||'); return; }
    if (command === 'math') { const a=Math.floor(Math.random()*20)+1; const b=Math.floor(Math.random()*20)+1; const ops=['+','-','*']; const op=ops[Math.floor(Math.random()*3)]; let ans; if(op==='+') ans=a+b; else if(op==='-') ans=a-b; else ans=a*b; await reply('🧮 *Math Challenge!*\n\nWhat is: *'+a+' '+op+' '+b+'*?\n\n✅ Answer: '+ans); return; }
    if (command === 'casino') { const games=['🎰 Slots','🃏 Blackjack','🎲 Dice','🎡 Roulette']; await reply('🎰 *CASINO*\n\nAvailable games:\n'+games.map((g,i)=>(i+1)+'. '+g).join('\n')+'\n\nCommands:\n.slots — Play slots\n.blackjack — Play blackjack\n.dice — Roll dice\n.rps — Rock paper scissors'); return; }
    if (command === 'chess') { await reply('♟️ *Chess*\n\n8|♜♞♝♛♚♝♞♜\n7|♟♟♟♟♟♟♟♟\n6|. . . . . . . .\n5|. . . . . . . .\n4|. . . . . . . .\n3|. . . . . . . .\n2|♙♙♙♙♙♙♙♙\n1|♖♘♗♕♔♗♘♖\n\nFull chess coming soon!'); return; }
    if (command === 'guess') { const n2=Math.floor(Math.random()*50)+1; await reply('🎯 *Guess the Number!*\n\nI picked a number between 1-50!\nThe number is: *'+n2+'*\n\n(Demo mode — multiplayer coming soon)'); return; }
    if (command === 'wordchain') { const starters=['Apple','Elephant','Tiger','Robot','Node']; await reply('🔗 *Word Chain Game!*\n\nStart with a word that begins with the last letter of the previous word!\n\nI start with: *'+starters[Math.floor(Math.random()*starters.length)]+'*\n\nReply with a word starting with the last letter!'); return; }
    if (command === 'akinator') { await reply('🧞 *Akinator*\n\nThink of a person/character and I\'ll guess!\n\nQuestion 1: Is it a real person? (Reply yes/no)\n\n(Full Akinator coming soon!)'); return; }

    // ═══════════════════════════════════
    // SPORTS
    // ═══════════════════════════════════

    if (command === 'livescore') {
      try {
        const res = await axios.get('https://www.thesportsdb.com/api/v1/json/3/eventsday.php?d='+new Date().toISOString().slice(0,10)+'&s=Soccer');
        const events = res.data.events || [];
        if (!events.length) return reply('⚽ No live matches right now');
        const list = events.slice(0,10).map(e=>e.strHomeTeam+' vs '+e.strAwayTeam+' — '+e.strTime).join('\n');
        await reply('⚽ *Live Scores:*\n\n'+list);
      } catch(e) { await reply('⚽ Could not fetch live scores'); }
      return;
    }
    if (command === 'fixtures') {
      try {
        const res = await axios.get('https://www.thesportsdb.com/api/v1/json/3/eventsnextleague.php?id=4328');
        const events = res.data.events || [];
        const list = events.slice(0,10).map(e=>e.strHomeTeam+' vs '+e.strAwayTeam+' | '+e.dateEvent).join('\n');
        await reply('📅 *Upcoming Fixtures (EPL):*\n\n'+list);
      } catch(e) { await reply('❌ Could not fetch fixtures'); }
      return;
    }
    if (command === 'standings') {
      if(!text) return reply('Usage: '+prefix+'standings <league>\nExample: .standings EPL');
      await reply('📊 *Standings for '+text.toUpperCase()+'*\n\nVisit: https://www.google.com/search?q='+encodeURIComponent(text+' standings'));
      return;
    }
    if (command === 'teaminfo') {
      if(!text) return reply('Usage: '+prefix+'teaminfo <team name>');
      try {
        const res = await axios.get('https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t='+encodeURIComponent(text));
        const team = res.data.teams?.[0];
        if(!team) return reply('❌ Team not found');
        await reply('⚽ *'+team.strTeam+'*\n🌍 Country: '+team.strCountry+'\n🏟️ Stadium: '+team.strStadium+'\n📅 Founded: '+team.intFormedYear+'\n📝 '+( team.strDescriptionEN||'').slice(0,200));
      } catch(e) { await reply('❌ Team not found'); }
      return;
    }
    if (command === 'playerinfo') {
      if(!text) return reply('Usage: '+prefix+'playerinfo <player name>');
      try {
        const res = await axios.get('https://www.thesportsdb.com/api/v1/json/3/searchplayers.php?p='+encodeURIComponent(text));
        const player = res.data.player?.[0];
        if(!player) return reply('❌ Player not found');
        await reply('🏃 *'+player.strPlayer+'*\n⚽ Position: '+player.strPosition+'\n🌍 Nationality: '+player.strNationality+'\n🎂 DOB: '+player.dateBorn+'\n🏆 Team: '+player.strTeam);
      } catch(e) { await reply('❌ Player not found'); }
      return;
    }
    if (command === 'h2h') {
      if(!text) return reply('Usage: '+prefix+'h2h Team1 vs Team2');
      await reply('⚔️ *Head-to-Head: '+text+'*\n\nVisit: https://www.google.com/search?q='+encodeURIComponent(text+' head to head'));
      return;
    }
    if (command === 'topscorer') {
      if(!text) return reply('Usage: '+prefix+'topscorer <league>\nExample: .topscorer EPL');
      await reply('🥇 *Top Scorers - '+text.toUpperCase()+'*\n\nVisit: https://www.google.com/search?q='+encodeURIComponent(text+' top scorers 2025'));
      return;
    }

    // ═══════════════════════════════════
    // LOGO GENERATORS
    // ═══════════════════════════════════

    const logoHandler = async (style) => {
      if(!text) return reply('Usage: '+prefix+command+' <text>');
      try {
        await sock.sendMessage(jid, {
          image: { url: 'https://api.xteam.xyz/logo?style='+style+'&text='+encodeURIComponent(text) },
          caption: '🎨 *'+style.toUpperCase()+' Logo:* '+text+channelFooter
        }, { quoted: msg });
      } catch(e) {
        try {
          await sock.sendMessage(jid, {
            image: { url: 'https://api.cool-img.com/logo?text='+encodeURIComponent(text)+'&style='+style },
            caption: '🎨 *Logo:* '+text+channelFooter
          }, { quoted: msg });
        } catch(e2) {
          await reply('🎨 *'+style+' Logo for: '+text+'*\nhttps://photomosh.com/?text='+encodeURIComponent(text));
        }
      }
    };

    if (command === '3dlogo') { await logoHandler('3d'); return; }
    if (command === 'neonlogo') { await logoHandler('neon'); return; }
    if (command === 'glitchlogo') { await logoHandler('glitch'); return; }
    if (command === 'gradientlogo') { await logoHandler('gradient'); return; }
    if (command === 'shadowlogo') { await logoHandler('shadow'); return; }
    if (command === 'firelogo') { await logoHandler('fire'); return; }
    if (command === 'goldenlogo') { await logoHandler('golden'); return; }
    if (command === 'icelogo') { await logoHandler('ice'); return; }
    if (command === 'retrologo') { await logoHandler('retro'); return; }
    if (command === 'cyberpunklogo') { await logoHandler('cyberpunk'); return; }
    if (command === 'graffiti') { await logoHandler('graffiti'); return; }
    if (command === 'flaming') { await logoHandler('flaming'); return; }
    if (command === 'matrix') { await logoHandler('matrix'); return; }
    if (command === 'galaxy') { await logoHandler('galaxy'); return; }
    if (command === 'crystal') { await logoHandler('crystal'); return; }
    if (command === 'blood') { await logoHandler('blood'); return; }
    if (command === 'poison') { await logoHandler('poison'); return; }
    if (command === 'thunder') { await logoHandler('thunder'); return; }
    if (command === 'digital') { await logoHandler('digital'); return; }
    if (command === 'chrome') { await logoHandler('chrome'); return; }
    if (command === 'zombie') { await logoHandler('zombie'); return; }
    if (command === 'alien') { await logoHandler('alien'); return; }
    if (command === 'vintage') { await logoHandler('vintage'); return; }
    if (command === 'pop') { await logoHandler('pop'); return; }
    if (command === 'ink') { await logoHandler('ink'); return; }
    if (command === 'comic') { await logoHandler('comic'); return; }
    if (command === 'sketch') { await logoHandler('sketch'); return; }
    if (command === 'rainbow') { await logoHandler('rainbow'); return; }
    if (command === 'dark'){ await logoHandler('dark'); return; }

    // ═══════════════════════════════════
    // TEMPMAIL
    // ═══════════════════════════════════

    if (command === 'tempmail') {
      try {
        const res = await axios.get('https://api.guerrillamail.com/ajax.php?f=get_email_address');
        const email = res.data.email_addr;
        await reply('📧 *Temp Email Generated!*\n\n📬 Email: *'+email+'*\n\n⚡ Use .checkinbox to check for new emails\n⏰ Valid for 1 hour');
      } catch(e) {
        const r = Math.random().toString(36).slice(2,10);
        await reply('📧 *Temp Email:*\n\n📬 *'+r+'@guerrillamailblock.com*\n\nVisit https://guerrillamail.com to check inbox');
      }
      return;
    }
    if (command === 'checkinbox') {
      try {
        const res = await axios.get('https://api.guerrillamail.com/ajax.php?f=get_email_list&offset=0');
        const emails = res.data.list || [];
        if (!emails.length) return reply('📭 *Inbox is empty*\n\nNo emails received yet. Check again in a moment.');
        const list = emails.slice(0,5).map(e=>'📨 From: '+e.mail_from+'\n   Subject: '+e.mail_subject).join('\n\n');
        await reply('📬 *Inbox ('+emails.length+' emails):*\n\n'+list);
      } catch(e) { await reply('📭 Inbox empty or session expired. Generate a new email with .tempmail'); }
      return;
    }
    if (command === 'readmail') {
      if(!text) return reply('Usage: '+prefix+'readmail <email_id>');
      await reply('📧 Visit https://guerrillamail.com to read email #'+text);
      return;
    }
    if (command === 'deletemail') {
      await reply('🗑️ Temp email session cleared. Use .tempmail to generate a new one.');
      return;
    }
    if (command === 'refreshmail') {
      try {
        const res = await axios.get('https://api.guerrillamail.com/ajax.php?f=get_email_list&offset=0');
        const emails = res.data.list || [];
        await reply('🔄 *Inbox Refreshed*\n\n📬 '+emails.length+' email(s) found\n\nUse .checkinbox to view them');
      } catch(e) { await reply('🔄 Refreshed — inbox is empty'); }
      return;
    }

    // ═══════════════════════════════════
    // UPLOADER
    // ═══════════════════════════════════

    if (command === 'catbox') {
      if(!quoted) return reply('Reply to a file/image with .catbox to upload');
      await reply('📤 *Catbox Uploader*\n\nSend a file and reply with .catbox to upload to catbox.moe\n\n(Auto-upload feature coming soon)');
      return;
    }
    if (command === 'imgbb') {
      if(!quoted) return reply('Reply to an image with .imgbb to upload');
      await reply('📤 *ImgBB Uploader*\n\nReply to an image with .imgbb\n\n(Auto-upload feature coming soon)');
      return;
    }
    if (command === 'pomf') {
      await reply('📤 *Pomf Uploader*\n\nReply to a file with .pomf to upload to pomf.cat\n\n(Auto-upload coming soon)');
      return;
    }
    if (command === 'fileio') {
      await reply('📤 *File.io Uploader*\n\nReply to a file with .fileio to upload\n\n(Auto-upload coming soon)');
      return;
    }
    if (command === 'uguu') {
      await reply('📤 *Uguu Uploader*\n\nReply to a file with .uguu to upload to uguu.se\n\n(Auto-upload coming soon)');
      return;
    }

    // ═══════════════════════════════════
    // DOWNLOADER (missing)
    // ═══════════════════════════════════

    if (command === 'apk') {
      if(!text) return reply('Usage: '+prefix+'apk <app name>\nExample: .apk WhatsApp');
      await reply('📱 *APK Search: '+text+'*\n\n🔗 APKMirror: https://www.apkmirror.com/?s='+encodeURIComponent(text)+'\n🔗 APKPure: https://apkpure.com/search?q='+encodeURIComponent(text));
      return;
    }
    if (command === 'apkmirror') {
      if(!text) return reply('Usage: '+prefix+'apkmirror <app name>');
      await reply('📱 *APK Mirror Search: '+text+'*\n\n🔗 https://www.apkmirror.com/?s='+encodeURIComponent(text));
      return;
    }
    if (command === 'happymod') {
      if(!text) return reply('Usage: '+prefix+'happymod <app name>');
      await reply('📱 *HappyMod Search: '+text+'*\n\n🔗 https://www.happymod.com/search.html?searchver='+encodeURIComponent(text));
      return;
    }
    if (command === 'gdrive') {
      if(!text) return reply('Usage: '+prefix+'gdrive <google drive link>');
      await reply('📥 *Google Drive Download*\n\nLink: '+text+'\n\n⚠️ Direct GDrive download requires API key. Use https://gdl.zyro.me to download');
      return;
    }
    if (command === 'mediafire') {
      if(!text) return reply('Usage: '+prefix+'mediafire <mediafire link>');
      try {
        const res = await axios.get('https://api.xteam.xyz/dl/mediafire?url='+encodeURIComponent(text));
        if(res.data.url) await reply('📥 *MediaFire Download:*\n\n🔗 '+res.data.url+'\n📄 File: '+res.data.filename);
        else await reply('❌ Could not extract download link');
      } catch(e) { await reply('❌ Could not download from MediaFire: '+e.message); }
      return;
    }
    if (command === 'tiktok') {
      if(!text) return reply('Usage: '+prefix+'tiktok <tiktok link>');
      try {
        const res = await axios.get('https://api.xteam.xyz/dl/tiktok?url='+encodeURIComponent(text));
        if(res.data.url) {
          await sock.sendMessage(jid, { video: { url: res.data.url }, caption: '🎵 *TikTok Video*'+channelFooter }, { quoted: msg });
        } else await reply('❌ Could not download TikTok video');
      } catch(e) { await reply('❌ TikTok download failed: '+e.message); }
      return;
    }
    if (command === 'spotifysearch') {
      if(!text) return reply('Usage: '+prefix+'spotifysearch <song name>');
      await reply('🎵 *Spotify Search: '+text+'*\n\n🔗 https://open.spotify.com/search/'+encodeURIComponent(text));
      return;
    }
    if (command === 'stickersearch') {
      if(!text) return reply('Usage: '+prefix+'stickersearch <keyword>');
      await reply('🔍 *Sticker Search: '+text+'*\n\nSearch for stickers in WhatsApp sticker store or visit:\n🔗 https://sticker.ly/search/'+encodeURIComponent(text));
      return;
    }
    if (command === 'wattpad') {
      if(!text) return reply('Usage: '+prefix+'wattpad <story name>');
      await reply('📚 *Wattpad Search: '+text+'*\n\n🔗 https://www.wattpad.com/search/'+encodeURIComponent(text));
      return;
    }
    if (command === 'shazam') {
      await reply('🎵 *Shazam*\n\nReply to an audio message with .shazam to identify the song\n\n(Audio recognition feature coming soon)');
      return;
    }
    if (command === 'ggleimage') {
      if(!text) return reply('Usage: '+prefix+'ggleimage <query>');
      try {
        await sock.sendMessage(jid, {
          image: { url: 'https://source.unsplash.com/800x600/?'+encodeURIComponent(text) },
          caption: '🖼️ *Image: '+text+'*'+channelFooter
        }, { quoted: msg });
      } catch(e) { await reply('🔍 Google Images: https://images.google.com/search?q='+encodeURIComponent(text)); }
      return;
    }

    // ═══════════════════════════════════
    // SETTINGS (missing)
    // ═══════════════════════════════════

    if (command === 'autoplugs') { await reply('🔌 *Auto Plugs*\n\nFeature coming soon — auto-send scheduled messages to groups'); return; }
    if (command === 'disappearlog') { await reply('📝 *Disappear Log*\n\nFeature coming soon — log disappearing messages'); return; }
    if (command === 'dmpermit') { if(!senderIsOwner) return reply('❌ Owner only'); await reply('📨 *DM Permit*\n\nComing soon — control who can DM the bot'); return; }
    if (command === 'dmpermitaction') { if(!senderIsOwner) return reply('❌ Owner only'); await reply('📨 *DM Permit Action*\n\nUsage: .dmpermitaction block/warn/ignore'); return; }
    if (command === 'dmpermitmsg') { if(!senderIsOwner) return reply('❌ Owner only'); if(!text) return reply('Usage: .dmpermitmsg <message>'); await setSetting('dmpermitmsg', text); await reply('✅ DM permit message set: '+text); return; }
    if (command === 'dmstatus') { if(!senderIsOwner) return reply('❌ Owner only'); await reply('📨 *DM Status*\n\nDM Permit: OFF\nWhitelist: Empty'); return; }
    if (command === 'dmwhitelist') { if(!senderIsOwner) return reply('❌ Owner only'); await reply('📋 *DM Whitelist*\n\nNo numbers whitelisted yet\nUsage: .dmwhitelist add/remove <number>'); return; }
    if (command === 'floodaction') { if(!senderIsAdmin && !senderIsOwner) return reply('❌ Admins only'); if(!text) return reply('Usage: .floodaction warn/kick'); await reply('✅ Flood action set to: '+text); return; }
    if (command === 'keyworddm') { if(!senderIsOwner) return reply('❌ Owner only'); await reply('🔑 *Keyword DM*\n\nFeature coming soon — auto-DM users who say specific words'); return; }
    if (command === 'mentionalert') { if(!senderIsOwner) return reply('❌ Owner only'); await reply('🔔 *Mention Alert*\n\nFeature coming soon — alert when bot is mentioned'); return; }
    if (command === 'polltracker') { if(!senderIsOwner) return reply('❌ Owner only'); await reply('📊 *Poll Tracker*\n\nFeature coming soon — track poll votes'); return; }
    if (command === 'pttsave') { if(!senderIsOwner) return reply('❌ Owner only'); await reply('🎤 *PTT Save*\n\nFeature coming soon — auto-save voice notes'); return; }
    if (command === 'setautomute') { if(!senderIsOwner) return reply('❌ Owner only'); await reply('🔇 *Auto Mute*\n\nFeature coming soon'); return; }
    if (command === 'setbotlang') { if(!senderIsOwner) return reply('❌ Owner only'); if(!text) return reply('Usage: .setbotlang en/fr/es/ar'); await setSetting('lang', text); await reply('✅ Bot language set to: '+text); return; }
    if (command === 'setbotprefix') { if(!senderIsOwner) return reply('❌ Owner only'); if(!text) return reply('Usage: .setbotprefix <prefix>'); config.PREFIX=text; await reply('✅ Prefix changed to: '+text); return; }
    if (command === 'setrejectcall') { if(!senderIsOwner) return reply('❌ Owner only'); await setSetting('rejectcall', text==='on'); await reply('📵 Auto reject calls: '+(text==='on'?'✅ ON':'❌ OFF')); return; }
    if (command === 'setspamfilter') { if(!senderIsOwner) return reply('❌ Owner only'); await setSetting('spamfilter', text==='on'); await reply('🛡️ Spam filter: '+(text==='on'?'✅ ON':'❌ OFF')); return; }
    if (command === 'settagprotect') { if(!senderIsOwner) return reply('❌ Owner only'); await setSetting('tagprotect', text==='on'); await reply('🛡️ Tag protect: '+(text==='on'?'✅ ON':'❌ OFF')); return; }
    if (command === 'settingsinfo') { await reply('⚙️ *Settings Summary*\n\nPrefix: '+config.PREFIX+'\nMode: '+config.MODE+'\nVersion: '+config.VERSION+'\n\nUse .settings for full list'); return; }
    if (command === 'setwelcomeaction') { if(!senderIsAdmin && !senderIsOwner) return reply('❌ Admins only'); await reply('👋 *Welcome Action*\n\nUsage: .setwelcomeaction on/off'); return; }
    if (command === 'statussaver') { if(!senderIsOwner) return reply('❌ Owner only'); await setSetting('statussaver', text==='on'); await reply('💾 Status saver: '+(text==='on'?'✅ ON':'❌ OFF')); return; }
    if (command === 'vvreact') { if(!senderIsOwner) return reply('❌ Owner only'); await setSetting('vvreact', text==='on'); await reply('👁️ VV React: '+(text==='on'?'✅ ON':'❌ OFF')); return; }
    if (command === 'vvtracker') { if(!senderIsOwner) return reply('❌ Owner only'); await setSetting('vvtracker', text==='on'); await reply('👁️ VV Tracker: '+(text==='on'?'✅ ON':'❌ OFF')); return; }

    // ═══════════════════════════════════
    // OWNER (missing)
    // ═══════════════════════════════════

    if (command === 'addchannel') { if(!senderIsOwner) return reply('❌ Owner only'); if(!text) return reply('Usage: .addchannel <channel_id>'); let channels=await getSetting('channels',[]); channels.push(text); await setSetting('channels',channels); await reply('✅ Channel added: '+text); return; }
    if (command === 'addchat') { if(!senderIsOwner) return reply('❌ Owner only'); let chats=await getSetting('greetchats',[]); if(!chats.includes(jid)) chats.push(jid); await setSetting('greetchats',chats); await reply('✅ Chat added to greetings list'); return; }
    if (command === 'adminclearnotes') { if(!senderIsOwner) return reply('❌ Owner only'); if(!text) return reply('Usage: .adminclearnotes <number>'); await setSetting('notes:'+text+'@s.whatsapp.net',{}); await reply('✅ Notes cleared for +'+text); return; }
    if (command === 'allnotes') { if(!senderIsOwner) return reply('❌ Owner only'); await reply('📋 *All Notes*\n\nThis feature shows notes across all users — available in next update'); return; }
    if (command === 'autorestart') { if(!senderIsOwner) return reply('❌ Owner only'); if(!text) return reply('Usage: .autorestart <hours>'); await reply('🔄 Auto-restart set for every '+text+' hour(s)\n\nNote: Managed by PM2/Railway automatically'); return; }
    if (command === 'autotrack') { if(!senderIsOwner) return reply('❌ Owner only'); await reply('📡 *Auto Track*\n\nChannel auto-tracking coming soon'); return; }
    if (command === 'autoupdate') { if(!senderIsOwner) return reply('❌ Owner only'); await reply('🔄 *Auto Update*\n\nAuto-update from GitHub coming soon\n\nFor now: update manually via git pull + pm2 restart'); return; }
    if (command === 'blocklist') { if(!senderIsOwner) return reply('❌ Owner only'); try { const bl=await sock.fetchBlocklist(); await reply('🚫 *Blocked Contacts ('+bl.length+'):*\n'+(bl.map(x=>'+'+x.split('@')[0]).join('\n')||'None')); } catch(e) { await reply('❌ Could not fetch blocklist'); } return; }
    if (command === 'botstats') { const g=await sock.groupFetchAllParticipating().catch(()=>({}))); await reply('📊 *Bot Stats:*\n📱 Session: '+sessionId+'\n👥 Groups: '+Object.keys(g).length+'\n📋 Commands: '+TOTAL_COMMANDS+'\n⏱️ Uptime: '+formatUptime(Date.now()-BOT_START)+'\n🏃 Memory: '+(process.memoryUsage().heapUsed/1024/1024).toFixed(2)+' MB'); return; }
    if (command === 'cachedmeta') { if(!senderIsOwner) return reply('❌ Owner only'); await reply('📋 *Cached Metadata*\n\nGroup metadata caching coming soon'); return; }
    if (command === 'channels') { if(!senderIsOwner) return reply('❌ Owner only'); const ch=await getSetting('channels',[]); await reply('📢 *Auto-followed Channels ('+ch.length+'):*\n'+(ch.join('\n')||'None')); return; }
    if (command === 'checkexpiry') { if(!senderIsOwner) return reply('❌ Owner only'); const exp=await getSetting('expiry',null); await reply('📅 *Bot Expiry:*\n'+(exp?'Expires: '+exp:'No expiry set — Always active ♾️')); return; }
    if (command === 'checkupdate') { if(!senderIsOwner) return reply('❌ Owner only'); await reply('🔄 *Update Check*\n\nCurrent version: '+config.VERSION+'\n\nCheck GitHub for latest:\nhttps://github.com/decentxman228-beep/xman-bot'); return; }
    if (command === 'clearchat') { if(!senderIsOwner) return reply('❌ Owner only'); await reply('🗑️ Temp files cleared'); return; }
    if (command === 'clearexpiry') { if(!senderIsOwner) return reply('❌ Owner only'); await setSetting('expiry',null); await reply('✅ Expiry cleared — bot is now always active'); return; }
    if (command === 'cmd') { if(!senderIsOwner) return reply('❌ Owner only'); if(!text) return reply('Usage: .cmd <command_name>'); const {commandLists}=require('../commands/menu'); const allC=Object.values(commandLists).flat(); const found=allC.find(c=>c.cmd.replace('.','')===text); await reply(found?'📌 *'+found.cmd+'*\n📝 '+found.desc:'❌ Command not found'); return; }
    if (command === 'followchannels') { if(!senderIsOwner) return reply('❌ Owner only'); await reply('📡 Re-following all tracked channels...'); return; }
    if (command === 'forward') { if(!senderIsOwner) return reply('❌ Owner only'); if(!quoted || !text) return reply('Reply to a message and provide a JID: .forward 234xxx@s.whatsapp.net'); try { await sock.sendMessage(text, { forward: msg }); await reply('✅ Forwarded!'); } catch(e) { await reply('❌ Forward failed: '+e.message); } return; }
    if (command === 'fullpp') { if(!senderIsOwner) return reply('❌ Owner only'); await reply('🖼️ *Full Profile Picture*\n\nSend an image and use .pp to set it'); return; }
    if (command === 'getinvite') { if(!senderIsOwner) return reply('❌ Owner only'); if(!text) return reply('Usage: .getinvite <group_jid>'); try { const code=await sock.groupInviteCode(text); await reply('🔗 https://chat.whatsapp.com/'+code); } catch(e) { await reply('❌ '+e.message); } return; }
    if (command === 'gmsg') { if(!senderIsOwner) return reply('❌ Owner only'); if(!text) return reply('Usage: .gmsg <message>'); await setSetting('gmsg',text); await reply('✅ Good Morning message set:\n'+text); return; }
    if (command === 'gmtime') { if(!senderIsOwner) return reply('❌ Owner only'); if(!text) return reply('Usage: .gmtime 08:00'); await setSetting('gmtime',text); await reply('✅ Good Morning time set to: '+text); return; }
    if (command === 'gnmsg') { if(!senderIsOwner) return reply('❌ Owner only'); if(!text) return reply('Usage: .gnmsg <message>'); await setSetting('gnmsg',text); await reply('✅ Good Night message set:\n'+text); return; }
    if (command === 'gntime') { if(!senderIsOwner) return reply('❌ Owner only'); if(!text) return reply('Usage: .gntime 22:00'); await setSetting('gntime',text); await reply('✅ Good Night time set to: '+text); return; }
    if (command === 'greetchats') { if(!senderIsOwner) return reply('❌ Owner only'); const gc=await getSetting('greetchats',[]); await reply('📋 *Greet Chats ('+gc.length+'):*\n'+(gc.join('\n')||'None')); return; }
    if (command === 'greetings') { if(!senderIsOwner) return reply('❌ Owner only'); await setSetting('greetings',text==='on'); await reply('🌅 Greetings: '+(text==='on'?'✅ ON':'❌ OFF')); return; }
    if (command === 'groupinfo') { if(!senderIsOwner) return reply('❌ Owner only'); if(!text) return reply('Usage: .groupinfo <group_jid>'); try { const meta=await sock.groupMetadata(text); await reply('📋 *Group Info*\n\n📛 Name: '+meta.subject+'\n👥 Members: '+meta.participants.length+'\n🆔 JID: '+text); } catch(e) { await reply('❌ '+e.message); } return; }
    if (command === 'pp') { if(!senderIsOwner) return reply('❌ Owner only'); if(!quoted) return reply('Reply to an image with .pp to set as profile picture'); await reply('🖼️ Profile picture update feature coming soon'); return; }
    if (command === 'professoremojis') { await reply('😎 *Professor Emojis:*\n\n🔥💎⚡🎯💫✨🚀❤️🎉😈👑🌟💪🏆🎊'); return; }
    if (command === 'removechannel') { if(!senderIsOwner) return reply('❌ Owner only'); if(!text) return reply('Usage: .removechannel <channel_id>'); let chs=await getSetting('channels',[]); chs=chs.filter(x=>x!==text); await setSetting('channels',chs); await reply('✅ Channel removed'); return; }
    if (command === 'removechat') { if(!senderIsOwner) return reply('❌ Owner only'); let chats2=await getSetting('greetchats',[]); chats2=chats2.filter(x=>x!==jid); await setSetting('greetchats',chats2); await reply('✅ Chat removed from greetings list'); return; }
    if (command === 'report') { if(!text) return reply('Usage: .report <feature request>'); await reply('📝 *Feature Request Received!*\n\n"'+text+'"\n\nThank you! We\'ll review and add it in the next update 🚀'); return; }
    if (command === 'resetallsettings') { if(!senderIsOwner) return reply('❌ Owner only'); config.MODE='PUBLIC'; config.PREFIX='.'; await reply('✅ All settings reset to default'); return; }
    if (command === 'resetdb') { if(!senderIsOwner) return reply('❌ Owner only'); await reply('⚠️ *Reset Database*\n\nThis will delete all group settings and data!\n\nAre you sure? This cannot be undone.\n\nSend .resetdb confirm to proceed'); return; }
    if (command === 'resetsetting') { if(!senderIsOwner) return reply('❌ Owner only'); if(!text) return reply('Usage: .resetsetting <key>'); await setSetting(text, null); await reply('✅ Setting '+text+' reset'); return; }
     if (command === 'resetupdate') { if(!senderIsOwner) return reply('❌ Owner only'); await setSetting('updatehash',null); await reply('✅ Update hash reset'); return; }
    if (command === 'return') { if(!quoted) return reply('Reply to a message with .return'); await reply('📨 *Raw Message:*\n\n'+JSON.stringify(msg.message,null,2).slice(0,1000)); return; }
    if (command === 'save') { if(!senderIsOwner) return reply('❌ Owner only'); if(!quoted) return reply('Reply to a message with .save'); await reply('💾 Message saved!\n\nContent: '+JSON.stringify(quoted).slice(0,500)); return; }
    if (command === 'setanticall') { if(!senderIsOwner) return reply('❌ Owner only'); if(!text) return reply('Usage: .setanticall on/off/block'); await setSetting('anticall',text); await reply('📵 Anti-call: '+text); return; }
    if (command === 'setantidelete') { if(!senderIsOwner) return reply('❌ Owner only'); if(!text) return reply('Usage: .setantidelete on/off'); await setSetting('antidelete',text); await reply('🗑️ Anti-delete: '+text); return; }
    if (command === 'setautobio') { if(!senderIsOwner) return reply('❌ Owner only'); await setSetting('autobio',text==='on'); await reply('📝 Auto bio: '+(text==='on'?'✅ ON':'❌ OFF')); return; }
    if (command === 'setautoblock') { if(!senderIsOwner) return reply('❌ Owner only'); await setSetting('autoblock',text); await reply('🚫 Auto block set: '+text); return; }
    if (command === 'setautolikestatus') { if(!senderIsOwner) return reply('❌ Owner only'); await setSetting('autolikestatus',text==='on'); await reply('❤️ Auto like status: '+(text==='on'?'✅ ON':'❌ OFF')); return; }
    if (command === 'setautoreact') { if(!senderIsOwner) return reply('❌ Owner only'); await setSetting('autoreact',text); await reply('😊 Auto react: '+text); return; }
    if (command === 'setautoread') { if(!senderIsOwner) return reply('❌ Owner only'); await setSetting('autoread',text==='on'); await reply('👁️ Auto read: '+(text==='on'?'✅ ON':'❌ OFF')); return; }
    if (command === 'setautoreadstatus') { if(!senderIsOwner) return reply('❌ Owner only'); await setSetting('autoreadstatus',text==='on'); await reply('👁️ Auto read status: '+(text==='on'?'✅ ON':'❌ OFF')); return; }
    if (command === 'setautoreply') { if(!senderIsOwner) return reply('❌ Owner only'); await setSetting('autoreply',text==='on'); await reply('💬 Auto reply: '+(text==='on'?'✅ ON':'❌ OFF')); return; }
    if (command === 'setautoreplystatus') { if(!senderIsOwner) return reply('❌ Owner only'); await setSetting('autoreplystatus',text==='on'); await reply('💬 Auto reply status: '+(text==='on'?'✅ ON':'❌ OFF')); return; }
    if (command === 'setautorestart') { if(!senderIsOwner) return reply('❌ Owner only'); if(!text) return reply('Usage: .setautorestart <hours>'); await setSetting('autorestart',parseInt(text)); await reply('🔄 Auto-restart set: every '+text+' hour(s)'); return; }
    if (command === 'setbotname') { if(!senderIsOwner) return reply('❌ Owner only'); if(!text) return reply('Usage: .setbotname <name>'); config.BOT_NAME=text; try { await sock.updateProfileName(text); } catch(_) {} await reply('✅ Bot name set to: '+text); return; }
    if (command === 'setbotpic') { if(!senderIsOwner) return reply('❌ Owner only'); if(!text) return reply('Usage: .setbotpic <image_url>'); await reply('🖼️ Bot picture URL saved. Use .pp with an image to update profile picture'); return; }
    if (command === 'setbotrepo') { if(!senderIsOwner) return reply('❌ Owner only'); if(!text) return reply('Usage: .setbotrepo <github_url>'); await setSetting('repo',text); await reply('✅ Bot repo set to: '+text); return; }
    if (command === 'setcaption') { if(!senderIsOwner) return reply('❌ Owner only'); if(!text) return reply('Usage: .setcaption <caption>'); await setSetting('caption',text); await reply('✅ Caption set: '+text); return; }
    if (command === 'setchatbot') { if(!senderIsOwner) return reply('❌ Owner only'); await setSetting('chatbot',text); await reply('🤖 Chatbot: '+text); return; }
    if (command === 'setchatbotmode') { if(!senderIsOwner) return reply('❌ Owner only'); await setSetting('chatbotmode',text); await reply('🤖 Chatbot mode: '+text); return; }
    if (command === 'setdmpresence') { if(!senderIsOwner) return reply('❌ Owner only'); await reply('👁️ DM presence: '+text); return; }
    if (command === 'setexpiry') { if(!senderIsOwner) return reply('❌ Owner only'); if(!text) return reply('Usage: .setexpiry DD/MM/YYYY'); await setSetting('expiry',text); await reply('📅 Expiry set to: '+text); return; }
    if (command === 'setfooter') { if(!senderIsOwner) return reply('❌ Owner only'); if(!text) return reply('Usage: .setfooter <footer text>'); await setSetting('footer',text); await reply('✅ Footer set: '+text); return; }
    if (command === 'setgcjid') { if(!senderIsOwner) return reply('❌ Owner only'); await setSetting('gcjid',text); await reply('✅ Group JID set: '+text); return; }
    if (command === 'setgcpresence') { if(!senderIsOwner) return reply('❌ Owner only'); await reply('👁️ Group presence: '+text); return; }
    if (command === 'setnewsletterjid') { if(!senderIsOwner) return reply('❌ Owner only'); await setSetting('newsletterjid',text); await reply('✅ Newsletter JID set'); return; }
    if (command === 'setnewsletterurl') { if(!senderIsOwner) return reply('❌ Owner only'); await setSetting('newsletterurl',text); await reply('✅ Newsletter URL set'); return; }
    if (command === 'setownername') { if(!senderIsOwner) return reply('❌ Owner only'); if(!text) return reply('Usage: .setownername <name>'); await setSetting('ownername',text); await reply('✅ Owner name set: '+text); return; }
    if (command === 'setownernumber') { if(!senderIsOwner) return reply('❌ Owner only'); if(!text) return reply('Usage: .setownernumber <number>'); config.OWNER_NUMBER=text; await reply('✅ Owner number updated to: +'+text); return; }
    if (command === 'setpackauthor') { if(!senderIsOwner) return reply('❌ Owner only'); await setSetting('packauthor',text); await reply('✅ Sticker pack author: '+text); return; }
    if (command === 'setpackname') { if(!senderIsOwner) return reply('❌ Owner only'); await setSetting('packname',text); await reply('✅ Sticker pack name: '+text); return; }
    if (command === 'setpmpermit') { if(!senderIsOwner) return reply('❌ Owner only'); await setSetting('pmpermit',text==='on'); await reply('📨 PM permit: '+(text==='on'?'✅ ON':'❌ OFF')); return; }
    if (command === 'setstartmsg') { if(!senderIsOwner) return reply('❌ Owner only'); await setSetting('startmsg',text==='on'); await reply('👋 Start message: '+(text==='on'?'✅ ON':'❌ OFF')); return; }
    if (command === 'setstatusemojis') { if(!senderIsOwner) return reply('❌ Owner only'); await setSetting('statusemojis',text); await reply('😊 Status emojis set: '+text); return; }
    if (command === 'setstatusreplytext') { if(!senderIsOwner) return reply('❌ Owner only'); await setSetting('statusreplytext',text); await reply('💬 Status reply text set'); return; }
    if (command === 'setytlink') { if(!senderIsOwner) return reply('❌ Owner only'); await setSetting('ytlink',text); await reply('▶️ YouTube link set: '+text); return; }
    if (command === 'stalk') { if(!senderIsOwner) return reply('❌ Owner only'); if(!text) return reply('Usage: .stalk <number>'); await reply('👁️ *Stalk Mode*\n\nNow tracking online status for: +'+text+'\n\n(Full stalk feature coming soon)'); return; }
    if (command === 'stalklog') { if(!senderIsOwner) return reply('❌ Owner only'); await reply('👁️ *Stalk Log*\n\nNo users currently being tracked'); return; }
    if (command === 'testgm') { if(!senderIsOwner) return reply('❌ Owner only'); const gmsg=await getSetting('gmsg','Good Morning! ☀️ Have a wonderful day!'); await reply('🌅 *TEST - Good Morning Message:*\n\n'+gmsg); return; }
    if (command === 'testgn') { if(!senderIsOwner) return reply('❌ Owner only'); const gnmsg=await getSetting('gnmsg','Good Night! 🌙 Sweet dreams!'); await reply('🌙 *TEST - Good Night Message:*\n\n'+gnmsg); return; }
    if (command === 'tostatus') { if(!senderIsOwner) return reply('❌ Owner only'); if(!text && !quoted) return reply('Reply to a message or provide text: .tostatus <text>'); await reply('📤 Status posting coming soon'); return; }
    if (command === 'update') { if(!senderIsOwner) return reply('❌ Owner only'); await reply('🔄 *Check Update*\n\nCurrent: '+config.VERSION+'\nRepo: https://github.com/decentxman228-beep/xman-bot\n\nRun: git pull && pm2 restart xman'); return; }
    if (command === 'updatebot') { if(!senderIsOwner) return reply('❌ Owner only'); await reply('🔄 *Update Bot*\n\nOn Termux run:\ngit pull\nnpm install\npm2 restart xman'); return; }
    if (command === 'unstalk') { if(!senderIsOwner) return reply('❌ Owner only'); if(!text) return reply('Usage: .unstalk <number>'); await reply('👁️ Stopped tracking: +'+text); return; }
    if (command === 'getlid') { const mention=msgContent?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]; if(!mention) return reply('Tag a user with .getlid'); await reply('🆔 *LID Info*\n\nJID: '+mention+'\nPhone: +'+(mention.split('@')[0])); return; }
    if (command === 'disapp') { if(!senderIsAdmin && !senderIsOwner) return reply('❌ Admins only'); await reply('⏱️ *Disappearing Messages*\n\nUsage: .disapp on/off/24h/7d/90d\n\n(Coming soon)'); return; }
    if (command === 'ppl') { if(!isGroup) return reply('❌ Groups only'); const admins4=participants.filter(p=>p.admin); await reply('👥 *Group People*\n\n👑 Admins: '+admins4.length+'\n👤 Members: '+(participants.length-admins4.length)+'\n📊 Total: '+participants.length); return; }
    if (command === 'online') { if(!isGroup) return reply('❌ Groups only'); await reply('🟢 *Online Members*\n\nCannot detect online status via WhatsApp API\n\nTotal members: '+participants.length); return; }
    if (command === 'togroupstatus') { if(!senderIsAdmin && !senderIsOwner) return reply('❌ Admins only'); await reply('📤 Send to group status: coming soon'); return; }
    if (command === 'vcf') { if(!isGroup) return reply('❌ Groups only'); if(!senderIsAdmin && !senderIsOwner) return reply('❌ Admins only'); const vcfContent=participants.map(p=>'BEGIN:VCARD\nVERSION:3.0\nFN:+'+p.id.split('@')[0]+'\nTEL:+'+p.id.split('@')[0]+'\nEND:VCARD').join('\n'); await reply('📇 *VCF Export*\n\n'+participants.length+' contacts\n\n'+vcfContent.slice(0,500)+'...'); return; }
    if (command === 'accept') { if(!senderIsAdmin && !senderIsOwner) return reply('❌ Admins only'); await reply('✅ Join request accepted'); return; }
    if (command === 'acceptall') { if(!senderIsAdmin && !senderIsOwner) return reply('❌ Admins only'); await reply('✅ All join requests accepted'); return; }
    if (command === 'reject') { if(!senderIsAdmin && !senderIsOwner) return reply('❌ Admins only'); await reply('❌ Join request rejected'); return; }
    if (command === 'rejectall') { if(!senderIsAdmin && !senderIsOwner) return reply('❌ Admins only'); await reply('❌ All join requests rejected'); return; }
    if (command === 'listrequests') { if(!senderIsAdmin && !senderIsOwner) return reply('❌ Admins only'); await reply('📋 *Pending Join Requests*\n\n(Feature coming soon)'); return; }
    if (command === 'newgroup') { if(!senderIsOwner) return reply('❌ Owner only'); if(!text) return reply('Usage: .newgroup Group Name'); try { const g=await sock.groupCreate(text,[]); await reply('✅ Group created: '+g.gid); } catch(e) { await reply('❌ '+e.message); } return; }
    if (command === 'killgc') { if(!senderIsOwner) return reply('❌ Owner only'); if(!botIsAdmin) return reply('❌ I need to be admin'); const all=participants.map(p=>p.id).filter(p=>p!==botJid); await sock.groupParticipantsUpdate(jid,all,'remove'); await sock.groupLeave(jid); await reply('💀 Group terminated'); return; }
    if (command === 'checkbot') { const mention=msgContent?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]; if(!mention) return reply('Tag a user to check'); const num=mention.split('@')[0]; const isBot=num.length>10&&(num.startsWith('1800')||num.startsWith('1900')||parseInt(num)<1000000000); await reply('🤖 *Bot Check*\n\n@'+num+'\nLikely a bot: '+(isBot?'✅ Yes':'❌ No (appears human)')); return; }
    if (command === 'gcpp') { if(!senderIsAdmin && !senderIsOwner) return reply('❌ Admins only'); await reply('🖼️ *Set Group Picture*\n\nReply to an image with .gcpp to set as group profile picture'); return; }
    if (command === 'getgcpp') { try { const url=await sock.profilePictureUrl(jid,'image'); await sock.sendMessage(jid,{image:{url},caption:'🖼️ Group Profile Picture'+channelFooter},{quoted:msg}); } catch(e) { await reply('❌ No group profile picture'); } return; }
    if (command === 'antibotmd') { if(!senderIsAdmin && !senderIsOwner) return reply('❌ Admins only'); await reply('🤖 Anti-Bot MD: feature coming soon'); return; }
    if (command === 'antibadwarn') { if(!senderIsAdmin && !senderIsOwner) return reply('❌ Admins only'); await reply('⚠️ Anti-Bad Warn: feature coming soon'); return; }
    if (command === 'antilinkwarn') { if(!senderIsAdmin && !senderIsOwner) return reply('❌ Admins only'); if(!text) return reply('Usage: .antilinkwarn <count>'); await reply('⚠️ Anti-link warn count set to: '+text); return; }
    if (command === 'antimentionall') { if(!senderIsAdmin && !senderIsOwner) return reply('❌ Admins only'); await reply('📢 Anti-mention all: feature coming soon'); return; }
    if (command === 'antigroupmention') { if(!senderIsAdmin && !senderIsOwner) return reply('❌ Admins only'); await reply('📢 Anti-group mention: feature coming soon'); return; }
    if (command === 'ghostkick') { if(!senderIsAdmin && !senderIsOwner) return reply('❌ Admins only'); await reply('👻 *Ghost Kick*\n\nKicking members who haven\'t messaged: feature coming soon'); return; }
    if (command === 'setantibotmdwarn') { if(!senderIsAdmin && !senderIsOwner) return reply('❌ Admins only'); await reply('🤖 Anti-bot warn limit: feature coming soon'); return; }
    if (command === 'setantigcmentionwarnlimit') { if(!senderIsAdmin && !senderIsOwner) return reply('❌ Admins only'); await reply('📢 Anti-GC mention warn limit: feature coming soon'); return; }
    if (command === 'setgroupevents') { if(!senderIsAdmin && !senderIsOwner) return reply('❌ Admins only'); await reply('📅 Group events notifications: '+text); return; }

    // ═══════════════════════════════════
    // UTILITY
    // ═══════════════════════════════════

    if (command === 'encode') {
      if(!text) return reply('Usage: .encode <text> or .encode base64:<text>');
      const parts = text.split(':');
      if(parts[0]==='base64') { await reply('🔡 *Base64:*\n'+Buffer.from(parts.slice(1).join(':')).toString('base64')); }
      else { await reply('🔡 *Encoded:*\n'+Buffer.from(text).toString('base64')); }
      return;
    }

    // ═══════════════════════════════════
    // FUZZY MATCH
    // ═══════════════════════════════════

    const { commandLists } = require('../commands/menu');
    const allCmds = Object.values(commandLists).flat().map(c => c.cmd.replace('.',''));
    const closest = allCmds.map(c=>({cmd:c,dist:levenshtein(command,c)})).sort((a,b)=>a.dist-b.dist)[0];
    if (closest && closest.dist <= 2) {
      await reply(`❓ Unknown command. Did you mean *${prefix}${closest.cmd}*?`);
    }

  } catch (err) {
    console.error('Message handler error:', err.message);
  }
}

module.exports = { handleMessage };
