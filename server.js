// ============================================================
//  BUGVPS — WebSocket Backend Server
//  Site: abvps.gt.tc
//  Storage quota: 1 GB per user (hard limit)
// ============================================================

const http        = require("http");
const WebSocket   = require("ws");
const { exec, spawn } = require("child_process");
const fs          = require("fs");
const path        = require("path");
const os          = require("os");

// ── Configuration ─────────────────────────────────────────────
const PORT           = process.env.PORT         || 8080;
const USERNAME       = process.env.VPS_USER     || "guest";
const GITHUB_TOKEN   = process.env.GH_TOKEN     || "";
const REPO_OWNER     = process.env.REPO_OWNER   || "AADI-playz23";
const STORAGE_REPO   = process.env.STORAGE_REPO || "vps-disk";
const USER_DIR       = path.join(os.homedir(), "bugvps-workspace", USERNAME);

const QUOTA_BYTES    = 1 * 1024 * 1024 * 1024;  // 1 GB hard limit
const QUOTA_WARN_PCT = 0.85;                      // warn UI at 85%
// ──────────────────────────────────────────────────────────────

// Ensure workspace directory exists
fs.mkdirSync(USER_DIR, { recursive: true });
process.chdir(USER_DIR);

// ── Storage helpers ────────────────────────────────────────────

/** Recursively sum file sizes under a directory (bytes) */
function getDirSize(dirPath) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, e.name);
      if (e.isDirectory()) total += getDirSize(full);
      else { try { total += fs.statSync(full).size; } catch {} }
    }
  } catch {}
  return total;
}

/** Returns quota info object */
function getQuotaInfo() {
  const used      = getDirSize(USER_DIR);
  const pct       = used / QUOTA_BYTES;
  const usedMB    = (used       / (1024 * 1024)).toFixed(1);
  const quotaMB   = (QUOTA_BYTES / (1024 * 1024)).toFixed(0);
  const remaining = Math.max(0, QUOTA_BYTES - used);
  return { used, quota: QUOTA_BYTES, pct, usedMB, quotaMB, remaining };
}

/**
 * Returns true (and sends WS error) if adding newBytes would exceed quota.
 * Also sends a warning if usage >= QUOTA_WARN_PCT.
 */
function quotaCheck(ws, newBytes = 0) {
  const q = getQuotaInfo();
  if (q.used + newBytes > QUOTA_BYTES) {
    const overMB = ((q.used + newBytes - QUOTA_BYTES) / (1024 * 1024)).toFixed(1);
    ws.send(JSON.stringify({
      type:    "quota_error",
      message: `Storage quota exceeded! You are using ${q.usedMB} MB of your 1 GB limit. ` +
               `This operation needs ${(newBytes/(1024*1024)).toFixed(1)} MB more (${overMB} MB over). ` +
               `Delete files to free space.`
    }));
    return true;   // BLOCKED
  }
  if (q.pct >= QUOTA_WARN_PCT) {
    ws.send(JSON.stringify({
      type:    "quota_warn",
      message: `Warning: Storage at ${(q.pct * 100).toFixed(1)}% — ${q.usedMB} MB / ${q.quotaMB} MB used.`
    }));
  }
  return false;    // ALLOWED
}

// ── GitHub sync ────────────────────────────────────────────────

function pullFromGitHub(callback) {
  if (!GITHUB_TOKEN) return callback && callback();
  const repoUrl  = `https://${GITHUB_TOKEN}@github.com/${REPO_OWNER}/${STORAGE_REPO}.git`;
  const cloneDir = path.join(os.homedir(), "vps-disk-repo");
  if (fs.existsSync(cloneDir)) {
    exec(`git -C ${cloneDir} pull`, () => syncFromRepo(cloneDir, callback));
  } else {
    exec(`git clone ${repoUrl} ${cloneDir}`, (err) => {
      if (!err) syncFromRepo(cloneDir, callback);
      else      callback && callback();
    });
  }
}

function syncFromRepo(repoDir, callback) {
  const src = path.join(repoDir, "files", USERNAME);
  if (fs.existsSync(src)) exec(`cp -r ${src}/. ${USER_DIR}/`, () => callback && callback());
  else                    callback && callback();
}

function pushToGitHub(message = "Auto-sync") {
  if (!GITHUB_TOKEN) return;
  const repoUrl  = `https://${GITHUB_TOKEN}@github.com/${REPO_OWNER}/${STORAGE_REPO}.git`;
  const cloneDir = path.join(os.homedir(), "vps-disk-repo");
  const destDir  = path.join(cloneDir, "files", USERNAME);
  fs.mkdirSync(destDir, { recursive: true });
  exec(`cp -r ${USER_DIR}/. ${destDir}/`, (err) => {
    if (err) return console.error("[GIT-SYNC] Copy failed:", err.message);
    const cmds = [
      `git -C ${cloneDir} config user.email "bugvps@abvps.gt.tc"`,
      `git -C ${cloneDir} config user.name  "BUGVPS Bot"`,
      `git -C ${cloneDir} add -A`,
      `git -C ${cloneDir} diff --cached --quiet || git -C ${cloneDir} commit -m "${message} [${USERNAME}]"`,
      `git -C ${cloneDir} push ${repoUrl} HEAD:main`
    ].join(" && ");
    exec(cmds, (e, _o, stderr) => {
      if (e) console.error("[GIT-SYNC] Push failed:", stderr);
      else   console.log("[GIT-SYNC] Pushed:", message);
    });
  });
}

