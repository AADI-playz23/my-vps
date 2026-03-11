// ============================================================
//  ABVPS — WebSocket Backend Server
//  Site    : abvps.gt.tc
//  Storage : Telegram Bot API  (files)
//            InfinityFree MySQL (file_id index per user)
//  Quota   : 1 GB per user
//  Multi-user safe: every user has their own backup pointer
//                   stored in MySQL — no pin collision
// ============================================================

const http            = require("http");
const WebSocket       = require("ws");
const { exec, spawn } = require("child_process");
const fs              = require("fs");
const path            = require("path");
const os              = require("os");
const https           = require("https");

// ── Configuration ──────────────────────────────────────────────
const PORT         = process.env.PORT         || 8080;
const USERNAME     = process.env.VPS_USER     || "guest";
const TG_TOKEN     = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID   = process.env.TG_CHAT_ID   || "";

// InfinityFree MySQL — same credentials as db_config.php
const DB_HOST      = process.env.DB_HOST      || "sql200.infinityfree.com";
const DB_USER      = process.env.DB_USER      || "if0_xxxxxxxxx";
const DB_PASS      = process.env.DB_PASS      || "YOUR_DB_PASSWORD";
const DB_NAME      = process.env.DB_NAME      || "if0_xxxxxxxxx_bugvps";

const USER_DIR     = path.join(os.homedir(), "abvps-workspace", USERNAME);
const TMP_DIR      = os.tmpdir();

const QUOTA_BYTES    = 1 * 1024 * 1024 * 1024; // 1 GB
const QUOTA_WARN_PCT = 0.85;

// Caption tag for full backups in Telegram chat
const TG_TAG = `ABVPS_BACKUP::${USERNAME}`;
// ──────────────────────────────────────────────────────────────

fs.mkdirSync(USER_DIR, { recursive: true });
process.chdir(USER_DIR);

// ── Welcome file ───────────────────────────────────────────────
const welcomePath    = path.join(USER_DIR, "welcome.txt");
const WELCOME_CONTENT = `\
╔══════════════════════════════════════════════════════╗
║           Welcome to ABVPS — abvps.gt.tc             ║
╚══════════════════════════════════════════════════════╝

Hello, ${USERNAME}! Your personal VPS is ready.

  • Files are backed up to Telegram cloud automatically.
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
  const used    = getDirSize(USER_DIR);
  const pct     = used / QUOTA_BYTES;
  const usedMB  = (used        / (1024 * 1024)).toFixed(1);
  const quotaMB = (QUOTA_BYTES / (1024 * 1024)).toFixed(0);
  return { used, quota: QUOTA_BYTES, pct, usedMB, quotaMB, remaining: Math.max(0, QUOTA_BYTES - used) };
}

function quotaCheck(ws, newBytes = 0) {
  const q = getQuotaInfo();
  if (q.used + newBytes > QUOTA_BYTES) {
    ws.send(JSON.stringify({
      type:    "quota_error",
      message: `Quota exceeded! ${q.usedMB} MB / ${q.quotaMB} MB used. ` +
               `Need ${(newBytes / (1024 * 1024)).toFixed(1)} MB more. Delete files to free space.`
    }));
    return true;
  }
  if (q.pct >= QUOTA_WARN_PCT) {
    ws.send(JSON.stringify({
      type:    "quota_warn",
      message: `⚠ Storage at ${(q.pct * 100).toFixed(1)}% — ${q.usedMB} MB / ${q.quotaMB} MB`
    }));
  }
  return false;
}

// ── MySQL helpers (via curl to a thin PHP proxy on InfinityFree) ─
// Because GitHub Actions runner cannot connect directly to InfinityFree
// MySQL (it's firewalled). We expose a tiny PHP endpoint on the hosting
// that accepts internal requests and returns JSON.
// The PHP proxy (db_proxy.php) is included below as a separate file.

const DB_PROXY = `https://abvps.gt.tc/db_proxy.php`;
const DB_SECRET = process.env.DB_PROXY_SECRET || "CHANGE_THIS_SECRET";

