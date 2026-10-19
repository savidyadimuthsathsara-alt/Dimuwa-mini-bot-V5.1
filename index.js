"use strict";

/*
  DIMUWA MINI BOT VERSION 5.1.0 (PREMIUM LIVE DASHBOARD)
  Creator: Dimuth Sathsara
  Fixed: Interactive Downloader, Duplicates, Status React, Always Online
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

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  downloadMediaMessage,
  getContentType,
  normalizeMessageContent,
  proto
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
  autoSaveViewOnce: "ON"
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

const MAX_MESSAGE_CACHE = 3000;
const CACHE_TTL = 2 * 60 * 60 * 1000;
const statusReactList = ["❤️", "💚", "💙", "💛", "🤍", "🧡", "💜", "🩷", "🔥", "😂", "😍", "😮", "👍", "🥰", "😎", "🎉", "✨", "💯", "🙌", "🤩", "😘", "🤗", "🌟", "💫"];

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
  return key && key.id ? key.id : null;
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
  const item = messageCache.get(cacheKey(key));
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
  const participant = msg.key?.participant;
  if (!participant) return;

  if (s.statusRead === "ON") {
    await sock.readMessages([msg.key]).catch(() => {});
  }
  
  if (s.statusReact !== "OFF" && !msg.key.fromMe) {
    const emoji = s.statusReact === "RANDOM" ? statusReactList[Math.floor(Math.random() * statusReactList.length)] : "💚";
    try {
      await sock.sendMessage("status@broadcast", {
        react: { text: emoji, key: msg.key }
      }, { 
        statusJidList: [participant, getOwnerJid(sock)].filter(Boolean) 
      });
    } catch (e) {
      logger.error("Failed to react to status");
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
  if (m[innerType]?.viewOnce) return { type: innerType, content: m[innerType], innerMessage: m };
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
  
  const buffer = await downloadMediaMessage({ key: msg.key, message: vo.innerMessage }, "buffer", {}, { logger, reuploadRequest: async (m) => sock.updateMediaMessage(m) });
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
    const caption = `🔓 *AUTO-SAVED VIEW ONCE*\n\n👤 From: ${msg.pushName || jidNumber(sender)}\n📱 Number: ${jidNumber(sender)}\n🕐 Time: ${new Date().toLocaleString()}\n\n🤖 DIMUWA MINI BOT V5.1`;
    
    await sendWhatsAppMedia(sock, owner, { ...media, caption });
    return true;
  } catch (e) {
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
    const target = getSettings(username).vvTarget === "PRIVATE" ? getOwnerJid(sock) : msg.key.remoteJid;
    
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
    const target = getSettings(username).saveTarget === "PRIVATE" ? getOwnerJid(sock) : msg.key.remoteJid;
    
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
  return `⚙️ *DIMUWA BOT SETTINGS*
│ Reply with code to update

• PRESENCE & SCOPE •
Always Online [ ${s.alwaysOnline} ] (1.1 ON | 1.2 OFF)
Auto Read [ ${s.autoRead} ] (2.1 ON | 2.2 OFF)
Bot Mode [ ${s.botMode} ] (3.1 PUB | 3.2 PRIV | 3.3 INBOX)

• STATUS & AUTOMATIONS •
Status Read [ ${s.statusRead} ] (4.1 ON | 4.2 OFF)
Status React [ ${s.statusReact} ] (5.1 GRN | 5.2 RND | 5.3 OFF)
Composing [ ${s.composing} ] (7.1 ON | 7.2 OFF)

• SECURITY •
Anti-Delete [ ${s.antiDelete} ] (9.1 ON | 9.2 OFF)
Anti-Del Target [ ${s.antiDelTarget} ] (10.1 SAME | 10.2 PRIV)
.vv Target [ ${s.vvTarget} ] (11.1 SAME | 11.2 PRIV)
.save Target [ ${s.saveTarget} ] (12.1 SAME | 12.2 PRIV)
Bot Power [ ${s.botPower} ] (13.1 ON | 13.2 OFF)
Auto-Save V.O. [ ${s.autoSaveViewOnce} ] (14.1 ON | 14.2 OFF)`;
}

async function processSettingsCode(sock, u, msg, code) {
  if (!isOwner(sock, msg)) return true; 
  
  const s = getSettings(u); 
  let changed = true;
  
  switch (code) {
    case "1.1": s.alwaysOnline = "ON"; await sock.sendPresenceUpdate("available"); break; 
    case "1.2": s.alwaysOnline = "OFF"; await sock.sendPresenceUpdate("unavailable"); break;
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
    default: changed = false;
  }
  
  if (changed) { 
    saveSettings(u, s); 
    await sock.sendMessage(msg.key.remoteJid, { text: "✅ SETTING UPDATED" }); 
    return true; 
  }
  return false;
}

function menuText(u) {
  const s = getSettings(u);
  return `👋 *DIMUWA MINI BOT V5.1* 🤖 👑

┌──「 👨‍💻 CREATOR INFO 」──┐
│ 👨‍💻 Creator: ${CREATOR_NAME}
│ ⚙️ Prefix: [ . ]
└────────────────────┘

┌──「 🤖 BOT STATUS 」──┐
│ 🟢 Status: Online
│ ⚙️ Mode: ${s.botMode}
│ 🔓 Auto View-Once: ${s.autoSaveViewOnce}
└────────────────────┘

┌──「 📁 MAIN MENU 」──┐
│ 1️⃣ 📥 DOWNLOAD MEDIA
│ 2️⃣ ⚙️ SETTINGS MENU
│ 3️⃣ 👑 OWNER COMMANDS
│ 4️⃣ 🛠️ UTILITY COMMANDS
│ 5️⃣ 🎮 FUN COMMANDS
│ 6️⃣ 👥 GROUP COMMANDS
│ 7️⃣ 👤 NORMAL USER CMDS
└────────────────────┘
💡 Type or reply a number (1-7)!`;
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
    await sock.sendMessage(jid, { text: `👑 *OWNER COMMANDS*\n.dp, .block, .unblock` }, { quoted: msg });
    return true;
  }
  if (num === "4") {
    await sock.sendMessage(jid, { text: `🛠️ *UTILITY*\n.vv - View once resend\n.save - Save media` }, { quoted: msg });
    return true;
  }
  if (num === "5") {
    await sock.sendMessage(jid, { text: `🎮 *FUN COMMANDS*\n.dice\n.random\n.love` }, { quoted: msg });
    return true;
  }
  if (num === "6") {
    await sock.sendMessage(jid, { text: `👥 *GROUP COMMANDS*\n.tagall - Mention all` }, { quoted: msg });
    return true;
  }
  if (num === "7") {
    await sock.sendMessage(jid, { text: `👤 *NORMAL USER COMMANDS*\n.ping - Check speed\n.alive - Check status\n.menu - Bot Menu\n.status - Bot Info\n.vv - Save view once\n.save - Save media\n.tagall - Tag group\n.dice / .random / .love\n\nSend video links to download Video, Audio, or Images!` }, { quoted: msg });
    return true;
  }
  return false;
}

// ==========================================
// YT-DLP DOWNLOADER (INTERACTIVE)
// ==========================================
function extractHttpUrl(t) { 
  const m = t?.match(/https?:\/\/[^\s]+/i); 
  return m ? m[0].replace(/[)>]+$/g, "") : null; 
}

function isSupportedUrl(url) { 
  return /tiktok|youtube|youtu\.be|facebook|fb\./i.test(url); 
}

async function ensureYtDlp() {
  const binary = path.join(TOOLS_DIR, "yt-dlp");
  if (fs.existsSync(binary)) return binary;
  
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
      
      const target = s.antiDelTarget === "PRIVATE" ? getOwnerJid(sock) : key.remoteJid;
      if (!target) continue;
      
      const t = getMessageText(cached); 
      const media = getMediaInfo(cached.message);
      
      if (media) {
        try { 
          const dm = await downloadWhatsAppMedia(sock, cached); 
          await sendWhatsAppMedia(sock, target, { ...dm, content: { caption: `🗑️ DELETED MEDIA\n${dm.content?.caption||""}` } }); 
        } catch { 
          await sock.sendMessage(target, { text: `🗑️ DELETED MEDIA` }); 
        }
      } else if (t) { 
        await sock.sendMessage(target, { text: `🗑️ DELETED MSG:\n\n${t}` }); 
      } else { 
        await sock.sendMessage(target, { forward: cached }); 
      }
    } catch (e) {
      // Ignore errors silently
    }
  }
}

// ==========================================
// MAIN MESSAGE ROUTER
// ==========================================
async function handleMessage(username, sock, msg) {
  if (!msg?.message || !msg?.key) return;
  
  if (msg.key.remoteJid === "status@broadcast") {
    await handleStatus(username, sock, msg);
    return;
  }
  
  if (msg.key.remoteJid === "broadcast") return;

  if (msg.message.protocolMessage && (msg.message.protocolMessage.type === 0 || msg.message.protocolMessage.type === "REVOKE")) {
    const dKey = msg.message.protocolMessage.key;
    if (dKey) await handleDeletedMessages(username, sock, [dKey]);
    return;
  }
  
  cacheMessage(msg); 
  incrementStat(username, "messages");
  
  const s = getSettings(username);
  
  if (s.autoRead === "ON" && !msg.key.fromMe) {
    await sock.readMessages([msg.key]).catch(()=>{});
  }
  
  await handleAutoSaveViewOnce(username, sock, msg);

  const text = getMessageText(msg).trim(); 
  if (!text) return;
  
  const setCode = text.match(/^\s*(\d{1,2}\.\d)\s*$/);
  if (setCode) {
    return await processSettingsCode(sock, username, msg, setCode[1]);
  }
  
  if (/^[1-7]$/.test(text)) {
    const handledMenu = await handleMenuNumber(sock, username, msg.key.remoteJid, text, msg);
    if (handledMenu) return; 
  }
  
  if (!canProcessMessage(sock, username, msg)) return;
  
  if (s.composing === "ON") {
    await sock.sendPresenceUpdate("composing", msg.key.remoteJid).catch(()=>{});
  }
  
  // ----------------------------------------------------
  // Interactive Downloader Reply Check
  // ----------------------------------------------------
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

  const cmd = text.split(/\s+/)[0].toLowerCase();
  if (cmd.startsWith(".")) incrementStat(username, "commands");

  if (cmd === ".menu" || text.toLowerCase() === "menu") return await sendMenu(sock, username, msg.key.remoteJid, msg);
  if (cmd === ".ping") return await sock.sendMessage(msg.key.remoteJid, { text: "🏓 PONG!" });
  if (cmd === ".vv" || cmd === ".viewonce") return await handleViewOnce(sock, username, msg);
  if (cmd === ".save") return await handleSave(sock, username, msg);
  
  // ----------------------------------------------------
  // Trigger Interactive Downloader Menu
  // ----------------------------------------------------
  const urlMatches = text.match(/https?:\/\/[^\s]+/i);
  if (urlMatches) {
    const url = urlMatches[0].replace(/[)>]+$/g, "");
    if (isSupportedUrl(url)) {
      const menuText = `📥 *DIMUWA DOWNLOADER*\n\n🔗 URL: ${url}\n\n*Reply to this message with a number:*\n\n1️⃣ - 🎬 Download Video\n2️⃣ - 🎵 Download Audio\n3️⃣ - 🖼️ Download Images\n\n🤖 DIMUWA MINI BOT V5.1`;
      await sock.sendMessage(msg.key.remoteJid, { text: menuText }, { quoted: msg });
      return; // Stop further processing after sending menu
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
    
    const sock = makeWASocket({
      auth: state, 
      browser: Browsers.macOS("Desktop"), 
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
          logger.info({ username: clean }, "WhatsApp QR generated");
        } catch (err) {
          logger.error({ err, username: clean }, "Failed to convert WhatsApp QR");
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

  if (!/^\d{8,15}$/.test(number)) {
    throw new Error("Enter a valid WhatsApp number with country code.");
  }

  let sock = bots.get(clean);
  if (!sock) sock = await startBot(clean);
  if (isConnected(sock)) return { connected: true };
  if (sock.__pairingRequest) return await sock.__pairingRequest;

  sock.__pairingRequest = (async () => {
    try {
      // Wait for the WhatsApp WebSocket before asking Baileys for a code.
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (isConnected(sock)) return { connected: true };
        const state = sock.ws?.readyState;
        if (state === 1) break; // WebSocket.OPEN
        if (state === 2 || state === 3) {
          throw new Error("WhatsApp connection closed before pairing started. Check Railway logs.");
        }
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      if (isConnected(sock)) return { connected: true };
      if (sock.ws?.readyState !== 1) {
        throw new Error("WhatsApp connection was not ready within 15 seconds. Try again after checking Railway logs.");
      }

      const rawCode = await sock.requestPairingCode(number);
      const cleanedCode = String(rawCode || "").replace(/[^A-Za-z0-9]/g, "");
      if (!cleanedCode) throw new Error("WhatsApp did not return a pairing code.");
      const groups = cleanedCode.match(/.{1,4}/g) || [];
      return { connected: false, code: groups.join("-") };
    } catch (e) {
      logger.error({ err: e, username: clean }, "Pairing code request failed");
      throw new Error(`Pairing code failed: ${e.message || "WhatsApp connection is not ready"}`);
    }
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
    let sock = bots.get(u);

    // Reuse an in-progress startup instead of creating parallel sockets.
    if (!sock) sock = await startBot(u);
    if (isConnected(sock)) return res.json({ ok: true, connected: true });

    // QR is emitted asynchronously by connection.update; wait up to 25 seconds.
    let qrImage = null;
    for (let i = 0; i < 50; i++) {
      if (isConnected(sock)) return res.json({ ok: true, connected: true });
      qrImage = qrStore.get(u) || null;
      if (qrImage) break;
      if (sock.ws?.readyState === 3) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (!qrImage) throw new Error("QR not ready. Wait a few seconds and try again; check Railway logs if it repeats.");
    return res.json({ ok: true, connected: false, qr: qrImage });
  } catch (e) {
    logger.error({ err: e, username: cleanUsername(req.query.username) }, "QR request failed");
    return res.status(503).json({ ok: false, error: e.message });
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
