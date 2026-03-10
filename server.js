const WebSocket = require('ws');
const pty = require('node-pty');
const { execSync } = require('child_process');

const wss = new WebSocket.Server({ port: 8765 });
const WORKSPACE_DIR = process.env.STORAGE_PATH || "./workspace";
const USERNAME = process.env.USER || "guest";

// Anti-Abuse Scanner (Bans Crypto & Games)
const BANNED = ['xmrig', 'miner', 'minerd', 'minecraft', 'spigot', 'paper', 'apache2'];

setInterval(() => {
    try {
        const ps = execSync('ps aux').toString().toLowerCase();
        for (let app of BANNED) {
            if (ps.includes(app)) {
                console.log(`[SECURITY] Banning user for ${app}`);
                // Tell the MySQL database to permanently ban this user
                execSync(`curl -s -X POST http://abvps.rf.gd/api.php -H "X-ABSORA-KEY: absora_master_key_2026" -d "action=ban_user&username=${USERNAME}&reason=Hosting ${app}"`);
                process.exit(1); 
            }
        }
    } catch (e) {}
}, 10000); 

wss.on('connection', (ws) => {
    const shell = pty.spawn('bash', [], { name: 'xterm-color', cols: 80, rows: 24, cwd: WORKSPACE_DIR, env: process.env });
    shell.on('data', (data) => ws.send(JSON.stringify({ type: "shell", data })));
    ws.on('message', (msg) => {
        const payload = JSON.parse(msg);
        if (payload.type === 'input') shell.write(payload.data);
    });
});
