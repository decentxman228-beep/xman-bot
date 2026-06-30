const config = require('../config');
const { categories, commandLists } = require('../commands/menu');

// Send interactive list menu (WhatsApp native list message)
async function sendListMenu(sock, jid, msg, pushName, uptime, totalCmds) {
  const sections = [{
    title: '📋 SELECT A CATEGORY',
    rows: categories.map(c => ({
      id: `menu_cat_${c.num}`,
      title: `${c.icon} ${c.name}`,
      description: `${c.count} commands — tap to view`,
    }))
  }];

  const listMsg = {
    listMessage: {
      title: `🤖 ULTRA 𝖝𝖒𝖆𝖓𓅂`,
      description:
        `👋 Hey ${pushName}!\n\n` +
        `📊 *${totalCmds} Commands* | ⚡ Prefix: *${config.PREFIX}*\n` +
        `⏱️ Uptime: *${uptime}* | 📦 ${config.VERSION}\n\n` +
        `Tap the button below to browse categories 👇`,
      buttonText: '📋 BROWSE CATEGORIES',
      footerText: `✨ Powered by DECENT TECH😎`,
      sections,
    }
  };

  try {
    await sock.sendMessage(jid, listMsg, { quoted: msg });
    return true;
  } catch (e) {
    console.log('List message failed:', e.message);
    return false;
  }
}

// Send category commands as list
async function sendCategoryList(sock, jid, msg, catNum) {
  const cat = categories.find(c => c.num === catNum);
  if (!cat) return false;
  const cmds = commandLists[catNum] || [];

  // Max 10 rows per section in WhatsApp
  const sections = [];
  const chunkSize = 10;
  for (let i = 0; i < cmds.length; i += chunkSize) {
    const chunk = cmds.slice(i, i + chunkSize);
    sections.push({
      title: i === 0 ? `${cat.icon} ${cat.name}` : `${cat.icon} Continued`,
      rows: chunk.map(c => ({
        id: `cmd_info_${c.cmd.replace('.', '')}`,
        title: c.cmd,
        description: c.desc.slice(0, 72),
      }))
    });
  }

  // Back button
  sections.push({
    title: '🔙 NAVIGATION',
    rows: [{
      id: 'nav_back_menu',
      title: '🔙 Back to Main Menu',
      description: 'Return to all categories'
    }]
  });

  try {
    await sock.sendMessage(jid, {
      listMessage: {
        title: `${cat.icon} ${cat.name} COMMANDS`,
        description: `📊 ${cmds.length} commands available\n⚡ Prefix: ${config.PREFIX}\n\nTap any command for usage info`,
        buttonText: `📋 VIEW ${cat.name} COMMANDS`,
        footerText: `✨ Powered by DECENT TECH😎`,
        sections,
      }
    }, { quoted: msg });
    return true;
  } catch (e) {
    console.log('Category list failed:', e.message);
    return false;
  }
}

// Show command info when user taps a command from the list
async function sendCommandInfo(sock, jid, msg, cmdName) {
  const allCmds = Object.values(commandLists).flat();
  const cmd = allCmds.find(c =>
    c.cmd === `.${cmdName}` ||
    c.cmd === cmdName ||
    c.cmd.replace('.', '') === cmdName
  );
  const desc = cmd ? cmd.desc : 'No description available';

  await sock.sendMessage(jid, {
    text:
      `╭───〔 *COMMAND INFO* 〕──────┈⊷\n` +
      `│\n` +
      `│ 📌 *Command:* ${config.PREFIX}${cmdName}\n` +
      `│ 📝 *Description:* ${desc}\n` +
      `│ ⚡ *Usage:* ${config.PREFIX}${cmdName} <args>\n` +
      `│\n` +
      `╰─────────────────────┈⊷\n\n` +
      `> 📢 *JOIN OUR CHANNEL*\n> ${config.CHANNEL_LINK}`
  }, { quoted: msg });
}

module.exports = { sendListMenu, sendCategoryList, sendCommandInfo };