function dbQuery(sql, params = []) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ secret: DB_SECRET, sql, params });
    const cmd = `curl -s -X POST "${DB_PROXY}" ` +
                `-H "Content-Type: application/json" ` +
                `-d '${payload.replace(/'/g, "'\\''")}'`;
    exec(cmd, (err, stdout) => {
      if (err) { console.error("[DB] curl error:", err.message); return resolve(null); }
      try { resolve(JSON.parse(stdout)); }
      catch (e) { console.error("[DB] parse error:", stdout); resolve(null); }
    });
  });
}

/** Get the latest Telegram file_id for this user from MySQL */
async function dbGetFileId() {
  const r = await dbQuery(
    "SELECT tg_file_id FROM user_storage WHERE username = ? ORDER BY updated_at DESC LIMIT 1",
    [USERNAME]
  );
  if (r && r.rows && r.rows.length > 0) return r.rows[0].tg_file_id;
  return null;
}

/** Save / update the Telegram file_id for this user in MySQL */
async function dbSaveFileId(fileId) {
  // Upsert: update if exists, insert if not
  await dbQuery(
    `INSERT INTO user_storage (username, tg_file_id, updated_at)
     VALUES (?, ?, NOW())
     ON DUPLICATE KEY UPDATE tg_file_id = VALUES(tg_file_id), updated_at = NOW()`,
    [USERNAME, fileId]
  );
  console.log(`[DB] Saved file_id for ${USERNAME}: ${fileId}`);
}

// ── Telegram API helpers ───────────────────────────────────────

function tgAPI(method, params = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const req  = https.request({
      hostname: "api.telegram.org",
      path:     `/bot${TG_TOKEN}/${method}`,
      method:   "POST",
      headers:  {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function tgSend(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    await tgAPI("sendMessage", { chat_id: TG_CHAT_ID, text, parse_mode: "HTML" });
  } catch (e) {
    console.error("[TG] sendMessage failed:", e.message);
  }
}

/** Upload a .tar.gz to Telegram, return { file_id, message_id } or null */
function tgUploadArchive(filePath, caption) {
  return new Promise((resolve) => {
    if (!TG_TOKEN || !TG_CHAT_ID) return resolve(null);
    const cmd = `curl -s ` +
                `-F chat_id="${TG_CHAT_ID}" ` +
                `-F caption="${caption}" ` +
                `-F document=@"${filePath}" ` +
                `"https://api.telegram.org/bot${TG_TOKEN}/sendDocument"`;
    exec(cmd, (err, stdout) => {
      if (err) { console.error("[TG] Upload error:", err.message); return resolve(null); }
      try {
        const r = JSON.parse(stdout);
        if (r.ok) {
          resolve({
            file_id:    r.result.document.file_id,
            message_id: r.result.message_id
          });
        } else {
          console.error("[TG] Upload failed:", r.description);
          resolve(null);
        }
      } catch (e) { resolve(null); }
    });
  });
}

/** Upload a single file to Telegram (real-time sync) */
function tgUploadFile(filePath, caption) {
  return new Promise((resolve) => {
    if (!TG_TOKEN || !TG_CHAT_ID) return resolve(null);
    const cmd = `curl -s ` +
                `-F chat_id="${TG_CHAT_ID}" ` +
                `-F caption="${caption}" ` +
                `-F document=@"${filePath}" ` +
                `"https://api.telegram.org/bot${TG_TOKEN}/sendDocument"`;
    exec(cmd, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const r = JSON.parse(stdout);
        resolve(r.ok ? r.result.document.file_id : null);
      } catch { resolve(null); }
    });
  });
}

/** Download a Telegram file by file_id to destPath */
async function tgDownloadFile(fileId, destPath) {
  if (!TG_TOKEN) return false;
  try {
    const r = await tgAPI("getFile", { file_id: fileId });
    if (!r.ok) return false;
    const url = `https://api.telegram.org/file/bot${TG_TOKEN}/${r.result.file_path}`;
    await new Promise((res, rej) => {
      exec(`curl -s -o "${destPath}" "${url}"`, (err) => err ? rej(err) : res());
    });
    return fs.existsSync(destPath);
  } catch (e) {
    console.error("[TG] Download failed:", e.message);
    return false;
  }
}

// ── PULL: Restore workspace from Telegram on boot ─────────────
// Each user's latest backup file_id is stored in MySQL.
// No pin needed — completely isolated per user.
async function pullFromTelegram(callback) {
  console.log(`[TG] Restoring workspace for: ${USERNAME}`);

  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.warn("[TG] No credentials — skipping restore");
    if (!fs.existsSync(welcomePath)) fs.writeFileSync(welcomePath, WELCOME_CONTENT, "utf8");
    return callback && callback();
  }

  // Look up this user's file_id from MySQL
  const fileId = await dbGetFileId();

  if (!fileId) {
    console.log(`[TG] No backup found for ${USERNAME} — fresh workspace`);
    if (!fs.existsSync(welcomePath)) fs.writeFileSync(welcomePath, WELCOME_CONTENT, "utf8");
    await tgSend(`📦 <b>${USERNAME}</b> — new workspace created`);
    return callback && callback();
  }

  console.log(`[TG] Found file_id for ${USERNAME}: ${fileId}`);
  const archivePath = path.join(TMP_DIR, `restore_${USERNAME}.tar.gz`);
  const ok = await tgDownloadFile(fileId, archivePath);

  if (!ok) {
    console.error("[TG] Restore download failed — fresh start");
    if (!fs.existsSync(welcomePath)) fs.writeFileSync(welcomePath, WELCOME_CONTENT, "utf8");
    return callback && callback();
  }

  exec(`tar -xzf "${archivePath}" -C "${USER_DIR}" --strip-components=1`, (err) => {
    fs.unlink(archivePath, () => {});
    if (err) console.error("[TG] Extract failed:", err.message);
    else     console.log(`[TG] Workspace restored for ${USERNAME}`);
    if (!fs.existsSync(welcomePath)) fs.writeFileSync(welcomePath, WELCOME_CONTENT, "utf8");
    callback && callback();
  });
}

