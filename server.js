const http            = require("http");
const WebSocket       = require("ws");
const { exec, spawn } = require("child_process");
const fs              = require("fs");
const path            = require("path");
const os              = require("os");
const https           = require("https");

const PORT         = process.env.PORT         || 8081;
const USERNAME     = process.env.VPS_USER     || "guest";
const PLAN         = process.env.PLAN         || "free";
const TG_TOKEN     = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID   = process.env.TG_CHAT_ID   || "";

const DB_PROXY     = "https://abvps.gt.tc/db_proxy.php";
const DB_SECRET    = process.env.DB_PROXY_SECRET || "";

const USER_DIR     = path.join(os.homedir(), "abvps-workspace", USERNAME);
const TMP_DIR      = os.tmpdir();
const QUOTA_BYTES  = 1 * 1024 * 1024 * 1024;

fs.mkdirSync(USER_DIR, { recursive: true });
process.chdir(USER_DIR);

const welcomePath = path.join(USER_DIR, "welcome.txt");
const WELCOME_CONTENT = `Hello, ${USERNAME}!\nPlan: ${PLAN.toUpperCase()}\n\nFree users: Data is deleted when session ends.\nPaid users: Data is backed up automatically.\n`;

// ── Quota ──────────────────────────────────────────────────────────────────
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
  const used   = getDirSize(USER_DIR);
  const pct    = used / QUOTA_BYTES;
  const usedMB = (used / (1024 * 1024)).toFixed(1);
  const quotaMB= (QUOTA_BYTES / (1024 * 1024)).toFixed(0);
  return { used, quota: QUOTA_BYTES, pct, usedMB, quotaMB };
}

// ── DB proxy ───────────────────────────────────────────────────────────────
function dbQuery(sql, params = []) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ secret: DB_SECRET, sql, params });
    const escaped = payload.replace(/'/g, "'\\''");
    exec(`curl -s -X POST "${DB_PROXY}" -H "Content-Type: application/json" -d '${escaped}'`, (err, stdout) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

async function dbGetFileId() {
  const r = await dbQuery(
    "SELECT tg_file_id FROM user_storage WHERE username = ? ORDER BY updated_at DESC LIMIT 1",
    [USERNAME]
  );
  if (r && r.rows && r.rows.length > 0) return r.rows[0].tg_file_id;
  return null;
}

async function dbSaveFileId(fileId) {
  await dbQuery(
    "INSERT INTO user_storage (username, tg_file_id, updated_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE tg_file_id = VALUES(tg_file_id), updated_at = NOW()",
    [USERNAME, fileId]
  );
}

// ── Telegram ───────────────────────────────────────────────────────────────
function tgAPI(method, params = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const req  = https.request({
      hostname: "api.telegram.org",
      path: `/bot${TG_TOKEN}/${method}`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function tgUploadArchive(filePath, caption) {
  return new Promise((resolve) => {
    if (!TG_TOKEN || !TG_CHAT_ID) return resolve(null);
    const cmd = `curl -s -F chat_id="${TG_CHAT_ID}" -F caption="${caption}" -F document=@"${filePath}" "https://api.telegram.org/bot${TG_TOKEN}/sendDocument"`;
    exec(cmd, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const r = JSON.parse(stdout);
        if (r.ok) resolve({ file_id: r.result.document.file_id });
        else resolve(null);
      } catch { resolve(null); }
    });
  });
}

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
  } catch { return false; }
}

// ── Restore from Telegram on boot ─────────────────────────────────────────
async function pullFromTelegram(callback) {
  if (PLAN === "free") {
    if (!fs.existsSync(welcomePath)) fs.writeFileSync(welcomePath, WELCOME_CONTENT, "utf8");
    return callback && callback();
  }

  const fileId = await dbGetFileId();
  if (!fileId) {
    if (!fs.existsSync(welcomePath)) fs.writeFileSync(welcomePath, WELCOME_CONTENT, "utf8");
    return callback && callback();
  }

  const archivePath = path.join(TMP_DIR, `restore_${USERNAME}.tar.gz`);
  const ok = await tgDownloadFile(fileId, archivePath);

  if (!ok) {
    if (!fs.existsSync(welcomePath)) fs.writeFileSync(welcomePath, WELCOME_CONTENT, "utf8");
    return callback && callback();
  }

  exec(`tar -xzf "${archivePath}" -C "${USER_DIR}" --strip-components=1`, (err) => {
    fs.unlink(archivePath, () => {});
    if (!fs.existsSync(welcomePath)) fs.writeFileSync(welcomePath, WELCOME_CONTENT, "utf8");
    callback && callback();
  });
}

// ── Backup to Telegram on disconnect ──────────────────────────────────────
let backupInProgress = false;

async function fullBackupToTelegram() {
  if (!TG_TOKEN || !TG_CHAT_ID || PLAN === "free" || backupInProgress) return;
  backupInProgress = true;

  const archiveName = `abvps_${USERNAME}_${Date.now()}.tar.gz`;
  const archivePath = path.join(TMP_DIR, archiveName);

  const tarErr = await new Promise(res => {
    exec(`tar -czf "${archivePath}" -C "${path.dirname(USER_DIR)}" "${path.basename(USER_DIR)}"`, err => res(err));
  });

  if (tarErr || !fs.existsSync(archivePath)) {
    backupInProgress = false; return;
  }

  const result = await tgUploadArchive(archivePath, `ABVPS_BACKUP::${USERNAME}`);
  fs.unlink(archivePath, () => {});

  if (result) await dbSaveFileId(result.file_id);
  backupInProgress = false;
}

// ── HTTP server (health check) ─────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK\n");
  } else {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ABVPS Backend Running\n");
  }
});

