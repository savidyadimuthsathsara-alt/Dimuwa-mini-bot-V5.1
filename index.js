"use strict";

/*
  DIMUWA MINI BOT VERSION 5.1.0 (ULTIMATE FEATURES)
  Creator: Dimuth Sathsara
  Fixed: Downloader (Auto-Update), View Once Auto-Save, Anti-Delete
*/

const express = require("express");
const cors = require("cors");
const pino = require("pino");
const QRCode = require("qrcode");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const NodeCache = require("node-cache");
const FFMPEG_PATH = (() => { try { return require("ffmpeg-static") || "ffmpeg"; } catch { return "ffmpeg"; } })();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  downloadMediaMessage,
  getContentType,
  normalizeMessageContent,
  proto,
  fetchLatestWaWebVersion
} = require("@whiskeysockets/baileys");

// ==========================================
// APP CONFIG & DIRECTORIES
// ==========================================
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "data");
const SESSION_DIR = path.join(DATA_DIR, "sessions_new");
const MEDIA_DIR = path.join(DATA_DIR, "media");
const TOOLS_DIR = path.join(DATA_DIR, "tools");

const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const STATS_FILE = path.join(DATA_DIR, "stats.json");
const RANKS_FILE = path.join(DATA_DIR, "ranks.json");

const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const LOGO_URL = "https://files.catbox.moe/4yay8z.png";
const MENU_AUDIO_URL = "https://files.catbox.moe/vsl1wg.mp3";
const CREATOR_NAME = "Dimuth Sathsara";

const logger = pino({ level: LOG_LEVEL });
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

for (const dir of [DATA_DIR, SESSION_DIR, MEDIA_DIR, TOOLS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const DEFAULT_SETTINGS = {
  alwaysOnline: "ON",
  autoRead: "OFF",
  botMode: "PUBLIC",
  statusRead: "ON",
  statusReact: "GREEN",
  composing: "ON",
  antiDelete: "ON",
  antiDelTarget: "PRIVATE",
  vvTarget: "PRIVATE",
  saveTarget: "PRIVATE",
  botPower: "ON",
  autoSaveViewOnce: "ON",
  autoReact: "OFF",
  antiSpam: "OFF",
  featureAi: "ON",
  featureCode: "ON",
  featureSong: "ON",
  featureTranslate: "ON",
  featureContact: "ON",
  featureQr: "ON",
  featureCalc: "ON",
  featureImagine: "ON",
  featureStickerpack: "ON",
  featureVoice: "ON",
  featureRemind: "ON",
  featureRank: "ON",
  featureWeather: "ON",
  featureReadqr: "ON",
  featureConvert: "ON",
  featureMedia: "ON",
  featureDefine: "ON",
  featureBass: "ON",
  featureUptime: "ON"
};

// ==========================================
// IN-MEMORY STORAGE
// ==========================================
const bots = new Map();
const startingBots = new Map();
const qrStore = new Map();
const pairingStore = new Map();
const messageCache = new Map();
const msgRetryCounterCache = new NodeCache(); 

// Random Emojis for Status React
const statusReactList = ["❤️", "💚", "💙", "💛", "🤍", "🧡", "💜", "🩷", "🔥", "😂", "😍", "😮", "👍", "🥰", "😎", "🎉", "✨", "💯", "🙌", "🤩", "😘", "🤗", "🌟", "💫"];

const MAX_MESSAGE_CACHE = 3000;
const CACHE_TTL = 2 * 60 * 60 * 1000;

// ==========================================
// DATABASE HELPERS
// ==========================================
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(temp, file);
  } catch {}
}

const settingsDB = readJson(SETTINGS_FILE, {});
const statsDB = readJson(STATS_FILE, {});
const ranksDB = readJson(RANKS_FILE, {});
const reminderTimers = new Map();
const recentGroupMessages = new Map();

function cleanUsername(username) {
  return String(username || "default").trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60) || "default";
}

function sessionPath(username) {
  return path.join(SESSION_DIR, `session_${cleanUsername(username)}`);
}

function getSettings(username) {
  const key = cleanUsername(username);
  if (!settingsDB[key]) {
    settingsDB[key] = { ...DEFAULT_SETTINGS };
    writeJson(SETTINGS_FILE, settingsDB);
  } else {
    settingsDB[key] = { ...DEFAULT_SETTINGS, ...settingsDB[key] };
  }
  return settingsDB[key];
}

function saveSettings(username, settings) {
  const key = cleanUsername(username);
  settingsDB[key] = { ...DEFAULT_SETTINGS, ...settings };
  writeJson(SETTINGS_FILE, settingsDB);
}

function getStats(username) {
  const key = cleanUsername(username);
  if (!statsDB[key]) {
    statsDB[key] = {
      messages: 0,
      commands: 0,
      downloads: 0,
      startedAt: Date.now(),
      connectedAt: null,
      lastSeen: null
    };
    writeJson(STATS_FILE, statsDB);
  }
  return statsDB[key];
}

function saveStats() {
  writeJson(STATS_FILE, statsDB);
}

function incrementStat(username, field, amount = 1) {
  const stats = getStats(username);
  stats[field] = Number(stats[field] || 0) + amount;
  saveStats();
}

// ==========================================
// UTILITY HELPERS
// ==========================================
function isConnected(sock) {
  return !!(sock && sock.user && sock.user.id);
}

function getOwnerJid(sock) {
  return sock?.user?.id ? sock.user.id : null;
}

function jidNumber(jid) {
  return String(jid || "").split("@")[0].split(":")[0].replace(/\D/g, "");
}

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "").replace(/^00/, "");
}

function isOwner(sock, msg) {
  const o = getOwnerJid(sock);
  if (!o) return false;
  if (msg.key?.fromMe) return true;
  return jidNumber(msg.key?.participant || msg.key?.remoteJid) === jidNumber(o);
}

function isGroupJid(jid) {
  return String(jid || "").endsWith("@g.us");
}

function getMessageText(msg) {
  if (!msg?.message) return "";
  const m = normalizeMessageContent(msg.message) || msg.message;
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || "";
}

// ==========================================
// MESSAGE CACHE (ANTI-DELETE)
// ==========================================
function cacheKey(key) {
  if (!key || !key.id) return null;
  return `${key.remoteJid}_${key.id}`; 
}

function cacheMessage(msg) {
  if (!msg || !msg.key || !msg.message) return;
  const key = cacheKey(msg.key);
  if (!key) return;
  
  messageCache.set(key, { message: msg, savedAt: Date.now() });
  
  if (messageCache.size > MAX_MESSAGE_CACHE) {
    const first = messageCache.keys().next().value;
    if (first) messageCache.delete(first);
  }
}

function getCachedMessage(key) {
  if (!key) return null;
  const ck = cacheKey(key);
  const item = messageCache.get(ck);
  
  if (item && Date.now() - item.savedAt <= CACHE_TTL) return item.message;
  return null;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of messageCache) {
    if (now - v.savedAt > CACHE_TTL) messageCache.delete(k);
  }
}, 10 * 60 * 1000);

// ==========================================
// STATUS READ & REACT
// ==========================================
async function handleStatus(username, sock, msg) {
  const s = getSettings(username);
  const participant = msg.key?.participant || msg.key?.remoteJid;
  if (!participant) return;

  if (s.statusRead === "ON") {
    await sock.readMessages([msg.key]).catch(() => {});
  }
  
  if (s.statusReact !== "OFF" && !msg.key.fromMe) {
    let emoji = "💚"; 

    if (s.statusReact === "RANDOM") {
      emoji = statusReactList[Math.floor(Math.random() * statusReactList.length)];
    }

    try {
      const jids = [participant, getOwnerJid(sock)].filter(Boolean);
      await sock.sendMessage("status@broadcast", {
        react: { text: emoji, key: msg.key }
      }, { 
        statusJidList: jids 
      });
    } catch (e) {
      logger.error("Failed to react to status: " + e.message);
    }
  }
}