// ── HTTP server ────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ABVPS Node Online — abvps.gt.tc\n");
});

// ── WebSocket server ───────────────────────────────────────────
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  console.log(`[WS] Connected — user: ${USERNAME}`);

  // Welcome banner + initial quota
  const q = getQuotaInfo();
  ws.send(JSON.stringify({
    type: "shell",
    data: `\r\n\x1b[36m╔══════════════════════════════════════════╗\r\n` +
          `║          ABVPS Glass Core Online         ║\r\n` +
          `║  User : ${USERNAME.padEnd(32)}║\r\n` +
          `║  Site : abvps.gt.tc                      ║\r\n` +
          `║  Quota: ${(q.usedMB + " MB / " + q.quotaMB + " MB").padEnd(32)}║\r\n` +
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

  // Periodic quota watcher — checks every 15 s
  // If user writes large files via shell commands, this catches it
  const quotaWatcher = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return clearInterval(quotaWatcher);
    const q2 = getQuotaInfo();
    ws.send(JSON.stringify({ type: "quota_update", ...q2 }));
    if (q2.used > QUOTA_BYTES) {
      // Hard-stop the shell until they free space
      ws.send(JSON.stringify({
        type:    "quota_error",
        message: `QUOTA EXCEEDED (${q2.usedMB} MB / ${q2.quotaMB} MB). Shell is paused. Delete files to resume.`
      }));
      try { shellProcess.kill("SIGSTOP"); } catch {}
    } else {
      // Resume shell if they deleted enough
      try { shellProcess.kill("SIGCONT"); } catch {}
    }
  }, 15000);

  // Message router
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── Shell command ────────────────────────────────────────
    if (msg.type === "shell") {
      if (shellProcess && shellProcess.stdin.writable)
        shellProcess.stdin.write((msg.cmd || "") + "\n");
    }

    // ── Quota query ──────────────────────────────────────────
    else if (msg.type === "get_quota") {
      ws.send(JSON.stringify({ type: "quota_update", ...getQuotaInfo() }));
    }

    // ── File Manager ─────────────────────────────────────────
    else if (msg.type === "fm") {
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

      // WRITE (editor save)
      } else if (action === "write") {
        const newContent = msg.content || "";
        let existingSize = 0;
        try { existingSize = fs.statSync(safePath).size; } catch {}
        const delta = Buffer.byteLength(newContent, "utf8") - existingSize;
        if (delta > 0 && quotaCheck(ws, delta)) return;
        try {
          fs.mkdirSync(path.dirname(safePath), { recursive: true });
          fs.writeFileSync(safePath, newContent, "utf8");
          pushToGitHub(`Edit ${path.basename(safePath)}`);
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
          pushToGitHub(`Delete ${path.basename(safePath)}`);
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
          pushToGitHub(`Create ${path.basename(safePath)}`);
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
          pushToGitHub(`Create folder ${path.basename(safePath)}`);
          ws.send(JSON.stringify({ type: "fm_refresh_trigger" }));
          ws.send(JSON.stringify({ type: "quota_update", ...getQuotaInfo() }));
        } catch (e) {
          ws.send(JSON.stringify({ type: "fm_error", message: "Cannot create folder: " + e.message }));
        }

      // UPLOAD (base64)
      } else if (action === "upload") {
        const buffer = Buffer.from(msg.content || "", "base64");
        if (quotaCheck(ws, buffer.length)) return;
        try {
          fs.mkdirSync(path.dirname(safePath), { recursive: true });
          fs.writeFileSync(safePath, buffer);
          pushToGitHub(`Upload ${path.basename(safePath)}`);
          ws.send(JSON.stringify({ type: "fm_refresh_trigger" }));
          ws.send(JSON.stringify({ type: "quota_update", ...getQuotaInfo() }));
        } catch (e) {
          ws.send(JSON.stringify({ type: "fm_error", message: "Cannot upload: " + e.message }));
        }
      }
    }
  });

  ws.on("close", () => {
    console.log("[WS] Disconnected");
    clearInterval(quotaWatcher);
    if (shellProcess) shellProcess.kill();
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

// ── Boot ───────────────────────────────────────────────────────
pullFromGitHub(() => {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[ABVPS] Server online — port ${PORT} — user: ${USERNAME}`);
    console.log(`[ABVPS] Workspace  : ${USER_DIR}`);
    console.log(`[ABVPS] Quota      : 1 GB per user`);
    console.log(`[ABVPS] Site       : abvps.gt.tc`);
  });
});
