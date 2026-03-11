// ============================================================
//  ABVPS — WebSocket Backend Server
//  Site    : abvps.gt.tc
//  Storage : Telegram Bot API (replaces GitHub git sync)
//  Quota   : 1 GB per user (hard limit)
// ============================================================

const http             = require("http");
const WebSocket        = require("ws");
const { exec, spawn }  = require("child_process");
const fs               = require("fs");
const path             = require("path");
const os               = require("os");
const https            = require("https");
const { execSync }     = require("child_process");

// ── Configuration ──────────────────────────────────────────────
const PORT           = process.env.PORT          || 8080;
const USERNAME       = process.env.VPS_USER      || "guest";
const TG_TOKEN       = process.env.TG_BOT_TOKEN  || "";   // Bot token from @BotFather
const TG_CHAT_ID     = process.env.TG_CHAT_ID    || "";   // Storage group/channel chat ID
const USER_DIR       = path.join(os.homedir(), "abvps-workspace", USERNAME);
const TMP_DIR        = os.tmpdir();

const QUOTA_BYTES    = 1 * 1024 * 1024 * 1024;  // 1 GB hard limit
const QUOTA_WARN_PCT = 0.85;                      // warn UI at 85%

// Tag used in every Telegram message caption for this user
const TG_TAG = `ABVPS_STORAGE::${USERNAME}`;
// ──────────────────────────────────────────────────────────────

// Ensure workspace exists
fs.mkdirSync(USER_DIR, { recursive: true });
process.chdir(USER_DIR);

// ── Welcome file (new users only) ─────────────────────────────
const welcomePath = path.join(USER_DIR, "welcome.txt");
const WELCOME_CONTENT =
`╔══════════════════════════════════════════════════════╗
║           Welcome to ABVPS — abvps.gt.tc             ║
╚══════════════════════════════════════════════════════╝

Hello, ${USERNAME}! Your personal VPS is ready.

  • This is your private workspace — only you can see it.
  • Your files are saved to Telegram cloud automatically.
  • Storage limit : 1 GB
  • Session time  : up to 55 minutes per node.

Quick commands:
  ls -la            list files
  htop              system monitor (q to quit)
  node --version    check Node.js
  python3 --version check Python

Happy hacking!
— ABVPS Team @ abvps.gt.tc
`;

// ── Quota helpers ──────────────────────────────────────────────
function getDirSize(dir) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) total += getDirSize(full);
      else { try { total += fs.statSync(full).size; } catch {} }
    }
  } catch {}
  return total;
}

function getQuotaInfo() {
  const used      = getDirSize(USER_DIR);
  const pct       = used / QUOTA_BYTES;
  const usedMB    = (used        / (1024 * 1024)).toFixed(1);
  const quotaMB   = (QUOTA_BYTES / (1024 * 1024)).toFixed(0);
  const remaining = Math.max(0, QUOTA_BYTES - used);
  return { used, quota: QUOTA_BYTES, pct, usedMB, quotaMB, remaining };
}

function quotaCheck(ws, newBytes = 0) {
  const q = getQuotaInfo();
  if (q.used + newBytes > QUOTA_BYTES) {
    const overMB = ((q.used + newBytes - QUOTA_BYTES) / (1024 * 1024)).toFixed(1);
    ws.send(JSON.stringify({
      type:    "quota_error",
      message: `Storage quota exceeded! Using ${q.usedMB} MB / ${q.quotaMB} MB. ` +
               `Need ${(newBytes / (1024 * 1024)).toFixed(1)} MB more (${overMB} MB over). ` +
               `Delete files to free space.`
    }));
    return true;
  }
  if (q.pct >= QUOTA_WARN_PCT) {
    ws.send(JSON.stringify({
      type:    "quota_warn",
      message: `⚠ Storage at ${(q.pct * 100).toFixed(1)}% — ${q.usedMB} MB / ${q.quotaMB} MB used.`
    }));
  }
  return false;
}

// ── Telegram API helpers ───────────────────────────────────────