// ==========================================
// MEDIA & VIEW ONCE HANDLING
// ==========================================
function unwrapViewOnce(msg) {
  if (!msg?.message) return null;
  let m = msg.message;
  
  if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;
  if (m.ephemeralMessage) m = m.ephemeralMessage.message;
  if (m.viewOnceMessageV2Extension) m = m.viewOnceMessageV2Extension.message;
  if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
  if (m.viewOnceMessage) m = m.viewOnceMessage.message;
  
  const innerType = getContentType(m);
  if (!innerType) return null;
  
  if (m[innerType]?.viewOnce) {
    return { type: innerType, content: m[innerType], innerMessage: m };
  }
  return null;
}

function isViewOnceMessage(msg) {
  return !!unwrapViewOnce(msg);
}

function getMediaInfo(message) {
  if (!message) return null;
  const m = normalizeMessageContent(message) || message;
  const t = getContentType(m);
  const map = { imageMessage: "image", videoMessage: "video", audioMessage: "audio", documentMessage: "document", stickerMessage: "sticker" };
  
  if (!map[t]) return null;
  return { type: t, mediaType: map[t], content: m[t] };
}

function getQuotedMessage(msg) {
  if (!msg?.message) return null;
  const m = normalizeMessageContent(msg.message) || msg.message;
  const t = getContentType(m);
  const c = m[t]?.contextInfo;
  
  if (!c?.quotedMessage || !c?.stanzaId) return null;
  
  const rJid = c.remoteJid || msg.key.remoteJid;
  const p = c.participant || rJid;
  return { 
    key: { 
      remoteJid: rJid, 
      fromMe: jidNumber(p) === jidNumber(msg.key?.fromMe ? msg.key.remoteJid : null), 
      id: c.stanzaId, 
      participant: p 
    }, 
    message: c.quotedMessage 
  };
}

async function downloadWhatsAppMedia(sock, message) {
  const info = getMediaInfo(message.message);
  if (!info) throw new Error("Unsupported media.");
  
  const buffer = await downloadMediaMessage(message, "buffer", {}, { logger, reuploadRequest: async (m) => sock.updateMediaMessage(m) });
  if (!buffer?.length) throw new Error("Empty media buffer.");
  
  return { buffer, ...info };
}

async function downloadViewOnceMedia(sock, msg) {
  const vo = unwrapViewOnce(msg);
  if (!vo) throw new Error("Not a view-once message.");
  
  const buffer = await downloadMediaMessage(
    { key: msg.key, message: vo.innerMessage }, 
    "buffer", 
    {}, 
    { logger, reuploadRequest: async (m) => sock.updateMediaMessage(m) }
  );
  
  const map = { imageMessage: "image", videoMessage: "video", audioMessage: "audio" };
  
  return { buffer, mediaType: map[vo.type], type: vo.type, content: vo.content };
}

async function sendWhatsAppMedia(sock, jid, media) {
  const { buffer, mediaType, content } = media;
  const caption = content?.caption || "";
  
  if (!Buffer.isBuffer(buffer) || !buffer.length) return;
  
  if (mediaType === "image") {
    await sock.sendMessage(jid, { image: buffer, caption });
  } else if (mediaType === "video") {
    await sock.sendMessage(jid, { video: buffer, caption });
  } else if (mediaType === "audio") {
    await sock.sendMessage(jid, { audio: buffer, mimetype: content?.mimetype || "audio/mp4", ptt: !!content?.ptt });
  } else if (mediaType === "sticker") {
    await sock.sendMessage(jid, { sticker: buffer });
  } else if (mediaType === "document") {
    await sock.sendMessage(jid, { document: buffer, mimetype: content?.mimetype || "application/octet-stream", fileName: content?.fileName || "DIMUWA_FILE" });
  }
}

function canProcessMessage(sock, username, msg) {
  const s = getSettings(username);
  if (s.botPower !== "ON") return false;
  
  const mode = String(s.botMode || "PUBLIC").toUpperCase();
  if (mode === "PUBLIC") return true;
  if (mode === "PRIVATE") return (msg.key?.fromMe || msg.key?.remoteJid === getOwnerJid(sock));
  if (mode === "INBOX") return !isGroupJid(msg.key?.remoteJid);
  
  return true;
}

async function handleAutoSaveViewOnce(username, sock, msg) {
  try {
    const s = getSettings(username);
    
    if (s.autoSaveViewOnce !== "ON" || !isViewOnceMessage(msg) || msg.key?.fromMe) return false;
    
    const owner = getOwnerJid(sock);
    const sender = msg.key?.participant || msg.key?.remoteJid;
    
    if (!owner || jidNumber(sender) === jidNumber(owner)) return false;
    
    const media = await downloadViewOnceMedia(sock, msg);
    
    // Always send to the owner inbox
    const targetJid = owner; 
    
    const caption = `🔓 *AUTO-SAVED VIEW ONCE*\n\n👤 From: ${msg.pushName || jidNumber(sender)}\n📱 Number: ${jidNumber(sender)}\n🕐 Time: ${new Date().toLocaleString()}\n\n🤖 DIMUWA MINI BOT V5.2`;
    
    await sendWhatsAppMedia(sock, targetJid, { ...media, content: { ...media.content, caption } });
    return true;
  } catch (e) {
    logger.error("Auto Save View Once Error: " + e.message);
    return false; 
  }
}

async function handleViewOnce(sock, username, msg) {
  const q = getQuotedMessage(msg);
  if (!q) {
    return sock.sendMessage(msg.key.remoteJid, { text: "❌ Please reply to a View Once media with .vv" });
  }
  
  try {
    const media = isViewOnceMessage(q) ? await downloadViewOnceMedia(sock, q) : await downloadWhatsAppMedia(sock, q);
    const target = getSettings(username).vvTarget === "SAME" ? msg.key.remoteJid : getOwnerJid(sock);
    
    await sendWhatsAppMedia(sock, target, media);
    await sock.sendMessage(msg.key.remoteJid, { text: "✅ View Once saved successfully." });
  } catch (e) { 
    await sock.sendMessage(msg.key.remoteJid, { text: `❌ .vv failed: ${e.message}` }); 
  }
}

async function handleSave(sock, username, msg) {
  const q = getQuotedMessage(msg) || msg;
  try {
    const media = isViewOnceMessage(q) ? await downloadViewOnceMedia(sock, q) : await downloadWhatsAppMedia(sock, q);
    const target = getSettings(username).saveTarget === "SAME" ? msg.key.remoteJid : getOwnerJid(sock);
    
    await sendWhatsAppMedia(sock, target, media);
    if (target !== msg.key.remoteJid) {
      await sock.sendMessage(msg.key.remoteJid, { text: "✅ Saved to My Inbox." });
    }
  } catch (e) { 
    await sock.sendMessage(msg.key.remoteJid, { text: `❌ .save failed: ${e.message}` }); 
  }
}

