require('dotenv').config();

module.exports = {
  OWNER_NUMBER: process.env.OWNER_NUMBER || '2348168193070',
  BOT_NAME: process.env.BOT_NAME || 'ULTRA 𝖝𝖒𝖆𝖓𓅂',
  PREFIX: process.env.PREFIX || '.',
  MONGO_URI: process.env.MONGO_URI,
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  TELEGRAM_OWNER_ID: process.env.TELEGRAM_OWNER_ID,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  CHANNEL_LINK: process.env.CHANNEL_LINK || 'https://whatsapp.com/channel/0029VbCQAeELCoX94Jbmup42',
  CHANNEL_ID: process.env.CHANNEL_ID || '0029VbCQAeELCoX94Jbmup42',
  TELEGRAM_BOT_LINK: process.env.TELEGRAM_BOT_LINK || 'https://t.me/your_bot_username',
  VERSION: process.env.VERSION || 'v5.0.0',
  MODE: process.env.MODE || 'PUBLIC',
};