// ── REAL-TIME PUSH: single file → Telegram ────────────────────
// Debounced per file — batches rapid edits into one upload per 3s
const pendingPush = new Map();

function schedulePush(absPath, label = "sync") {
  if (!fs.existsSync(absPath)) return;
  if (pendingPush.has(absPath)) clearTimeout(pendingPush.get(absPath));
  pendingPush.set(absPath, setTimeout(async () => {
    pendingPush.delete(absPath);
    if (!fs.existsSync(absPath)) return;
    const relPath = absPath.replace(USER_DIR, "").replace(/^\//, "");
    const caption = `ABVPS_FILE::${USERNAME}::${relPath} [${label}]`;
    console.log(`[TG] Real-time push: ${relPath}`);
    await tgUploadFile(absPath, caption);
  }, 3000));
}

// ── FULL BACKUP: entire workspace → Telegram on session end ───
let backupInProgress = false;

async function fullBackupToTelegram() {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  if (backupInProgress) return;
  backupInProgress = true;

  const archiveName = `abvps_${USERNAME}_${Date.now()}.tar.gz`;
  const archivePath = path.join(TMP_DIR, archiveName);

  console.log(`[TG] Full backup starting for ${USERNAME}...`);

  // Create tar.gz of entire user workspace
  const tarErr = await new Promise(res => {
    exec(
      `tar -czf "${archivePath}" -C "${path.dirname(USER_DIR)}" "${path.basename(USER_DIR)}"`,
      err => res(err)
    );
  });

  if (tarErr || !fs.existsSync(archivePath)) {
    console.error("[TG] Archive creation failed");
    backupInProgress = false;
    return;
  }

  const sizeMB  = (fs.statSync(archivePath).size / (1024 * 1024)).toFixed(1);
  const caption = `${TG_TAG}\nSize: ${sizeMB} MB | ${new Date().toISOString()}`;

  console.log(`[TG] Uploading backup (${sizeMB} MB)...`);
  const result = await tgUploadArchive(archivePath, caption);
  fs.unlink(archivePath, () => {});

  if (!result) {
    console.error("[TG] Backup upload failed");
    backupInProgress = false;
    return;
  }

  // ── KEY: save new file_id to MySQL — isolated per user ──────
  await dbSaveFileId(result.file_id);

  console.log(`[TG] Full backup complete for ${USERNAME} — file_id: ${result.file_id}`);
  await tgSend(`✅ <b>${USERNAME}</b> backup saved\nSize: ${sizeMB} MB`);

  backupInProgress = false;
}

// ── HTTP server ────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", user: USERNAME }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ABVPS Online — abvps.gt.tc\n");
});