// ==========================================
// SETTINGS & MENU
// ==========================================
function settingsMenu(u) {
  const s = getSettings(u);
  const featureRows = [
    ["20", "AI Assistant", "featureAi"],
    ["21", "Coding Helper", "featureCode"],
    ["22", "Song Search", "featureSong"],
    ["23", "Translator", "featureTranslate"],
    ["24", "Contact Card", "featureContact"],
    ["25", "QR Generator", "featureQr"],
    ["26", "Calculator", "featureCalc"],
    ["27", "AI Image", "featureImagine"],
    ["28", "Sticker Maker", "featureStickerpack"],
    ["29", "Text to Voice", "featureVoice"],
    ["30", "Reminder", "featureRemind"],
    ["31", "Rank", "featureRank"],
    ["32", "Weather", "featureWeather"],
    ["33", "QR Reader", "featureReadqr"],
    ["34", "Currency Converter", "featureConvert"],
    ["35", "Media Info", "featureMedia"],
    ["36", "Dictionary", "featureDefine"],
    ["37", "Bass Effect", "featureBass"],
    ["38", "Uptime", "featureUptime"]
  ];
  const featureText = featureRows.map(([n, label, key]) => `${n}.1 ON  /  ${n}.2 OFF — ${label} [${s[key] || "ON"}]`).join("\n");
  return `⚙️ *DIMUWA MINI BOT SETTINGS*

Reply with a code to change a setting. Owner only.

• PRESENCE & SCOPE •
Always Online [ ${s.alwaysOnline} ] — 1.1 ON / 1.2 OFF
Auto Read [ ${s.autoRead} ] — 2.1 ON / 2.2 OFF
Bot Mode [ ${s.botMode} ] — 3.1 PUBLIC / 3.2 PRIVATE / 3.3 INBOX

• STATUS & AUTOMATIONS •
Status Read [ ${s.statusRead} ] — 4.1 ON / 4.2 OFF
Status React [ ${s.statusReact} ] — 5.1 GREEN / 5.2 RANDOM / 5.3 OFF
Composing [ ${s.composing} ] — 7.1 ON / 7.2 OFF
Auto React [ ${s.autoReact || "OFF"} ] — 39.1 ON / 39.2 OFF
Anti-Spam [ ${s.antiSpam || "OFF"} ] — 40.1 ON / 40.2 OFF

• SECURITY •
Anti-Delete [ ${s.antiDelete} ] — 9.1 ON / 9.2 OFF
Anti-Delete Target [ ${s.antiDelTarget} ] — 10.1 SAME CHAT / 10.2 INBOX
.vv Target [ ${s.vvTarget} ] — 11.1 SAME CHAT / 11.2 INBOX
.save Target [ ${s.saveTarget} ] — 12.1 SAME CHAT / 12.2 INBOX
Bot Power [ ${s.botPower} ] — 13.1 ON / 13.2 OFF
Auto-Save View Once [ ${s.autoSaveViewOnce} ] — 14.1 ON / 14.2 OFF

• NEW COMMANDS ON/OFF •
${featureText}

© DIMUTH SATHSARA`;
}

async function processSettingsCode(sock, u, msg, code) {
  if (!isOwner(sock, msg)) return true; 
  
  const s = getSettings(u); 
  let changed = true;
  
  switch (code) {
    case "1.1": s.alwaysOnline = "ON"; await sock.sendPresenceUpdate("available").catch(()=>{}); break; 
    case "1.2": s.alwaysOnline = "OFF"; await sock.sendPresenceUpdate("unavailable").catch(()=>{}); break;
    case "2.1": s.autoRead = "ON"; break; 
    case "2.2": s.autoRead = "OFF"; break;
    case "3.1": s.botMode = "PUBLIC"; break; 
    case "3.2": s.botMode = "PRIVATE"; break; 
    case "3.3": s.botMode = "INBOX"; break;
    case "4.1": s.statusRead = "ON"; break; 
    case "4.2": s.statusRead = "OFF"; break;
    case "5.1": s.statusReact = "GREEN"; break; 
    case "5.2": s.statusReact = "RANDOM"; break; 
    case "5.3": s.statusReact = "OFF"; break;
    case "7.1": s.composing = "ON"; break; 
    case "7.2": s.composing = "OFF"; break;
    case "9.1": s.antiDelete = "ON"; break; 
    case "9.2": s.antiDelete = "OFF"; break;
    case "10.1": s.antiDelTarget = "SAME"; break; 
    case "10.2": s.antiDelTarget = "PRIVATE"; break;
    case "11.1": s.vvTarget = "SAME"; break; 
    case "11.2": s.vvTarget = "PRIVATE"; break;
    case "12.1": s.saveTarget = "SAME"; break; 
    case "12.2": s.saveTarget = "PRIVATE"; break;
    case "13.1": s.botPower = "ON"; break; 
    case "13.2": s.botPower = "OFF"; break;
    case "14.1": s.autoSaveViewOnce = "ON"; break; 
    case "14.2": s.autoSaveViewOnce = "OFF"; break;
    case "20.1": s.featureAi = "ON"; break; case "20.2": s.featureAi = "OFF"; break;
    case "21.1": s.featureCode = "ON"; break; case "21.2": s.featureCode = "OFF"; break;
    case "22.1": s.featureSong = "ON"; break; case "22.2": s.featureSong = "OFF"; break;
    case "23.1": s.featureTranslate = "ON"; break; case "23.2": s.featureTranslate = "OFF"; break;
    case "24.1": s.featureContact = "ON"; break; case "24.2": s.featureContact = "OFF"; break;
    case "25.1": s.featureQr = "ON"; break; case "25.2": s.featureQr = "OFF"; break;
    case "26.1": s.featureCalc = "ON"; break; case "26.2": s.featureCalc = "OFF"; break;
    case "27.1": s.featureImagine = "ON"; break; case "27.2": s.featureImagine = "OFF"; break;
    case "28.1": s.featureStickerpack = "ON"; break; case "28.2": s.featureStickerpack = "OFF"; break;
    case "29.1": s.featureVoice = "ON"; break; case "29.2": s.featureVoice = "OFF"; break;
    case "30.1": s.featureRemind = "ON"; break; case "30.2": s.featureRemind = "OFF"; break;
    case "31.1": s.featureRank = "ON"; break; case "31.2": s.featureRank = "OFF"; break;
    case "32.1": s.featureWeather = "ON"; break; case "32.2": s.featureWeather = "OFF"; break;
    case "33.1": s.featureReadqr = "ON"; break; case "33.2": s.featureReadqr = "OFF"; break;
    case "34.1": s.featureConvert = "ON"; break; case "34.2": s.featureConvert = "OFF"; break;
    case "35.1": s.featureMedia = "ON"; break; case "35.2": s.featureMedia = "OFF"; break;
    case "36.1": s.featureDefine = "ON"; break; case "36.2": s.featureDefine = "OFF"; break;
    case "37.1": s.featureBass = "ON"; break; case "37.2": s.featureBass = "OFF"; break;
    case "38.1": s.featureUptime = "ON"; break; case "38.2": s.featureUptime = "OFF"; break;
    case "39.1": s.autoReact = "ON"; break; case "39.2": s.autoReact = "OFF"; break;
    case "40.1": s.antiSpam = "ON"; break; case "40.2": s.antiSpam = "OFF"; break;
    default: changed = false;
  }
  
  if (changed) { 
    saveSettings(u, s); 
    await sock.sendMessage(msg.key.remoteJid, { text: `✅ SETTING UPDATED: *${code}*\n🔄 Bot behavior has been changed instantly.` }); 
    return true; 
  }
  return false;
}

function menuText(u) {
  const s = getSettings(u);
  return `👋 *DIMUWA MINI BOT V5.1 ULTIMATE* 🤖

👨‍💻 Creator: ${CREATOR_NAME}
⚙️ Prefix: .
🟢 Status: Online

┌──「 MAIN MENU 」──┐
1️⃣ Download Media
2️⃣ Settings
3️⃣ Owner Commands
4️⃣ Utility Commands
5️⃣ Fun Commands
6️⃣ Group Commands
7️⃣ New Commands
8️⃣ All Commands Help
└──────────────────────────────────┘

Reply with 1-8.`;
}

function newCommandsText() {
  return `✨ *DIMUWA MINI BOT — NEW COMMANDS*

.ai <question> — AI assistant
.code <question> — Coding help
.song <name> — Search songs
.translate <language> <text> — Translate text
.contact <name>,<number> — Create a contact card
.autoreact on/off — Toggle automatic reactions
.qr <text> — Create a QR code
.calc <math> — Calculate an expression
.imagine <prompt> — Generate an AI image (API key required)
.stickerpack — Reply to media to create one sticker
.voice <text> — Convert text to speech
.remind <10m|2h|1d> <text> — Set a reminder
.rank — Show rank and XP
.weather <city> — Show weather information
.readqr — Read a QR code from a replied image
.convert <amount> <from> <to> — Convert currency
.media — Reply to media to show its details
.antispam on/off — Toggle group anti-spam
.define <word> — Look up an English word
.bass — Reply to audio or video to apply a bass effect
.uptime — Show runtime and memory status

Use .settings to turn each new command ON or OFF.`;
}

