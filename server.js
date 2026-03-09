const { execSync } = require('child_process');
const PLAN = process.env.PLAN || "free";
const USERNAME = process.env.VPS_USER || "guest";
const WORKSPACE_DIR = process.env.STORAGE_PATH;

// Watchdog: Kills miners and forbidden servers
const FORBIDDEN = ['xmrig', 'miner', 'minecraft', 'spigot', 'http.server', 'serveo', 'ngrok'];
setInterval(() => {
    try {
        const ps = execSync('ps aux').toString().toLowerCase();
        for (let app of FORBIDDEN) {
            if (PLAN === "ultra" && !['xmrig', 'miner'].includes(app)) continue; // Ultra gets server privileges
            if (ps.includes(app)) {
                if (app === 'express' && ps.includes('server.js')) continue;
                execSync(`curl -H "X-ABSORA-KEY: absora_master_key_2026" -X POST https://abvps.rf.gd/api.php -d "action=ban_user&username=${USERNAME}&reason=Hosting ${app}"`);
                process.exit(1); 
            }
        }
    } catch (e) {}
}, 15000);

// Storage Limits: Lite=1GB, Pro/Elite=2GB, Ultra=4.5GB
const LIMITS = { "free": 0, "lite": 1000, "pro": 2000, "elite": 2000, "ultra": 4500 };
setInterval(() => {
    if (PLAN === "free") return;
    const sizeMB = parseInt(execSync(`du -sm ${WORKSPACE_DIR} --exclude=external_drive | cut -f1`).toString() || "0");
    if (sizeMB > LIMITS[PLAN]) return; // Stop syncing if over limit

    try {
        execSync(`git add .`, { cwd: WORKSPACE_DIR, stdio: 'ignore' });
        execSync(`git checkout --orphan temp_sync && git commit -m "Auto-Sync"`, { cwd: WORKSPACE_DIR, stdio: 'ignore' });
        execSync(`git branch -D main && git branch -m main`, { cwd: WORKSPACE_DIR, stdio: 'ignore' });
        execSync(`git push -f origin main`, { cwd: WORKSPACE_DIR, stdio: 'ignore' });
    } catch (e) {}
}, 30000);

// (Add your existing Express/WebSocket server code below this)