// ── WebSocket server ───────────────────────────────────────────
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  console.log(`[WS] Connected — ${USERNAME}`);

  const q = getQuotaInfo();
  ws.send(JSON.stringify({
    type: "shell",
    data: `\r\n\x1b[36m╔══════════════════════════════════════════╗\r\n` +
          `║          ABVPS Glass Core Online         ║\r\n` +
          `║  User  : ${USERNAME.padEnd(32)}║\r\n` +
          `║  Store : Telegram ☁  (per-user isolated) ║\r\n` +
          `║  Quota : ${(q.usedMB + " MB / " + q.quotaMB + " MB").padEnd(32)}║\r\n` +
          `╚══════════════════════════════════════════╝\x1b[0m\r\n`
  }));
  ws.send(JSON.stringify({ type: "quota_update", ...getQuotaInfo() }));

  // Bash shell
  let shell = spawn("bash", [], {
    cwd:   USER_DIR,
    env:   { ...process.env, TERM: "xterm-256color", HOME: os.homedir() },
    shell: false
  });

  shell.stdout.on("data", d => {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: "shell", data: d.toString() }));
  });
  shell.stderr.on("data", d => {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: "shell", data: d.toString() }));
  });
  shell.on("close", code => {
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
        message: `QUOTA EXCEEDED (${q2.usedMB} MB). Shell paused. Delete files to resume.`
      }));
      try { shell.kill("SIGSTOP"); } catch {}
    } else {
      try { shell.kill("SIGCONT"); } catch {}
    }
  }, 15000);

  // Message router
  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "shell") {
      if (shell && shell.stdin.writable) shell.stdin.write((msg.cmd || "") + "\n");

    } else if (msg.type === "get_quota") {
      ws.send(JSON.stringify({ type: "quota_update", ...getQuotaInfo() }));

    } else if (msg.type === "fm") {
      const action   = msg.action;
      const safePath = resolveSafe(msg.path || "/");

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

      } else if (action === "read") {
        try {
          const content = fs.readFileSync(safePath, "utf8");
          ws.send(JSON.stringify({ type: "fm_read", content }));
        } catch (e) {
          ws.send(JSON.stringify({ type: "fm_error", message: "Cannot read: " + e.message }));
        }

      } else if (action === "write") {
        const newContent = msg.content || "";
        let existingSize = 0;
        try { existingSize = fs.statSync(safePath).size; } catch {}
        const delta = Buffer.byteLength(newContent, "utf8") - existingSize;
        if (delta > 0 && quotaCheck(ws, delta)) return;
        try {
          fs.mkdirSync(path.dirname(safePath), { recursive: true });
          fs.writeFileSync(safePath, newContent, "utf8");
          schedulePush(safePath, "edit");
          ws.send(JSON.stringify({ type: "fm_refresh_trigger" }));
          ws.send(JSON.stringify({ type: "quota_update", ...getQuotaInfo() }));
        } catch (e) {
          ws.send(JSON.stringify({ type: "fm_error", message: "Cannot write: " + e.message }));
        }

      } else if (action === "delete") {
        try {
          const stat = fs.statSync(safePath);
          if (stat.isDirectory()) fs.rmSync(safePath, { recursive: true, force: true });
          else                    fs.unlinkSync(safePath);
          tgSend(`🗑 <b>${USERNAME}</b> deleted: <code>${toRelative(safePath)}</code>`);
          ws.send(JSON.stringify({ type: "fm_refresh_trigger" }));
          ws.send(JSON.stringify({ type: "quota_update", ...getQuotaInfo() }));
        } catch (e) {
          ws.send(JSON.stringify({ type: "fm_error", message: "Cannot delete: " + e.message }));
        }

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

      } else if (action === "upload") {
        const buffer = Buffer.from(msg.content || "", "base64");
        if (quotaCheck(ws, buffer.length)) return;
        try {
          fs.mkdirSync(path.dirname(safePath), { recursive: true });
          fs.writeFileSync(safePath, buffer);
          schedulePush(safePath, "upload");
          ws.send(JSON.stringify({ type: "fm_refresh_trigger" }));
          ws.send(JSON.stringify({ type: "quota_update", ...getQuotaInfo() }));
        } catch (e) {
          ws.send(JSON.stringify({ type: "fm_error", message: "Cannot upload: " + e.message }));
        }
      }
    }
  });

  ws.on("close", async () => {
    console.log(`[WS] ${USERNAME} disconnected — running full backup`);
    clearInterval(quotaWatcher);
    if (shell) shell.kill();
    await fullBackupToTelegram();
  });

  ws.on("error", err => console.error("[WS] Error:", err.message));
});