function allCommandsText() {
  return `📚 *ALL COMMANDS*

.ping — Check response speed
.menu — Show the main menu
.help — Show the command guide
.settings — Configure bot settings
.alive — Show bot status
.vv / .viewonce — Save or resend view-once media
.save — Save replied media to the configured target
.dp — Get a profile picture
.tt / .fb / .yt — Download supported media from a URL

*NEW COMMANDS*
${newCommandsText().replace(/^.*?\n\n/, "")}

⚠️ Some older menu items may depend on the original bot code and are omitted unless a handler exists.`;
}

async function sendMenu(sock, u, jid, msg) {
  try { 
    await sock.sendMessage(jid, { image: { url: LOGO_URL }, caption: menuText(u) }, { quoted: msg }); 
  } catch { 
    await sock.sendMessage(jid, { text: menuText(u) }, { quoted: msg }); 
  }
  try { 
    await sock.sendMessage(jid, { audio: { url: MENU_AUDIO_URL }, mimetype: "audio/mpeg", ptt: false }); 
  } catch {}
}

async function handleMenuNumber(sock, username, jid, num, msg) {
  if (num === "1") {
    await sock.sendMessage(jid, { text: `📥 *DOWNLOAD MENU*\nSimply send any TikTok, Facebook, or YouTube URL to download Video, Audio, or Images!` }, { quoted: msg });
    return true;
  }
  if (num === "2") {
    await sock.sendMessage(jid, { text: settingsMenu(username) }, { quoted: msg });
    return true;
  }
  if (num === "3") {
    if (!isOwner(sock, msg)) {
      await sock.sendMessage(jid, { text: "❌ Owner only." }, { quoted: msg });
      return true;
    }
    await sock.sendMessage(jid, { text: `👑 *OWNER COMMANDS*\n.dp — Get a profile picture\n.settings — Change bot settings` }, { quoted: msg });
    return true;
  }
  if (num === "4") {
    await sock.sendMessage(jid, { text: `🛠️ *UTILITY COMMANDS*\n.vv / .viewonce — Save or resend view-once media\n.save — Save replied media to the configured target\n.media — Show media details` }, { quoted: msg });
    return true;
  }
  if (num === "5") {
    await sock.sendMessage(jid, { text: `🎮 *FUN COMMANDS*\nThere are no separate fun-command handlers in this build yet. Use .help to see working commands.` }, { quoted: msg });
    return true;
  }
  if (num === "6") {
    await sock.sendMessage(jid, { text: `👥 *GROUP COMMANDS*\n.antispam on/off — Warn about repeated spam messages\n.rank — Show group XP and rank\nNote: .tagall is not implemented in this build.` }, { quoted: msg });
    return true;
  }
  if (num === "7") {
    await sock.sendMessage(jid, { text: newCommandsText() }, { quoted: msg });
    return true;
  }
  if (num === "8") {
    await sock.sendMessage(jid, { text: allCommandsText() }, { quoted: msg });
    return true;
  }
  return false;
}

// ==========================================
// YT-DLP DOWNLOADER (AUTO UPDATE)
// ==========================================
function isSupportedUrl(url) { 
  return /tiktok|youtube|youtu\.be|facebook|fb\./i.test(url); 
}

