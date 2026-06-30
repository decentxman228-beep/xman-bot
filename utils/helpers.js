const config = require('../config');

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

function jidToNum(jid) {
  return (jid || '').replace(/[^0-9]/g, '');
}

function isOwner(jid) {
  if (!jid) return false;
  return jidToNum(jid) === jidToNum(config.OWNER_NUMBER);
}

function isAdmin(participants, jid) {
  if (!participants || !jid) return false;
  const num = jidToNum(jid);
  return participants.some(p => {
    if (!p.admin) return false;
    if (p.id === jid) return true;
    if (p.phoneNumber && jidToNum(p.phoneNumber) === num) return true;
    if (jidToNum(p.id) === num) return true;
    return false;
  });
}

function isBotAdmin(participants, botJid) {
  return isAdmin(participants, botJid);
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] :
        1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

const channelFooter = `\n\n> 📢 *JOIN OUR CHANNEL*\n> ${config.CHANNEL_LINK}`;

module.exports = { formatUptime, jidToNum, isOwner, isAdmin, isBotAdmin, levenshtein, channelFooter };
