const WebSocket = require('ws');
const pty = require('node-pty');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const wss = new WebSocket.Server({ port: 8765 });
const WORKSPACE_DIR = process.env.STORAGE_PATH || "./workspace";
const USERNAME = process.env.USER || "guest";

// Ensure workspace exists
if (!fs.existsSync(WORKSPACE_DIR)) fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

const BANNED = ['xmrig', 'miner', 'minerd', 'minecraft', 'spigot', 'paper', 'apache2'];
setInterval(() => {
    try {
        const ps = execSync('ps aux').toString().toLowerCase();
        for (let app of BANNED) {
            if (ps.includes(app)) {
                console.log(`[SECURITY] Banning user for ${app}`);
                execSync(`curl -s -X POST http://abvps.gt.tc/api.php -H "X-ABSORA-KEY: absora_master_key_2026" -d "action=ban_user&username=${USERNAME}&reason=Hosting ${app}"`);
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
        
        if (payload.type === 'input') {
            shell.write(payload.data || payload.cmd);
        } 
        else if (payload.type === 'fm') {
            // Live File Manager API
            const safePath = path.join(WORKSPACE_DIR, (payload.path || '/').replace(/^(\.\.[\/\\])+/, ''));
            
            try {
                if (payload.action === 'list') {
                    const items = fs.readdirSync(safePath).map(file => {
                        const stats = fs.statSync(path.join(safePath, file));
                        return { name: file, is_dir: stats.isDirectory() };
                    });
                    ws.send(JSON.stringify({ type: 'fm_list', path: payload.path, items }));
                } 
                else if (payload.action === 'read') {
                    const content = fs.readFileSync(safePath, 'utf8');
                    ws.send(JSON.stringify({ type: 'fm_read', path: payload.path, content }));
                } 
                else if (payload.action === 'write') {
                    fs.writeFileSync(safePath, payload.content);
                    ws.send(JSON.stringify({ type: 'fm_refresh_trigger' }));
                } 
                else if (payload.action === 'create_file') {
                    fs.writeFileSync(safePath, '');
                    ws.send(JSON.stringify({ type: 'fm_refresh_trigger' }));
                } 
                else if (payload.action === 'create_dir') {
                    fs.mkdirSync(safePath, { recursive: true });
                    ws.send(JSON.stringify({ type: 'fm_refresh_trigger' }));
                } 
                else if (payload.action === 'delete') {
                    fs.rmSync(safePath, { recursive: true, force: true });
                    ws.send(JSON.stringify({ type: 'fm_refresh_trigger' }));
                } 
                else if (payload.action === 'upload') {
                    const buffer = Buffer.from(payload.content, 'base64');
                    fs.writeFileSync(safePath, buffer);
                    ws.send(JSON.stringify({ type: 'fm_refresh_trigger' }));
                }
            } catch (e) {
                ws.send(JSON.stringify({ type: 'fm_error', message: e.message }));
            }
        }
    });

    ws.on('close', () => shell.kill());
});