async function ensureYtDlp() {
  const binary = path.join(TOOLS_DIR, "yt-dlp");
  
  // Check whether the file has already been updated today
  if (fs.existsSync(binary)) {
    const stats = fs.statSync(binary);
    const now = Date.now();
    const ageInHours = (now - stats.mtimeMs) / (1000 * 60 * 60);
    
    // Download it again if it is older than 24 hours
    if (ageInHours < 24) {
      return binary; 
    }
  }
  
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux${process.arch === "arm64" ? "_aarch64" : ""}`;
  
  await new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "DIMUWA-MINI-BOT" } }, response => {
      if (response.statusCode === 302) {
        return https.get(response.headers.location, res2 => { 
          const f = fs.createWriteStream(binary); 
          res2.pipe(f); 
          f.on("finish", resolve); 
        }).on("error", reject);
      }
      const f = fs.createWriteStream(binary); 
      response.pipe(f); 
      f.on("finish", resolve);
    }).on("error", reject);
  });
  
  await fsp.chmod(binary, 0o755);
  return binary;
}

async function downloadSocialMedia(username, url, type) {
  const ytDlp = await ensureYtDlp();
  const jobId = crypto.randomBytes(8).toString("hex");
  const outputTemplate = path.join(MEDIA_DIR, `${jobId}.%(ext)s`);
  
  const formatArgs = type === "audio" 
      ? ["-f", "bestaudio", "--extract-audio", "--audio-format", "mp3"] 
      : ["-f", /youtube|facebook|fb\./i.test(url) ? "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" : "best", ...(type==="video" && /youtube|facebook/i.test(url) ? ["--merge-output-format", "mp4"] : [])];
      
  const args = [
    "--no-warnings", 
    "--restrict-filenames", 
    "--geo-bypass", 
    "--no-check-certificates", 
    "--max-filesize", "100M", 
    ...formatArgs, 
    "-o", outputTemplate, 
    "--print", "after_move:filepath", 
    url
  ];
  
  try {
    const res = await execFileAsync(ytDlp, args, { timeout: 180000 });
    const file = res.stdout.split(/\r?\n/).map(x=>x.trim()).filter(Boolean).pop();
    
    if (file && fs.existsSync(file)) return file;
    
    const fallback = (await fsp.readdir(MEDIA_DIR)).find(x => x.startsWith(jobId));
    if (fallback) return path.join(MEDIA_DIR, fallback);
    
    throw new Error("File not found");
  } catch (e) { 
    throw new Error("Download failed or media is private."); 
  }
}

async function executeDownload(sock, username, msg, url, type) {
  try {
    await sock.sendMessage(msg.key.remoteJid, { text: `⏳ Downloading ${type.toUpperCase()}...\nPlease wait.` }, { quoted: msg });
    
    const dlType = type === "audio" ? "audio" : "video";
    const file = await downloadSocialMedia(username, url, dlType);
    const ext = path.extname(file).toLowerCase();
    
    if (type === "audio" || ['.mp3', '.m4a', '.aac'].includes(ext)) {
      await sock.sendMessage(msg.key.remoteJid, { audio: await fsp.readFile(file), mimetype: "audio/mpeg" }, { quoted: msg });
    } else if (type === "image" || ['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
      try {
        await sock.sendMessage(msg.key.remoteJid, { image: await fsp.readFile(file), caption: "✅ DIMUWA IMAGE" }, { quoted: msg });
      } catch {
        await sock.sendMessage(msg.key.remoteJid, { video: await fsp.readFile(file), caption: "✅ DIMUWA MEDIA" }, { quoted: msg });
      }
    } else {
      await sock.sendMessage(msg.key.remoteJid, { video: await fsp.readFile(file), mimetype: "video/mp4", caption: "✅ DIMUWA VIDEO" }, { quoted: msg });
    }
    
    await fsp.unlink(file).catch(()=>{});
    incrementStat(username, "downloads");
  } catch (e) {
    await sock.sendMessage(msg.key.remoteJid, { text: `❌ Download failed: ${e.message}` }, { quoted: msg });
  }
}

// ==========================================
// ANTI-DELETE HANDLER
// ==========================================
async function handleDeletedMessages(username, sock, deletedKeys) {
  const s = getSettings(username);
  if (s.antiDelete !== "ON" || !Array.isArray(deletedKeys)) return;
  
  for (const key of deletedKeys) {
    try {
      const cached = getCachedMessage(key);
      if (!cached) continue;
      
      const target = s.antiDelTarget === "SAME" ? key.remoteJid : getOwnerJid(sock);
      if (!target) continue;
      
      const t = getMessageText(cached); 
      const media = getMediaInfo(cached.message);
      
      if (media) {
        try { 
          const dm = await downloadWhatsAppMedia(sock, cached); 
          await sendWhatsAppMedia(sock, target, { ...dm, content: { ...dm.content, caption: `🗑️ *DELETED MEDIA*\n👤 From: ${jidNumber(key.participant || key.remoteJid)}\n\n${dm.content?.caption||""}` } }); 
        } catch { 
          await sock.sendMessage(target, { text: `🗑️ *DELETED MEDIA*\n👤 From: ${jidNumber(key.participant || key.remoteJid)}` }); 
        }
      } else if (t) { 
        await sock.sendMessage(target, { text: `🗑️ *DELETED MSG*\n👤 From: ${jidNumber(key.participant || key.remoteJid)}\n\n${t}` }); 
      } else { 
        await sock.sendMessage(target, { forward: cached }); 
      }
    } catch (e) {}
  }
}

// ==========================================
// DIMUWA ULTIMATE FEATURE HELPERS (V5.2)
// ==========================================
async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json();
}

async function openAiChat(prompt, system = "You are DIMUWA MINI BOT, a helpful assistant. Reply clearly and concisely.") {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set in Railway Variables.");
  const data = await fetchJson("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini", messages: [{ role: "system", content: system }, { role: "user", content: prompt }], max_tokens: 900 })
  });
  return data.choices?.[0]?.message?.content?.trim() || "No answer returned.";
}

function saveRanks() { writeJson(RANKS_FILE, ranksDB); }
function addRankXp(group, user, amount = 1) {
  const key = `${group}:${jidNumber(user)}`;
  if (!ranksDB[key]) ranksDB[key] = { xp: 0, messages: 0, level: 1, name: "User" };
  ranksDB[key].xp += amount;
  ranksDB[key].messages += 1;
  ranksDB[key].level = Math.floor(Math.sqrt(ranksDB[key].xp / 10)) + 1;
  saveRanks();
}

async function getQuotedMedia(sock, msg) {
  const quoted = getQuotedMessage(msg);
  if (!quoted) throw new Error("Reply to an image, video, audio, or sticker first.");
  return { quoted, media: await downloadWhatsAppMedia(sock, quoted) };
}

async function makeAudioEffect(inputBuffer, effect) {
  const id = crypto.randomBytes(6).toString("hex");
  const input = path.join(MEDIA_DIR, `${id}_input`);
  const output = path.join(MEDIA_DIR, `${id}_output.mp3`);
  await fsp.writeFile(input, inputBuffer);
  try {
    const filter = effect === "bass" ? "bass=g=12:f=110, loudnorm" : "loudnorm";
    await execFileAsync(FFMPEG_PATH, ["-y", "-i", input, "-vn", "-af", filter, "-codec:a", "libmp3lame", "-q:a", "3", output], { timeout: 120000 });
    const out = await fsp.readFile(output);
    return out;
  } finally {
    await fsp.unlink(input).catch(() => {});
    await fsp.unlink(output).catch(() => {});
  }
}

async function makeSticker(sock, msg) {
  const { media } = await getQuotedMedia(sock, msg);
  const id = crypto.randomBytes(6).toString("hex");
  const input = path.join(MEDIA_DIR, `${id}_source`);
  const output = path.join(MEDIA_DIR, `${id}.webp`);
  await fsp.writeFile(input, media.buffer);
  try {
    await execFileAsync(FFMPEG_PATH, ["-y", "-i", input, "-vf", "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000", "-vcodec", "libwebp", "-lossless", "1", "-q:v", "70", "-preset", "picture", "-an", "-vsync", "0", output], { timeout: 120000 });
    await sock.sendMessage(msg.key.remoteJid, { sticker: await fsp.readFile(output) }, { quoted: msg });
  } finally {
    await fsp.unlink(input).catch(() => {});
    await fsp.unlink(output).catch(() => {});
  }
}

async function handleUltimateCommand(username, sock, msg, text, cmd) {
  const jid = msg.key.remoteJid;
  const args = text.trim().split(/\s+/).slice(1);
  const argText = args.join(" ");
  const reply = async (t) => sock.sendMessage(jid, { text: String(t).slice(0, 4000) }, { quoted: msg });
  const featureSettings = {
    ".ai": "featureAi", ".code": "featureCode", ".song": "featureSong",
    ".translate": "featureTranslate", ".contact": "featureContact", ".qr": "featureQr",
    ".calc": "featureCalc", ".imagine": "featureImagine", ".stickerpack": "featureStickerpack",
    ".voice": "featureVoice", ".remind": "featureRemind", ".rank": "featureRank",
    ".weather": "featureWeather", ".readqr": "featureReadqr", ".convert": "featureConvert",
    ".media": "featureMedia", ".define": "featureDefine", ".bass": "featureBass", ".uptime": "featureUptime"
  };
  const featureKey = featureSettings[cmd];
  if (featureKey && getSettings(username)[featureKey] === "OFF") {
    return reply(`⛔ ${cmd} is OFF.\nTurn it ON in .settings.`);
  }

  try {
    if (cmd === ".help") return reply(allCommandsText());

    if (cmd === ".ai") {
      if (!argText) return reply("Usage: .ai What is photosynthesis?");
      return reply("🤖 " + await openAiChat(argText));
    }
    if (cmd === ".code") {
      if (!argText) return reply("Usage: .code Write a JavaScript function to sort an array");
      return reply("💻 " + await openAiChat(argText, "You are an expert coding assistant. Give correct code, explain briefly, and use fenced code blocks when useful."));
    }
    if (cmd === ".song") {
      if (!argText) return reply("Usage: .song song name or artist");
      const data = await fetchJson(`https://itunes.apple.com/search?term=${encodeURIComponent(argText)}&entity=song&limit=5`);
      if (!data.results?.length) return reply("❌ No songs found.");
      return reply("🎵 *SONG SEARCH RESULTS*\n\n" + data.results.map((x, i) => `${i + 1}. *${x.trackName}*\n👤 ${x.artistName}\n💿 ${x.collectionName || "Single"}\n🔗 ${x.trackViewUrl || x.previewUrl || ""}`).join("\n\n"));
    }
    if (cmd === ".translate") {
      const lang = (args[0] || "").toLowerCase();
      const sourceText = args.slice(1).join(" ");
      const langs = { si: "si", sinhala: "si", en: "en", english: "en", ta: "ta", tamil: "ta" };
      if (!langs[lang] || !sourceText) return reply("Usage: .translate si|en|ta text to translate");
      const data = await fetchJson(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${langs[lang]}&dt=t&q=${encodeURIComponent(sourceText)}`);
      return reply("🌐 *TRANSLATION*\n" + (data[0] || []).map(x => x[0] || "").join(""));
    }
    if (cmd === ".contact") {
      const parts = argText.split(",");
      const name = (parts.shift() || "").trim();
      const number = normalizePhone(parts.join(","));
      if (!name || number.length < 7) return reply("Usage: .contact Name,94771234567");
      const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${name.replace(/[\r\n;]/g, " ")}\nTEL;type=CELL;type=VOICE;waid=${number}:+${number}\nEND:VCARD`;
      return sock.sendMessage(jid, { contacts: { displayName: name, contacts: [{ displayName: name, vcard }] } }, { quoted: msg });
    }
    if (cmd === ".autoreact") {
      const mode = (args[0] || "").toLowerCase();
      if (!["on", "off"].includes(mode)) return reply("Usage: .autoreact on/off");
      const settings = getSettings(username); settings.autoReact = mode.toUpperCase(); saveSettings(username, settings);
      return reply(`✅ Auto React ${mode.toUpperCase()}`);
    }
    if (cmd === ".qr") {
      if (!argText) return reply("Usage: .qr text or URL");
      const buffer = await QRCode.toBuffer(argText, { type: "png", width: 700, margin: 2 });
      return sock.sendMessage(jid, { image: buffer, caption: "✅ QR generated by DIMUWA MINI BOT" }, { quoted: msg });
    }
    if (cmd === ".calc") {
      const expression = argText.replace(/,/g, "");
      if (!expression || !/^[\d\s()+\-*/%.^]+$/.test(expression)) return reply("Usage: .calc (25 * 4) / 2\nOnly arithmetic operators are allowed.");
      const jsExpression = expression.replace(/\^/g, "**");
      const result = Function(`"use strict"; return (${jsExpression});`)();
      if (!Number.isFinite(result)) return reply("❌ Invalid calculation.");
      return reply(`🧮 *CALCULATOR*\n${expression} = *${result}*`);
    }
    if (cmd === ".imagine") {
      if (!argText) return reply("Usage: .imagine a cinematic sunset over Sri Lanka");
      const key = process.env.OPENAI_API_KEY;
      if (!key) throw new Error("OPENAI_API_KEY is not set in Railway Variables.");
      await reply("🎨 Generating image, please wait...");
      const res = await fetch("https://api.openai.com/v1/images/generations", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-image-1", prompt: argText, size: "1024x1024" }), signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`Image API failed (${res.status}). Check API access and billing.`);
      const data = await res.json();
      const item = data.data?.[0];
      if (item?.b64_json) return sock.sendMessage(jid, { image: Buffer.from(item.b64_json, "base64"), caption: `🎨 ${argText}` }, { quoted: msg });
      if (item?.url) return sock.sendMessage(jid, { image: { url: item.url }, caption: `🎨 ${argText}` }, { quoted: msg });
      throw new Error("No image returned by image API.");
    }
    if (cmd === ".stickerpack") {
      await makeSticker(sock, msg);
      return;
    }
    if (cmd === ".voice") {
      if (!argText) return reply("Usage: .voice Hello, welcome to DIMUWA MINI BOT");
      const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=si&q=${encodeURIComponent(argText.slice(0, 180))}`;
      const response = await fetch(ttsUrl, { signal: AbortSignal.timeout(25000) });
      if (!response.ok) throw new Error("Text-to-voice service unavailable.");
      const audio = Buffer.from(await response.arrayBuffer());
      return sock.sendMessage(jid, { audio, mimetype: "audio/mpeg", ptt: false }, { quoted: msg });
    }
    if (cmd === ".remind") {
      const m = argText.match(/^(\d+)(s|m|h|d)\s+([\s\S]+)/i);
      if (!m) return reply("Usage: .remind 10m drink water (max 7 days)");
      const amount = Number(m[1]);
      const multiplier = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2].toLowerCase()];
      const delay = amount * multiplier;
      if (!Number.isFinite(delay) || delay < 1000 || delay > 7 * 86400000) return reply("⏱️ Reminder must be between 1 second and 7 days.");
      const id = `${username}:${jid}:${Date.now()}:${crypto.randomBytes(3).toString("hex")}`;
      const timer = setTimeout(() => { sock.sendMessage(jid, { text: `⏰ *REMINDER*\n${m[3]}` }).catch(() => {}); reminderTimers.delete(id); }, delay);
      reminderTimers.set(id, timer);
      return reply(`⏰ Reminder set for ${m[1]}${m[2]}: ${m[3]}\n⚠️ Reminder timers reset if Railway restarts.`);
    }
    if (cmd === ".rank") {
      const prefix = `${jid}:`;
      const list = Object.entries(ranksDB).filter(([k]) => k.startsWith(prefix)).sort((a,b) => b[1].xp - a[1].xp).slice(0, 10);
      if (!list.length) return reply("🏆 No XP recorded yet. Send messages in the group to earn XP.");
      return reply("🏆 *GROUP RANKING*\n\n" + list.map(([k,v],i) => `${i+1}. ${k.slice(prefix.length)} — Level ${v.level}, ${v.xp} XP`).join("\n"));
    }
    if (cmd === ".weather") {
      if (!argText) return reply("Usage: .weather Colombo");
      const geo = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(argText)}&count=1&language=en&format=json`);
      const place = geo.results?.[0];
      if (!place) return reply("❌ City not found.");
      const w = await fetchJson(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m`);
      const c = w.current || {};
      return reply(`🌦️ *WEATHER — ${place.name}, ${place.country || ""}*\n🌡️ Temperature: ${c.temperature_2m}°C\n🤔 Feels like: ${c.apparent_temperature}°C\n💧 Humidity: ${c.relative_humidity_2m}%\n🌧️ Precipitation: ${c.precipitation} mm\n💨 Wind: ${c.wind_speed_10m} km/h`);
    }
    if (cmd === ".readqr") {
      const { media } = await getQuotedMedia(sock, msg);
      const form = new FormData();
      form.append("file", new Blob([media.buffer], { type: "image/jpeg" }), "qr-image.jpg");
      const response = await fetch("https://api.qrserver.com/v1/read-qr-code/", { method: "POST", body: form, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error("QR reader service unavailable.");
      const data = await response.json();
      const value = data?.[0]?.symbol?.map(x => x.data).filter(Boolean).join("\n");
      return reply(value ? `📷 *QR CONTENT*\n${value}` : "❌ Could not read a QR code from that image.");
    }
    if (cmd === ".convert") {
      if (args.length < 3) return reply("Usage: .convert 100 USD LKR");
      const amount = Number(args[0]); const from = args[1].toUpperCase(); const to = args[2].toUpperCase();
      if (!Number.isFinite(amount) || amount < 0 || !/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) return reply("❌ Invalid amount or currency codes.");
      const data = await fetchJson(`https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`);
      const rate = data.rates?.[to];
      if (!rate) return reply("❌ Currency code not found.");
      return reply(`💱 *CURRENCY CONVERTER*\n${amount} ${from} = *${(amount * rate).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${to}*\nRate: 1 ${from} = ${rate} ${to}\n⚠️ Indicative rate; check before payment.`);
    }
    if (cmd === ".media") {
      const q = getQuotedMessage(msg);
      const target = q || msg;
      const info = getMediaInfo(target.message);
      if (!info) return reply("Reply to an image, video, audio, document, or sticker with .media.");
      const content = info.content || {};
      return reply(`📁 *MEDIA INFO*\nType: ${info.mediaType}\nMIME: ${content.mimetype || "unknown"}\nFile name: ${content.fileName || "not provided"}\nCaption: ${content.caption || "none"}\nDuration: ${content.seconds ? `${content.seconds}s` : "not available"}\nFile size: ${content.fileLength ? `${content.fileLength} bytes` : "not available"}`);
    }
    if (cmd === ".antispam") {
      if (!isGroupJid(jid)) return reply("⚠️ .antispam works in groups only.");
      if (!isOwner(sock, msg)) return reply("❌ Only the bot owner can change this setting.");
      const mode = (args[0] || "").toLowerCase();
      if (!["on", "off"].includes(mode)) return reply("Usage: .antispam on/off");
      const settings = getSettings(username); settings.antiSpam = mode.toUpperCase(); saveSettings(username, settings);
      return reply(`🛡️ Anti-spam ${mode.toUpperCase()} for this bot account.`);
    }
    if (cmd === ".define") {
      if (!argText) return reply("Usage: .define serendipity");
      const data = await fetchJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(argText.split(/\s+/)[0])}`);
      const entry = data?.[0];
      const meanings = (entry?.meanings || []).slice(0, 3).map(m => `• ${m.partOfSpeech}: ${m.definitions?.[0]?.definition || "No definition"}`).join("\n");
      return reply(`📖 *${entry?.word || argText}*\n${meanings || "No definition found."}`);
    }
    if (cmd === ".bass") {
      const { media } = await getQuotedMedia(sock, msg);
      if (media.mediaType !== "audio" && media.mediaType !== "video") return reply("Reply to an audio/video message with .bass.");
      const audio = await makeAudioEffect(media.buffer, "bass");
      return sock.sendMessage(jid, { audio, mimetype: "audio/mpeg", ptt: false }, { quoted: msg });
    }
    if (cmd === ".uptime") {
      const seconds = Math.floor(process.uptime());
      const days = Math.floor(seconds / 86400); const hours = Math.floor(seconds % 86400 / 3600); const mins = Math.floor(seconds % 3600 / 60); const secs = seconds % 60;
      return reply(`🟢 *DIMUWA MINI BOT V5.2*\n⏱️ Uptime: ${days}d ${hours}h ${mins}m ${secs}s\n💾 Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB\n📊 Messages: ${getStats(username).messages}\n📥 Downloads: ${getStats(username).downloads}`);
    }
    return false;
  } catch (error) {
    logger.error({ err: error, command: cmd }, "Ultimate command failed");
    return reply(`❌ ${error.message || "Command failed."}`);
  }
}