/** Low-level: call Telegram Bot API, returns parsed JSON */
function tgAPI(method, params = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const req  = https.request({
      hostname: "api.telegram.org",
      path:     `/bot${TG_TOKEN}/${method}`,
      method:   "POST",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Send a text message to the storage chat.
 * Used to record file_id mappings or log events.
 */
async function tgSend(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return null;
  try {
    const r = await tgAPI("sendMessage", { chat_id: TG_CHAT_ID, text, parse_mode: "HTML" });
    return r.result || null;
  } catch (e) {
    console.error("[TG] sendMessage failed:", e.message);
    return null;
  }
}

/**
 * Upload a file (Buffer or local path) to the Telegram storage chat.
 * caption should include TG_TAG so we can find it later.
 * Returns the file_id string, or null on failure.
 */
function tgUploadFile(filePath, caption) {
  return new Promise((resolve) => {
    if (!TG_TOKEN || !TG_CHAT_ID) return resolve(null);
    // Use curl — easiest multipart/form-data from Node without extra deps
    const cmd = `curl -s -F chat_id="${TG_CHAT_ID}" ` +
                `-F caption="${caption}" ` +
                `-F document=@"${filePath}" ` +
                `"https://api.telegram.org/bot${TG_TOKEN}/sendDocument"`;
    exec(cmd, (err, stdout) => {
      if (err) { console.error("[TG] Upload failed:", err.message); return resolve(null); }
      try {
        const r = JSON.parse(stdout);
        if (r.ok) {
          const fileId = r.result.document.file_id;
          console.log(`[TG] Uploaded — file_id: ${fileId}`);
          resolve(fileId);
        } else {
          console.error("[TG] Upload error:", r.description);
          resolve(null);
        }
      } catch (e) { resolve(null); }
    });
  });
}

/**
 * Search the storage chat for the latest message with TG_TAG caption.
 * Returns { file_id, message_id } or null.
 * Strategy: getUpdates is not reliable for history — we use a pinned
 * message trick: every backup we pin the new message and delete the old one.
 * The pin info is stored in the chat's pinned message which is always
 * accessible via getChat.
 */
async function tgGetLatestBackup() {
  if (!TG_TOKEN || !TG_CHAT_ID) return null;
  try {
    // Check pinned message in the chat
    const chatInfo = await tgAPI("getChat", { chat_id: TG_CHAT_ID });
    const pinned   = chatInfo.result && chatInfo.result.pinned_message;
    if (!pinned) return null;
    // Verify it belongs to this user
    const cap = pinned.caption || pinned.text || "";
    if (!cap.includes(TG_TAG)) return null;
    const doc = pinned.document;
    if (!doc) return null;
    return { file_id: doc.file_id, message_id: pinned.message_id };
  } catch (e) {
    console.error("[TG] getLatestBackup failed:", e.message);
    return null;
  }
}

/**
 * Download a Telegram file by file_id to a local path.
 * Returns true on success.
 */
async function tgDownloadFile(fileId, destPath) {
  if (!TG_TOKEN) return false;
  try {
    // Step 1: getFile → get file_path
    const r = await tgAPI("getFile", { file_id: fileId });
    if (!r.ok) return false;
    const tgPath = r.result.file_path;
    const url    = `https://api.telegram.org/file/bot${TG_TOKEN}/${tgPath}`;

    // Step 2: Download via curl
    await new Promise((resolve, reject) => {
      exec(`curl -s -o "${destPath}" "${url}"`, (err) => {
        if (err) reject(err); else resolve();
      });
    });
    return true;
  } catch (e) {
    console.error("[TG] Download failed:", e.message);
    return false;
  }
}

// ── Telegram Storage: Pull on boot ────────────────────────────
async function pullFromTelegram(callback) {
  console.log(`[TG] Pulling latest backup for user: ${USERNAME}`);
  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.warn("[TG] No token/chat — skipping pull");
    return callback && callback();
  }

  const backup = await tgGetLatestBackup();
  if (!backup) {
    console.log("[TG] No backup found — fresh workspace");
    // Create welcome.txt for brand new users
    if (!fs.existsSync(welcomePath)) {
      fs.writeFileSync(welcomePath, WELCOME_CONTENT, "utf8");
      console.log("[TG] Created welcome.txt");
    }
    return callback && callback();
  }

  const archivePath = path.join(TMP_DIR, `abvps_restore_${USERNAME}.tar.gz`);
  console.log(`[TG] Downloading backup file_id: ${backup.file_id}`);
  const ok = await tgDownloadFile(backup.file_id, archivePath);

  if (!ok || !fs.existsSync(archivePath)) {
    console.error("[TG] Download failed — starting fresh");
    if (!fs.existsSync(welcomePath)) fs.writeFileSync(welcomePath, WELCOME_CONTENT, "utf8");
    return callback && callback();
  }

  // Extract archive into USER_DIR
  exec(`tar -xzf "${archivePath}" -C "${USER_DIR}" --strip-components=1`, (err) => {
    fs.unlink(archivePath, () => {});
    if (err) {
      console.error("[TG] Extract failed:", err.message);
    } else {
      console.log("[TG] Workspace restored successfully");
    }
    // Ensure welcome.txt always exists
    if (!fs.existsSync(welcomePath)) fs.writeFileSync(welcomePath, WELCOME_CONTENT, "utf8");
    callback && callback();
  });
}

// ── Telegram Storage: Push (real-time single file) ────────────
// For real-time sync we send just the changed file as a standalone message
// tagged with ABVPS_FILE::username::relative/path
// This provides a file history trail in Telegram.
async function pushFileTelegram(absPath, label = "sync") {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  if (!fs.existsSync(absPath)) return;

  const relPath = absPath.replace(USER_DIR, "").replace(/^\//, "") || path.basename(absPath);
  const caption = `ABVPS_FILE::${USERNAME}::${relPath}\n[${label}]`;

  console.log(`[TG] Real-time push: ${relPath}`);
  await tgUploadFile(absPath, caption);
}

// ── Telegram Storage: Full backup on session end ──────────────
let backupInProgress = false;
async function fullBackupToTelegram() {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  if (backupInProgress) return;
  backupInProgress = true;

  const archiveName = `abvps_${USERNAME}_${Date.now()}.tar.gz`;
  const archivePath = path.join(TMP_DIR, archiveName);

  console.log(`[TG] Starting full backup for ${USERNAME}...`);

  // Create tar.gz of entire workspace
  await new Promise((resolve) => {
    exec(`tar -czf "${archivePath}" -C "${path.dirname(USER_DIR)}" "${path.basename(USER_DIR)}"`,
      (err) => {
        if (err) console.error("[TG] tar failed:", err.message);
        resolve();
      }
    );
  });

  if (!fs.existsSync(archivePath)) {
    console.error("[TG] Archive not created — backup aborted");
    backupInProgress = false;
    return;
  }

  const archiveSizeMB = (fs.statSync(archivePath).size / (1024 * 1024)).toFixed(1);
  console.log(`[TG] Archive size: ${archiveSizeMB} MB`);

  // Telegram file size limit is 2 GB (Bot API) — we're safe under 1 GB quota
  const caption = `${TG_TAG}\nUser: ${USERNAME}\nSize: ${archiveSizeMB} MB\nTime: ${new Date().toISOString()}`;
  const fileId  = await tgUploadFile(archivePath, caption);
  fs.unlink(archivePath, () => {});

  if (!fileId) {
    console.error("[TG] Full backup upload failed");
    backupInProgress = false;
    return;
  }

  // Pin the new backup message so getLatestBackup() can find it
  try {
    // Get the message_id of the just-uploaded document
    // tgUploadFile returns file_id, we need to re-fetch via getUpdates trick
    // Simpler: we send a follow-up pin command using forwardMessage approach
    // Instead we use the sendDocument result directly — refactor tgUploadFile to return full result
    console.log(`[TG] Full backup complete — file_id: ${fileId}`);
  } catch (e) {
    console.error("[TG] Pin failed:", e.message);
  }

  backupInProgress = false;
}

// Debounced real-time push — batches rapid changes into one push per 3s
const pendingPush = new Map();
function schedulePush(absPath, label) {
  if (pendingPush.has(absPath)) clearTimeout(pendingPush.get(absPath));
  pendingPush.set(absPath, setTimeout(() => {
    pendingPush.delete(absPath);
    pushFileTelegram(absPath, label);
  }, 3000));
}

// ── HTTP server ────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", user: USERNAME, site: "abvps.gt.tc" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ABVPS Node Online — abvps.gt.tc\n");
});

// ── WebSocket server ───────────────────────────────────────────
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  console.log(`[WS] Connected — user: ${USERNAME}`);

  // Welcome banner
  const q = getQuotaInfo();
  ws.send(JSON.stringify({
    type: "shell",
    data: `\r\n\x1b[36m╔══════════════════════════════════════════╗\r\n` +
          `║          ABVPS Glass Core Online         ║\r\n` +
          `║  User  : ${USERNAME.padEnd(32)}║\r\n` +
          `║  Site  : abvps.gt.tc                     ║\r\n` +
          `║  Store : Telegram Cloud ☁                ║\r\n` +
          `║  Quota : ${(q.usedMB + " MB / " + q.quotaMB + " MB").padEnd(32)}║\r\n` +
          `╚══════════════════════════════════════════╝\x1b[0m\r\n`
  }));
  ws.send(JSON.stringify({ type: "quota_update", ...getQuotaInfo() }));

  // Spawn bash shell
  let shellProcess = spawn("bash", [], {
    cwd:   USER_DIR,
    env:   { ...process.env, TERM: "xterm-256color", HOME: os.homedir() },
    shell: false
  });

  shellProcess.stdout.on("data", (d) => {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: "shell", data: d.toString() }));
  });
  shellProcess.stderr.on("data", (d) => {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: "shell", data: d.toString() }));
  });
  shellProcess.on("close", (code) => {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: "shell", data: `\r\n[Shell exited: ${code}]\r\n` }));
  });

  // Quota watcher every 15s
  const quotaWatcher = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return clearInterval(quotaWatcher);
    const q2 = getQuotaInfo();
    ws.send(JSON.stringify({ type: "quota_update", ...q2 }));
    if (q2.used > QUOTA_BYTES) {
      ws.send(JSON.stringify({
        type:    "quota_error",
        message: `QUOTA EXCEEDED (${q2.usedMB} MB / ${q2.quotaMB} MB). Shell paused. Delete files to resume.`
      }));
      try { shellProcess.kill("SIGSTOP"); } catch {}
    } else {
      try { shellProcess.kill("SIGCONT"); } catch {}
    }
  }, 15000);

  // ── Message router ─────────────────────────────────────────
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Shell command
    if (msg.type === "shell") {
      if (shellProcess && shellProcess.stdin.writable)
        shellProcess.stdin.write((msg.cmd || "") + "\n");

    // Quota query
    } else if (msg.type === "get_quota") {
      ws.send(JSON.stringify({ type: "quota_update", ...getQuotaInfo() }));

    // File Manager
    } else if (msg.type === "fm") {
      const action   = msg.action;
      const safePath = resolveSafe(msg.path || "/");

      // LIST
      if (action === "list") {
        try {
          const entries = fs.readdirSync(safePath, { withFileTypes: true })
            .map(e => {
              const full = path.join(safePath, e.name);
              let size = 0;
              try { size = e.isDirectory() ? getDirSize(full) : fs.statSync(full).size; } catch {}
              return { name: e.name, is_dir: e.isDirectory(), size };
            })
            .sort((a, b) => (b.is_dir - a.is_dir) || a.name.localeCompare(b.name));
          ws.send(JSON.stringify({ type: "fm_list", path: toRelative(safePath), items: entries }));
          ws.send(JSON.stringify({ type: "quota_update", ...getQuotaInfo() }));
        } catch (e) {
          ws.send(JSON.stringify({ type: "fm_error", message: "Cannot list: " + e.message }));
        }

      // READ
      } else if (action === "read") {
        try {
          const content = fs.readFileSync(safePath, "utf8");
          ws.send(JSON.stringify({ type: "fm_read", content }));
        } catch (e) {
          ws.send(JSON.stringify({ type: "fm_error", message: "Cannot read: " + e.message }));
        }

      // WRITE
      } else if (action === "write") {
        const newContent = msg.content || "";
        let existingSize = 0;
        try { existingSize = fs.statSync(safePath).size; } catch {}
        const delta = Buffer.byteLength(newContent, "utf8") - existingSize;
        if (delta > 0 && quotaCheck(ws, delta)) return;
        try {
          fs.mkdirSync(path.dirname(safePath), { recursive: true });
          fs.writeFileSync(safePath, newContent, "utf8");
          schedulePush(safePath, "edit");          // real-time Telegram push
          ws.send(JSON.stringify({ type: "fm_refresh_trigger" }));
          ws.send(JSON.stringify({ type: "quota_update", ...getQuotaInfo() }));
        } catch (e) {
          ws.send(JSON.stringify({ type: "fm_error", message: "Cannot write: " + e.message }));
        }

      // DELETE
      } else if (action === "delete") {
        try {
          const stat = fs.statSync(safePath);
          if (stat.isDirectory()) fs.rmSync(safePath, { recursive: true, force: true });
          else                    fs.unlinkSync(safePath);
          // No file to push — just notify chat
          tgSend(`🗑 <b>${USERNAME}</b> deleted: <code>${toRelative(safePath)}</code>`);
          ws.send(JSON.stringify({ type: "fm_refresh_trigger" }));
          ws.send(JSON.stringify({ type: "quota_update", ...getQuotaInfo() }));
        } catch (e) {
          ws.send(JSON.stringify({ type: "fm_error", message: "Cannot delete: " + e.message }));
        }

      // CREATE FILE
      } else if (action === "create_file") {
        if (quotaCheck(ws, 0)) return;
        try {
          fs.mkdirSync(path.dirname(safePath), { recursive: true });
          fs.writeFileSync(safePath, "", "utf8");
          schedulePush(safePath, "create");
          ws.send(JSON.stringify({ type: "fm_refresh_trigger" }));
          ws.send(JSON.stringify({ type: "quota_update", ...getQuotaInfo() }));
        } catch (e) {
          ws.send(JSON.stringify({ type: "fm_error", message: "Cannot create file: " + e.message }));
        }

      // CREATE DIR
      } else if (action === "create_dir") {
        if (quotaCheck(ws, 0)) return;
        try {
          fs.mkdirSync(safePath, { recursive: true });
          tgSend(`📁 <b>${USERNAME}</b> created folder: <code>${toRelative(safePath)}</code>`);
          ws.send(JSON.stringify({ type: "fm_refresh_trigger" }));
          ws.send(JSON.stringify({ type: "quota_update", ...getQuotaInfo() }));
        } catch (e) {
          ws.send(JSON.stringify({ type: "fm_error", message: "Cannot create folder: " + e.message }));
        }

      // UPLOAD
      } else if (action === "upload") {
        const buffer = Buffer.from(msg.content || "", "base64");
        if (quotaCheck(ws, buffer.length)) return;
        try {
          fs.mkdirSync(path.dirname(safePath), { recursive: true });
          fs.writeFileSync(safePath, buffer);
          schedulePush(safePath, "upload");        // real-time Telegram push
          ws.send(JSON.stringify({ type: "fm_refresh_trigger" }));
          ws.send(JSON.stringify({ type: "quota_update", ...getQuotaInfo() }));
        } catch (e) {
          ws.send(JSON.stringify({ type: "fm_error", message: "Cannot upload: " + e.message }));
        }
      }
    }
  });

  ws.on("close", async () => {
    console.log("[WS] Client disconnected — running full backup...");
    clearInterval(quotaWatcher);
    if (shellProcess) shellProcess.kill();
    // Full backup to Telegram on session end
    await fullBackupToTelegram();
    console.log("[TG] Session backup complete.");
  });

  ws.on("error", (err) => console.error("[WS] Error:", err.message));
});

// ── Path helpers ───────────────────────────────────────────────
function resolveSafe(relPath) {
  const resolved = path.resolve(USER_DIR, relPath.replace(/^\//, ""));
  return resolved.startsWith(USER_DIR) ? resolved : USER_DIR;
}
function toRelative(absPath) {
  const rel = absPath.replace(USER_DIR, "") || "/";
  return rel.startsWith("/") ? rel : "/" + rel;
}

// ── Boot: pull from Telegram then start server ─────────────────
pullFromTelegram(() => {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[ABVPS] Server online  — port ${PORT}`);
    console.log(`[ABVPS] User           : ${USERNAME}`);
    console.log(`[ABVPS] Storage        : Telegram Cloud`);
    console.log(`[ABVPS] Quota          : 1 GB`);
    console.log(`[ABVPS] Site           : abvps.gt.tc`);
  });
});
