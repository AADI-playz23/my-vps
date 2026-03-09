const WebSocket = require('ws');
const pty = require('node-pty');
const { execSync } = require('child_process');
const fs = require('fs');

const wss = new WebSocket.Server({ port: 8765 });
const PLAN = process.env.PLAN || "free";
const USERNAME = process.env.VPS_USER || "guest";
const WORKSPACE_DIR = process.env.STORAGE_PATH;

// --- WATCHDOG: Anti-Abuse Scanner ---
const FORBIDDEN = ['xmrig', 'miner', 'minecraft', 'spigot', 'http.server', 'serveo', 'ngrok'];
setInterval(() => {
    try {
        const ps = execSync('ps aux').toString().toLowerCase();
        for (let app of FORBIDDEN) {
            // Enterprise Ultra users are allowed to run game servers/web servers, but NEVER miners.
            if (PLAN === "ultra" && !['xmrig', 'miner'].includes(app)) continue; 
            
            if (ps.includes(app)) {
                if (app === 'express' && ps.includes('server.js')) continue; // Ignore self

                console.log(`[SECURITY] Violation: ${app}`);
                execSync(`curl -H "X-ABSORA-KEY: absora_master_key_2026" -X POST https://abvps.rf.gd/api.php -d "action=ban_user&username=${USERNAME}&reason=Hosting ${app}"`);
                process.exit(1); // Kill container immediately
            }
        }
    } catch (e) {}
}, 15000);

// --- QUOTA ENGINE: Auto-Sync to Git Shards ---
// Limits set in MB. Ultra gets 4.5GB (leaving 500MB safety margin for Git history limits).
const LIMITS = { "free": 0, "lite": 1000, "pro": 2000, "elite": 2000, "ultra": 4500 };
let isSyncing = false;

setInterval(() => {
    if (PLAN === "free" || isSyncing) return;
    
    // Ignore external_drive (BYOS) from the size calculation!
    const sizeMB = parseInt(execSync(`du -sm ${WORKSPACE_DIR} --exclude=external_drive | cut -f1`).toString() || "0");
    
    if (sizeMB > LIMITS[PLAN]) {
        broadcast(`\r\n\x1b[31m[STORAGE FULL] Limit reached (${sizeMB}MB / ${LIMITS[PLAN]}MB). Sync Disabled.\x1b[0m\r\n`);
        return;
    }

    try {
        isSyncing = true;
        // SHALLOW SQUASH: Wipes old git history to prevent the 5GB hard-ban.
        execSync(`git add .`, { cwd: WORKSPACE_DIR, stdio: 'ignore' });
        execSync(`git checkout --orphan temp_sync && git commit -m "Auto-Sync"`, { cwd: WORKSPACE_DIR, stdio: 'ignore' });
        execSync(`git branch -D main && git branch -m main`, { cwd: WORKSPACE_DIR, stdio: 'ignore' });
        execSync(`git push -f origin main`, { cwd: WORKSPACE_DIR, stdio: 'ignore' });
        isSyncing = false;
    } catch (e) { isSyncing = false; }
}, 30000); 

function broadcast(msg) {
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: "shell", data: msg })); });
}

// --- PTY TERMINAL HANDLER ---
wss.on('connection', (ws) => {
    const shell = pty.spawn('bash', [], {
        name: 'xterm-color',
        cols: 80,
        rows: 24,
        cwd: WORKSPACE_DIR,
        env: process.env
    });

    shell.on('data', (data) => ws.send(JSON.stringify({ type: "shell", data })));

    ws.on('message', (msg) => {
        const payload = JSON.parse(msg);
        if (payload.type === 'input') shell.write(payload.data);
        if (payload.type === 'kill') {
            ws.send(JSON.stringify({ type: "shell", data: "\r\n[SYSTEM] Terminating Session & Forcing Final Sync...\r\n" }));
            setTimeout(() => process.exit(0), 2000);
        }
    });

    ws.on('close', () => shell.kill());
});