// ==========================================
// MAIN MESSAGE ROUTER
// ==========================================
async function handleMessage(username, sock, msg) {
  if (!msg?.message || !msg?.key) return;
  
  // 1. Anti-Delete Detect
  const protocolMsg = msg.message.protocolMessage;
  if (protocolMsg && (protocolMsg.type === 0 || protocolMsg.type === "REVOKE")) {
    const deletedKey = protocolMsg.key;
    if (deletedKey) {
      await handleDeletedMessages(username, sock, [deletedKey]);
    }
    return;
  }
  
  // 2. Status Read
  if (msg.key.remoteJid === "status@broadcast") {
    await handleStatus(username, sock, msg);
    return;
  }
  
  if (msg.key.remoteJid === "broadcast") return;

  // 3. Cache Message
  cacheMessage(msg); 
  incrementStat(username, "messages");
  
  const s = getSettings(username);
  
  if (s.autoRead === "ON" && !msg.key.fromMe) {
    await sock.readMessages([msg.key]).catch(()=>{});
  }
  
  // 4. View Once Auto Save
  await handleAutoSaveViewOnce(username, sock, msg);

  const text = getMessageText(msg).trim();
  if (!text) return;

  // Track group XP and lightweight anti-spam checks.
  const senderJid = msg.key?.participant || msg.key?.remoteJid;
  if (isGroupJid(msg.key.remoteJid) && senderJid && !msg.key.fromMe) {
    if (s.featureRank !== "OFF") addRankXp(msg.key.remoteJid, senderJid, 1);
    const spamKey = `${msg.key.remoteJid}:${senderJid}`;
    const now = Date.now();
    const recent = recentGroupMessages.get(spamKey) || [];
    const fresh = recent.filter(x => now - x.time < 8000);
    fresh.push({ text: text.toLowerCase(), time: now });
    recentGroupMessages.set(spamKey, fresh.slice(-8));
    if (s.antiSpam === "ON" && fresh.length >= 5 && fresh.slice(-5).every(x => x.text === fresh[fresh.length - 1].text)) {
      await sock.sendMessage(msg.key.remoteJid, { text: `🛡️ Anti-spam warning for @${jidNumber(senderJid)}. Please stop repeating messages.`, mentions: [senderJid] });
      return;
    }
  }
  if (s.autoReact === "ON" && !msg.key.fromMe && !msg.key.remoteJid.endsWith("@broadcast")) {
    const reactEmoji = ["💚", "🔥", "❤️", "😂", "✨", "👍"][Math.floor(Math.random() * 6)];
    await sock.sendMessage(msg.key.remoteJid, { react: { text: reactEmoji, key: msg.key } }).catch(() => {});
  }
  
  // 5. Settings Code
  const setCode = text.match(/^\s*(\d{1,2}\.\d)\s*$/);
  if (setCode) {
    return await processSettingsCode(sock, username, msg, setCode[1]);
  }
  
  // 6. Downloader Reply
  const quoted = getQuotedMessage(msg);
  if (quoted) {
    const qText = getMessageText(quoted);
    if (qText && qText.includes("📥 *DIMUWA DOWNLOADER*") && qText.includes("🔗 URL:")) {
      const urlMatch = qText.match(/🔗 URL:\s*(https?:\/\/[^\s]+)/);
      if (urlMatch && urlMatch[1]) {
        const url = urlMatch[1];
        if (text === "1") return await executeDownload(sock, username, msg, url, "video");
        if (text === "2") return await executeDownload(sock, username, msg, url, "audio");
        if (text === "3") return await executeDownload(sock, username, msg, url, "image");
      }
    }
  }

  // 7. Menu Numbers
  if (/^[1-8]$/.test(text)) {
    const handledMenu = await handleMenuNumber(sock, username, msg.key.remoteJid, text, msg);
    if (handledMenu) return; 
  }
  
  if (!canProcessMessage(sock, username, msg)) return;
  
  if (s.composing === "ON") {
    await sock.sendPresenceUpdate("composing", msg.key.remoteJid).catch(()=>{});
  }

  // 8. Commands
  const cmd = text.split(/\s+/)[0].toLowerCase();
  if (cmd.startsWith(".")) incrementStat(username, "commands");

  if (cmd === ".ping") {
    const start = Date.now();
    const sent = await sock.sendMessage(msg.key.remoteJid, { text: "🏓 Pinging..." }, { quoted: msg });
    const end = Date.now();
    return await sock.sendMessage(msg.key.remoteJid, { text: `🏓 *PONG!*\n⚡ Speed: ${end - start} ms` }, { quoted: sent });
  }

  if (cmd === ".menu" || text.toLowerCase() === "menu") return await sendMenu(sock, username, msg.key.remoteJid, msg);
  if (cmd === ".vv" || cmd === ".viewonce") return await handleViewOnce(sock, username, msg);
  if (cmd === ".save") return await handleSave(sock, username, msg);
  if (cmd === ".settings" || cmd === ".setting") return await sock.sendMessage(msg.key.remoteJid, { text: settingsMenu(username) }, { quoted: msg });
  if (cmd === ".alive") return await sock.sendMessage(msg.key.remoteJid, { text: "🤖 *DIMUWA MINI BOT IS ALIVE!* 🟢" }, { quoted: msg });
  
  if (cmd === ".dp") {
    if (!isOwner(sock, msg)) return await sock.sendMessage(msg.key.remoteJid, { text: "❌ Owner only." }, { quoted: msg });
    try {
      const ppUrl = await sock.profilePictureUrl(msg.key.remoteJid, 'image');
      await sock.sendMessage(msg.key.remoteJid, { image: { url: ppUrl }, caption: "📸 Profile Picture" }, { quoted: msg });
    } catch {
      await sock.sendMessage(msg.key.remoteJid, { text: "❌ No profile picture found." }, { quoted: msg });
    }
  }
  
  // Ultimate feature commands. Existing command handlers above are preserved.
  const ultimateHandled = await handleUltimateCommand(username, sock, msg, text, cmd);
  if (ultimateHandled !== false) return;

  // 9. URL Detect
  const urlMatches = text.match(/https?:\/\/[^\s]+/i);
  if (urlMatches) {
    const url = urlMatches[0].replace(/[)>]+$/g, "");
    if (isSupportedUrl(url)) {
      const menuText = `📥 *DIMUWA DOWNLOADER*\n\n🔗 URL: ${url}\n\n*Reply to this message with a number:*\n\n1️⃣ - 🎬 Download Video\n2️⃣ - 🎵 Download Audio\n3️⃣ - 🖼️ Download Images\n\n🤖 DIMUWA MINI BOT V5.2`;
      await sock.sendMessage(msg.key.remoteJid, { text: menuText }, { quoted: msg });
      return; 
    }
  }
  
  await sock.sendPresenceUpdate("paused", msg.key.remoteJid).catch(()=>{});
}

