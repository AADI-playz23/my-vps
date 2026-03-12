const http            = require("http");
const WebSocket       = require("ws");
const { exec, spawn } = require("child_process");
const fs              = require("fs");
const path            = require("path");
const os              = require("os");
const https           = require("https");

const PORT       = process.env.PORT         || 8081;
const USERNAME   = process.env.VPS_USER     || "guest";
const PLAN       = process.env.PLAN         || "free";
const TG_TOKEN   = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID = process.env.TG_CHAT_ID   || "";
const DB_PROXY   = "https://abvps.gt.tc/db_proxy.php";
const DB_SECRET  = process.env.DB_PROXY_SECRET || "";

const USER_DIR   = path.join(os.homedir(), "abvps-workspace", USERNAME);
const TMP_DIR    = os.tmpdir();
const QUOTA_BYTES = 1 * 1024 * 1024 * 1024; // 1GB

fs.mkdirSync(USER_DIR, { recursive: true });

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

function getQuota() {
  const used   = getDirSize(USER_DIR);
  const pct    = used / QUOTA_BYTES;
  const usedMB = (used / (1024 * 1024)).toFixed(1);
  const maxMB  = (QUOTA_BYTES / (1024 * 1024)).toFixed(0);
  return { used, quota: QUOTA_BYTES, pct, usedMB, maxMB };
}

// ── DB proxy ───────────────────────────────────────────────────────────────
function dbQuery(sql, params = []) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ secret: DB_SECRET, sql, params });
    const safe    = payload.replace(/'/g, "'\\''");
    exec(`curl -s -X POST "${DB_PROXY}" -H "Content-Type: application/json" -d '${safe}'`, (err, out) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(out)); } catch { resolve(null); }
    });
  });
}

async function dbGetFileId() {
  const r = await dbQuery("SELECT tg_file_id FROM user_storage WHERE username=? ORDER BY updated_at DESC LIMIT 1", [USERNAME]);
  return r?.rows?.[0]?.tg_file_id || null;
}

async function dbSaveFileId(fileId) {
  await dbQuery(
    "INSERT INTO user_storage (username,tg_file_id,updated_at) VALUES (?,?,NOW()) ON DUPLICATE KEY UPDATE tg_file_id=VALUES(tg_file_id),updated_at=NOW()",
    [USERNAME, fileId]
  );
}

// ── Telegram ───────────────────────────────────────────────────────────────
function tgUpload(filePath, caption) {
  return new Promise((resolve) => {
    if (!TG_TOKEN || !TG_CHAT_ID) return resolve(null);
    const cmd = `curl -s -F chat_id="${TG_CHAT_ID}" -F caption="${caption}" -F document=@"${filePath}" "https://api.telegram.org/bot${TG_TOKEN}/sendDocument"`;
    exec(cmd, (err, out) => {
      if (err) return resolve(null);
      try { const r = JSON.parse(out); resolve(r.ok ? { file_id: r.result.document.file_id } : null); }
      catch { resolve(null); }
    });
  });
}

function tgGetFilePath(fileId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ file_id: fileId });
    const req  = https.request({
      hostname: "api.telegram.org",
      path: `/bot${TG_TOKEN}/getFile`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

async function tgDownload(fileId, dest) {
  if (!TG_TOKEN) return false;
  try {
    const r = await tgGetFilePath(fileId);
    if (!r.ok) return false;
    const url = `https://api.telegram.org/file/bot${TG_TOKEN}/${r.result.file_path}`;
    await new Promise((res, rej) => exec(`curl -s -o "${dest}" "${url}"`, err => err ? rej(err) : res()));
    return fs.existsSync(dest);
  } catch { return false; }
}

// ── Restore ────────────────────────────────────────────────────────────────
async function pullFromTelegram(cb) {
  const welcome = path.join(USER_DIR, "welcome.txt");
  const writeWelcome = () => {
    if (!fs.existsSync(welcome)) fs.writeFileSync(welcome, `Hello ${USERNAME}!\nPlan: ${PLAN.toUpperCase()}\n\nFree: no backup. Paid: auto-backup on disconnect.\n`);
  };

  if (PLAN === "free") { writeWelcome(); return cb && cb(); }

  const fileId = await dbGetFileId();
  if (!fileId) { writeWelcome(); return cb && cb(); }

  const archive = path.join(TMP_DIR, `restore_${USERNAME}.tar.gz`);
  const ok = await tgDownload(fileId, archive);
  if (!ok) { writeWelcome(); return cb && cb(); }

  exec(`tar -xzf "${archive}" -C "${USER_DIR}" --strip-components=1`, () => {
    fs.unlink(archive, () => {});
    writeWelcome();
    cb && cb();
  });
}

// ── Backup ─────────────────────────────────────────────────────────────────
let backupBusy = false;
async function backupToTelegram() {
  if (!TG_TOKEN || !TG_CHAT_ID || PLAN === "free" || backupBusy) return;
  backupBusy = true;
  const archive = path.join(TMP_DIR, `abvps_${USERNAME}_${Date.now()}.tar.gz`);
  const err = await new Promise(res => exec(`tar -czf "${archive}" -C "${path.dirname(USER_DIR)}" "${path.basename(USER_DIR)}"`, res));
  if (err || !fs.existsSync(archive)) { backupBusy = false; return; }
  const result = await tgUpload(archive, `ABVPS_BACKUP::${USERNAME}`);
  fs.unlink(archive, () => {});
  if (result) await dbSaveFileId(result.file_id);
  backupBusy = false;
}

// ── HTTP server ────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(req.url === "/health" ? "OK\n" : `ABVPS Backend | User:${USERNAME} | Plan:${PLAN}\n`);
});