// ── Path helpers ───────────────────────────────────────────────
function resolveSafe(relPath) {
  const r = path.resolve(USER_DIR, relPath.replace(/^\//, ""));
  return r.startsWith(USER_DIR) ? r : USER_DIR;
}
function toRelative(absPath) {
  const r = absPath.replace(USER_DIR, "") || "/";
  return r.startsWith("/") ? r : "/" + r;
}

// ── Filesystem Watcher ────────────────────────────────────────
// Watches USER_DIR recursively for ANY file change — including files
// created/modified by shell commands (wget, git, npm, echo, etc.)
// Uses a debounce map so rapid changes don't spam Telegram.
//
// Ignored patterns: temp files, node_modules, .git internals
const WATCH_IGNORE = [
  /node_modules/,
  /\.git\//,
  /\.npm/,
  /~$/,           // editor temp files
  /\.swp$/,       // vim swap
  /\.tmp$/,
];

function shouldIgnore(filePath) {
  return WATCH_IGNORE.some(r => r.test(filePath));
}

function startFsWatcher() {
  try {
    // fs.watch with recursive:true works on Linux (GitHub Actions = Linux)
    const watcher = fs.watch(USER_DIR, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const absPath = path.join(USER_DIR, filename);
      if (shouldIgnore(absPath)) return;

      // Only push files that actually exist (ignore delete events here —
      // deletes are already handled by the file manager action above)
      try {
        const stat = fs.statSync(absPath);
        if (!stat.isFile()) return;
        // Skip very large files from real-time push (>50 MB) — full backup handles those
        if (stat.size > 50 * 1024 * 1024) {
          console.log(`[WATCH] Skipping large file for real-time push: ${filename} (${(stat.size/1024/1024).toFixed(1)} MB)`);
          return;
        }
        schedulePush(absPath, eventType === "rename" ? "create" : "edit");
      } catch {
        // File was deleted — ignore, full backup covers it
      }
    });

    watcher.on("error", err => console.error("[WATCH] Error:", err.message));
    console.log(`[WATCH] Filesystem watcher active on: ${USER_DIR}`);
  } catch (e) {
    console.error("[WATCH] Could not start watcher:", e.message);
  }
}

// ── Boot ───────────────────────────────────────────────────────
pullFromTelegram(() => {
  startFsWatcher();   // ← watches ALL file changes including shell commands
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[ABVPS] Online  port=${PORT}  user=${USERNAME}`);
    console.log(`[ABVPS] Storage: Telegram + MySQL index (multi-user safe)`);
    console.log(`[ABVPS] Every file change is watched and synced in real-time`);
  });
});