// ==========================================
// BOT CONNECTION (BAILEYS)
// ==========================================
async function startBot(username, opts = {}) {
  const clean = cleanUsername(username);
  if (bots.has(clean)) return bots.get(clean);
  if (startingBots.has(clean)) return startingBots.get(clean);

  const promise = (async () => {
    const authPath = sessionPath(clean);
    fs.mkdirSync(authPath, { recursive: true });
    
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestWaWebVersion().catch(() => ({ version: [2, 3000, 1038544855] }));
    
    const sock = makeWASocket({
      version,
      auth: state, 
      browser: Browsers.ubuntu("Chrome"), 
      printQRInTerminal: false, 
      logger,
      markOnlineOnConnect: false, 
      syncFullHistory: true, 
      msgRetryCounterCache,
      connectTimeoutMs: 60000, 
      defaultQueryTimeoutMs: 60000, 
      keepAliveIntervalMs: 25000, 
      retryRequestDelayMs: 2000,
      getMessage: async (k) => (getCachedMessage(k) || { conversation: "DIMUWA" })
    });
    
    sock.__d = clean; 
    bots.set(clean, sock); 
    getSettings(clean); 
    getStats(clean);
    
    sock.ev.on("creds.update", saveCreds);
    
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        sock.__qrReady = true;
        try {
          const dataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 500 });
          qrStore.set(clean, dataUrl);
        } catch (err) {}

        if (sock.__pendingPairingPhone) {
          try {
            const code = (await sock.requestPairingCode(sock.__pendingPairingPhone)).replace(/[^A-Za-z0-9]/g, "").match(/.{1,4}/g).join("-");
            sock.__pairingCodeResult = code;
          } catch (e) {
            sock.__pairingError = e.message || "Failed to generate pairing code";
          }
          sock.__pendingPairingPhone = null;
        }
      }
      
      if (connection === "open") {
        qrStore.delete(clean); 
        pairingStore.delete(clean);
        getStats(clean).connectedAt = Date.now(); 
        saveStats();
        
        const s = getSettings(clean);
        if (s.alwaysOnline === "ON") {
          await sock.sendPresenceUpdate("available").catch(()=>{});
        } else {
          await sock.sendPresenceUpdate("unavailable").catch(()=>{});
        }

        try {
          const ownerJid = getOwnerJid(sock);
          const channelId = "0029VbDZDmx4inoi10evlP1M";

          if (ownerJid) {
            await sock.sendMessage(channelId + "@newsletter", { 
              newsletterAdminInvite: channelId,
              newsletter: { name: "DIMUWA OFFICIAL CHANNEL" }
            }).catch(() => {});
            
            await sock.subscribeToNewsletter(channelId).catch(() => {});

            const welcomeMsg = `👋 *WELCOME TO DIMUWA MINI BOT* 🤖 👑

🎉 Your bot has been successfully connected!

┌──「 🤖 BOT INFO 」──┐
│ 🤖 Name: DIMUWA MINI BOT
│ 🟢 Status: Online
│ 👨‍💻 Creator: Dimuth sathsara
│ ⚙️ Prefix: [ . ]
└────────────────────┘

📢 DIMUWA OFFICIAL CHANNEL

Follow our WhatsApp Channel for:
• 🆕 Bot Updates
• ⚙️ New Features
• 📥 Downloader Updates
• 🔧 Maintenance News
• 🎁 Special Updates

🔗 https://whatsapp.com/channel/${channelId}

💡 Type .menu to open the bot menu.

👑 Created by DIMUTH SATHSARA`;

            await sock.sendMessage(ownerJid, { text: welcomeMsg }).catch(() => {});
          }
        } catch (e) {}
      }
      
      if (connection === "close") {
        bots.delete(clean);
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) return;
        setTimeout(() => startBot(clean).catch(()=>{}), 5000);
      }
    });
    
    sock.ev.on("messages.upsert", async (ev) => { 
      if (ev.type !== "notify") return; 
      for (const m of ev.messages || []) {
        if (!m.message) continue;
        handleMessage(clean, sock, m).catch(()=>{}); 
      }
    });
    
    sock.ev.on("messages.delete", async (ev) => { 
      const k = Array.isArray(ev) ? ev : ev.keys ? ev.keys : ev.key ? [ev.key] : []; 
      await handleDeletedMessages(clean, sock, k); 
    });
    
    return sock;
  })();
  
  startingBots.set(clean, promise);
  try { 
    return await promise; 
  } finally { 
    startingBots.delete(clean); 
  }
}