// ── WebSocket ──────────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  const q = getQuotaInfo();
  ws.send(JSON.stringify({
    type: "shell",
    data: `\r\n\x1b[36mConnected to ABVPS\r\nUser: ${USERNAME} | Plan: ${PLAN.toUpperCase()}\x1b[0m\r\n`
  }));
  ws.send(JSON.stringify({ type: "quota_update", ...q }));

  let shell = spawn("bash", [], {
    cwd: USER_DIR,
    env: { ...process.env, TERM: "xterm-256color", HOME: os.homedir() },
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

  const quotaWatcher = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return clearInterval(quotaWatcher);
    const q2 = getQuotaInfo();
    ws.send(JSON.stringify({ type: "quota_update", ...q2 }));
    if (q2.used > QUOTA_BYTES) {
      try { shell.kill("SIGSTOP"); } catch {}
    } else {
      try { shell.kill("SIGCONT"); } catch {}
    }
  }, 15000);

  ws.on("message", raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "shell") {
      if (shell && shell.stdin.writable)
        shell.stdin.write((msg.cmd || "") + "\n");

    } else if (msg.type === "fm") {
      const safePath = path.resolve(USER_DIR, (msg.path || "/").replace(/^\//, ""));
      if (!safePath.startsWith(USER_DIR)) return;

      if (msg.action === "list") {
        try {
          const entries = fs.readdirSync(safePath, { withFileTypes: true })
            .map(e => ({ name: e.name, is_dir: e.isDirectory() }));
          ws.send(JSON.stringify({ type: "fm_list", path: msg.path || "/", items: entries }));
        } catch {}

      } else if (msg.action === "read") {
        try {
          ws.send(JSON.stringify({ type: "fm_read", content: fs.readFileSync(safePath, "utf8") }));
        } catch {}

      } else if (msg.action === "write") {
        const newBytes = Buffer.byteLength(msg.content || "");
        const q = getQuotaInfo();
        if (q.used + newBytes > QUOTA_BYTES) {
          ws.send(JSON.stringify({ type: "quota_error", message: "Quota exceeded!" }));
          return;
        }
        try {
          fs.mkdirSync(path.dirname(safePath), { recursive: true });
          fs.writeFileSync(safePath, msg.content, "utf8");
          ws.send(JSON.stringify({ type: "fm_refresh_trigger" }));
        } catch {}

      } else if (msg.action === "delete") {
        try {
          fs.rmSync(safePath, { recursive: true, force: true });
          ws.send(JSON.stringify({ type: "fm_refresh_trigger" }));
        } catch {}

      } else if (msg.action === "create_file" || msg.action === "create_dir") {
        try {
          if (msg.action === "create_file") fs.writeFileSync(safePath, "", "utf8");
          else fs.mkdirSync(safePath, { recursive: true });
          ws.send(JSON.stringify({ type: "fm_refresh_trigger" }));
        } catch {}

      } else if (msg.action === "upload") {
        const buffer = Buffer.from(msg.content || "", "base64");
        const q = getQuotaInfo();
        if (q.used + buffer.length > QUOTA_BYTES) {
          ws.send(JSON.stringify({ type: "quota_error", message: "Quota exceeded!" }));
          return;
        }
        try {
          fs.mkdirSync(path.dirname(safePath), { recursive: true });
          fs.writeFileSync(safePath, buffer);
          ws.send(JSON.stringify({ type: "fm_refresh_trigger" }));
        } catch {}
      }
    }
  });

  ws.on("close", async () => {
    clearInterval(quotaWatcher);
    if (shell) shell.kill();
    await fullBackupToTelegram();
  });
});

// ── Start ──────────────────────────────────────────────────────────────────
pullFromTelegram(() => {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`ABVPS Backend ready on port ${PORT} | User: ${USERNAME} | Plan: ${PLAN}`);
  });
});
