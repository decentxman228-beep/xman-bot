const mongoose = require('mongoose');
const { MONGO_URI } = require('../config');

const groupSchema = new mongoose.Schema({
  jid: { type: String, unique: true },
  welcome: { type: Boolean, default: false },
  goodbye: { type: Boolean, default: false },
  welcomeMsg: String,
  goodbyeMsg: String,
  antilink: { type: Boolean, default: false },
  antispam: { type: Boolean, default: false },
  antiBadWords: { type: Boolean, default: false },
  badWords: [String],
  warns: { type: Map, of: Number, default: {} },
  warnLimit: { type: Number, default: 3 },
  locked: { type: Boolean, default: false },
  lockedTypes: [String],
  shadowBanned: [String],
  autokickList: [String],
  antiflood: { type: Boolean, default: false },
  floodCount: { type: Number, default: 5 },
  slowMode: { type: Number, default: 0 },
  notes: { type: Map, of: String, default: {} },
  antiforeign: { type: Boolean, default: false },
  antisticker: { type: Boolean, default: false },
  antiviewonce: { type: Boolean, default: false },
  antiforward: { type: Boolean, default: false },
  lockdown: { type: Boolean, default: false },
  antidemote: { type: Boolean, default: false },
  antipromote: { type: Boolean, default: false },
});

const settingsSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  value: mongoose.Schema.Types.Mixed,
});

const Group = mongoose.model('Group', groupSchema);
const Settings = mongoose.model('Settings', settingsSchema);

async function connectDB() {
  await mongoose.connect(MONGO_URI);
  console.log('✅ MongoDB connected');
}

async function getGroup(jid) {
  let g = await Group.findOne({ jid });
  if (!g) { g = new Group({ jid }); await g.save(); }
  return g;
}

async function getSetting(key, fallback = null) {
  const s = await Settings.findOne({ key });
  return s ? s.value : fallback;
}

async function setSetting(key, value) {
  await Settings.findOneAndUpdate({ key }, { value }, { upsert: true, new: true });
}

module.exports = { connectDB, getGroup, getSetting, setSetting, Group, Settings };