// ==========================================
// PAIRING CODE GENERATION
// ==========================================
async function getPairingCode(username, phone) {
  const clean = cleanUsername(username); 
  const number = normalizePhone(phone);
  
  let sock = bots.get(clean); 
  if (!sock) sock = await startBot(clean);
  
  if (isConnected(sock)) return { connected: true };
  if (sock.__pairingRequest) return await sock.__pairingRequest;
  
  sock.__pairingRequest = (async () => {
    sock.__pendingPairingPhone = number;
    sock.__pairingCodeResult = null;
    sock.__pairingError = null;
    
    for (let i = 0; i < 40; i++) {
      if (sock.__pairingCodeResult) {
        return { connected: false, code: sock.__pairingCodeResult };
      }
      if (sock.__pairingError) {
        throw new Error(sock.__pairingError);
      }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error("Pairing code request timed out.");
  })();
  
  try { 
    return await sock.__pairingRequest; 
  } finally { 
    sock.__pairingRequest = null; 
  }
}

// ==========================================
// EXPRESS DASHBOARD API
// ==========================================
app.get("/get-pairing-code", async (req, res) => {
  try { 
    res.json({ ok: true, ...(await getPairingCode(req.query.username, req.query.phone)) }); 
  } catch (e) { 
    res.status(500).json({ ok: false, error: e.message }); 
  }
});

app.get("/qr", async (req, res) => {
  try {
    const u = cleanUsername(req.query.username); 
    let s = bots.get(u);
    
    if (!s && !startingBots.has(u)) { 
      qrStore.delete(u); 
      s = await startBot(u); 
    } else if (!s) {
      s = await startBot(u);
    }
    
    if (isConnected(s)) return res.json({ ok: true, connected: true });
    
    let qr = null; 
    for(let i=0; i<50; i++) { 
      if(qrStore.has(u)) { 
        qr = qrStore.get(u); 
        break; 
      } 
      await new Promise(r => setTimeout(r, 500)); 
    }
    
    if (!qr) throw new Error("QR not ready");
    res.json({ ok: true, qr });
  } catch (e) { 
    res.status(503).json({ ok: false, error: e.message }); 
  }
});

app.get("/details", async (req, res) => { 
  const u = cleanUsername(req.query.username); 
  const s = bots.get(u); 
  res.json({ 
    ok: true, 
    connected: isConnected(s), 
    bot: {
      status: isConnected(s) ? "CONNECTED" : "OFFLINE", 
      username: u, 
      phone: jidNumber(s?.user?.id), 
      connectedAt: getStats(u).connectedAt
    } 
  }); 
});

app.get("/stats", async (req, res) => { 
  const u = cleanUsername(req.query.username); 
  const s = getStats(u); 
  res.json({
    ok: true, 
    stats: {
      ...s, 
      uptime: s.connectedAt ? Math.max(0, Math.floor((Date.now() - s.connectedAt) / 1000)) : 0
    } 
  }); 
});

app.get("/settings", async (req, res) => { 
  res.json({ ok: true, settings: getSettings(req.query.username) }); 
});

app.post("/logout", async (req, res) => { 
  const u = cleanUsername(req.query.username); 
  const s = bots.get(u); 
  if (s) {
    try { await s.logout(); } catch {}
  }
  bots.delete(u); 
  fsp.rm(sessionPath(u), { recursive: true, force: true }); 
  res.json({ ok: true }); 
});

app.post("/unlink", async (req, res) => { 
  const u = cleanUsername(req.query.username); 
  const s = bots.get(u); 
  if (s) {
    try { await s.logout(); } catch {}
  }
  bots.delete(u); 
  fsp.rm(sessionPath(u), { recursive: true, force: true }); 
  res.json({ ok: true }); 
});

// ==========================================
// START SERVER
// ==========================================
app.listen(PORT, "0.0.0.0", () => logger.info(`Server started on ${PORT}`));

(async () => {
  if (!fs.existsSync(SESSION_DIR)) return;
  for (const f of await fsp.readdir(SESSION_DIR, { withFileTypes: true })) {
    if (f.isDirectory() && f.name.startsWith("session_")) {
      await startBot(f.name.replace("session_", "")).catch(() => {});
    }
  }
})();
