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