// ── WebSocket ──────────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  const q = getQuota();
  ws.send(JSON.stringify({ type:"shell", data:`\r\n\x1b[36mABVPS — User: ${USERNAME} | Plan: ${PLAN.toUpperCase()}\x1b[0m\r\n` }));
  ws.send(JSON.stringify({ type:"quota_update", ...q }));

  const shell = spawn("bash", [], {
    cwd: USER_DIR,
    env: { ...process.env, TERM:"xterm-256color", HOME:os.homedir() },
  });

  const send = (type, data) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...data })); };

  shell.stdout.on("data", d => send("shell", { data: d.toString() }));
  shell.stderr.on("data", d => send("shell", { data: d.toString() }));

  const quotaTick = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return clearInterval(quotaTick);
    const q2 = getQuota();
    send("quota_update", q2);
    try { shell.kill(q2.used > QUOTA_BYTES ? "SIGSTOP" : "SIGCONT"); } catch {}
  }, 15000);

  ws.on("message", raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "shell") {
      if (shell?.stdin.writable) shell.stdin.write((msg.cmd || "") + "\n");

    } else if (msg.type === "fm") {
      const safe = path.resolve(USER_DIR, (msg.path || "/").replace(/^\//, ""));
      if (!safe.startsWith(USER_DIR)) return;

      if (msg.action === "list") {
        try {
          const items = fs.readdirSync(safe, { withFileTypes:true })
            .map(e => ({ name:e.name, is_dir:e.isDirectory() }));
          send("fm_list", { path: msg.path || "/", items });
        } catch {}

      } else if (msg.action === "read") {
        try { send("fm_read", { content: fs.readFileSync(safe, "utf8") }); } catch {}

      } else if (msg.action === "write") {
        const nb = Buffer.byteLength(msg.content || "");
        if (getQuota().used + nb > QUOTA_BYTES) { send("quota_error", { message:"Quota exceeded!" }); return; }
        try { fs.mkdirSync(path.dirname(safe), { recursive:true }); fs.writeFileSync(safe, msg.content); send("fm_refresh_trigger", {}); } catch {}

      } else if (msg.action === "delete") {
        try { fs.rmSync(safe, { recursive:true, force:true }); send("fm_refresh_trigger", {}); } catch {}

      } else if (msg.action === "create_file") {
        try { fs.writeFileSync(safe, ""); send("fm_refresh_trigger", {}); } catch {}

      } else if (msg.action === "create_dir") {
        try { fs.mkdirSync(safe, { recursive:true }); send("fm_refresh_trigger", {}); } catch {}

      } else if (msg.action === "upload") {
        const buf = Buffer.from(msg.content || "", "base64");
        if (getQuota().used + buf.length > QUOTA_BYTES) { send("quota_error", { message:"Quota exceeded!" }); return; }
        try { fs.mkdirSync(path.dirname(safe), { recursive:true }); fs.writeFileSync(safe, buf); send("fm_refresh_trigger", {}); } catch {}
      }
    }
  });

  ws.on("close", async () => {
    clearInterval(quotaTick);
    try { shell.kill(); } catch {}
    await backupToTelegram();
  });
});

// ── Start ──────────────────────────────────────────────────────────────────
pullFromTelegram(() => {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`ABVPS Backend listening on :${PORT} | User:${USERNAME} | Plan:${PLAN}`);
  });
});
