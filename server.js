const WebSocket = require('ws');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 8765;

const BASE_DIR = process.env.STORAGE_PATH ? path.resolve(process.env.STORAGE_PATH) : process.cwd();
const USERNAME = process.env.VPS_USER || "guest";
const WORKSPACE_DIR = path.resolve(BASE_DIR, "users", USERNAME);

if (!fs.existsSync(WORKSPACE_DIR)) {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}

try {
    execSync(`git config user.name "BUGVPS Auto-Daemon"`, { cwd: BASE_DIR });
    execSync(`git config user.email "system@bugvps.local"`, { cwd: BASE_DIR });
} catch(e) {}

function toVirtual(realPath) {
    let rel = path.relative(WORKSPACE_DIR, realPath).replace(/\\/g, '/');
    return rel === '' ? '/' : '/' + rel;
}

function toReal(virtualPath) {
    let cleanPath = virtualPath.replace(/^\//, '');
    let realPath = path.resolve(WORKSPACE_DIR, cleanPath);
    if (!realPath.startsWith(WORKSPACE_DIR)) return WORKSPACE_DIR; 
    return realPath;
}

const wss = new WebSocket.Server({ host: '0.0.0.0', port: PORT });
console.log(`Compute Node Active. Storage mounted at ${BASE_DIR}`);

let isSyncing = false;

setInterval(() => {
    if (isSyncing) return; 
    
    try {
        const status = execSync(`git status --porcelain "users/${USERNAME}"`, { cwd: BASE_DIR }).toString().trim();
        
        if (status.length > 0) {
            isSyncing = true;
            execSync(`git add "users/${USERNAME}"`, { cwd: BASE_DIR, stdio: 'ignore' });
            execSync(`git commit -m "[Auto-Sync] Workspace updated by ${USERNAME}"`, { cwd: BASE_DIR, stdio: 'ignore' });
            execSync(`git push origin HEAD:main`, { cwd: BASE_DIR, stdio: 'ignore' });
            
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: "fm_refresh_trigger" }));
                }
            });
            isSyncing = false;
        }
    } catch (e) {
        isSyncing = false;
    }
}, 3000);

wss.on('connection', (ws) => {
    let currentDir = WORKSPACE_DIR;
    ws.send(JSON.stringify({ type: "shell", data: "BUGVPS OS Initialized...\n[PRIVATE VAULT SECURED]\n[3-SEC AUTO-SYNC DAEMON ACTIVE]\nWorkspace mounted at /\n\n" }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const msgType = data.type || "shell";

            if (msgType === "ping") return;

            // THE FIX: Self-Destruct Sequence
            if (msgType === "kill") {
                ws.send(JSON.stringify({ type: "shell", data: "\n[SYSTEM] Terminate signal received. Syncing final data...\n" }));
                
                try {
                    // Final forceful sync before death
                    execSync(`git add "users/${USERNAME}" && git commit -m "Final sync before shutdown" && git push origin HEAD:main`, { cwd: BASE_DIR, stdio: 'ignore' });
                } catch(e) {}
                
                ws.send(JSON.stringify({ type: "shell", data: "[SYSTEM] Hardware shutting down. Goodbye.\n" }));
                
                // Kill the Node process. This breaks the while loop in bugvps.yml and ends the runner!
                setTimeout(() => { process.exit(0); }, 1000);
                return;
            }

            if (msgType === "fm") {
                const action = data.action;
                const absPath = toReal(data.path || "/");

                try {
                    if (action === "list") {
                        if (fs.existsSync(absPath) && fs.statSync(absPath).isDirectory()) {
                            let items = fs.readdirSync(absPath).map(item => {
                                let itemPath = path.join(absPath, item);
                                let isDir = fs.statSync(itemPath).isDirectory();
                                let size = isDir ? 0 : fs.statSync(itemPath).size;
                                return { name: item, is_dir: isDir, size: size };
                            });
                            items.sort((a, b) => (a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : (a.is_dir ? -1 : 1)));
                            ws.send(JSON.stringify({ type: "fm_list", path: toVirtual(absPath), items: items }));
                        }
                    } else if (action === "read") {
                        if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
                            const content = fs.readFileSync(absPath, 'utf8');
                            ws.send(JSON.stringify({ type: "fm_read", path: toVirtual(absPath), content: content }));
                        }
                    } else if (action === "write") {
                        fs.writeFileSync(absPath, data.content || '', 'utf8');
                    } else if (action === "create_file") {
                        if (!fs.existsSync(absPath)) fs.writeFileSync(absPath, '', 'utf8');
                    } else if (action === "create_dir") {
                        if (!fs.existsSync(absPath)) fs.mkdirSync(absPath, { recursive: true });
                    } else if (action === "delete") {
                        if (fs.statSync(absPath).isDirectory()) fs.rmSync(absPath, { recursive: true, force: true });
                        else fs.unlinkSync(absPath);
                    }
                } catch (fsErr) {
                    ws.send(JSON.stringify({ type: "fm_error", message: fsErr.message }));
                }
                return;
            }

            const cmd = data.cmd;
            if (!cmd) return;

            if (cmd.startsWith("cd ")) {
                const target = cmd.substring(3).trim();
                const newDir = path.resolve(currentDir, target);
                
                if (!newDir.startsWith(WORKSPACE_DIR)) {
                    ws.send(JSON.stringify({ type: "shell", data: "Access Denied.\n" }));
                    return;
                }
                
                if (fs.existsSync(newDir) && fs.statSync(newDir).isDirectory()) {
                    currentDir = newDir;
                    ws.send(JSON.stringify({ type: "shell", data: `Changed directory to ${toVirtual(currentDir)}\n` }));
                } else {
                    ws.send(JSON.stringify({ type: "shell", data: `cd: ${target}: No such file or directory\n` }));
                }
                return;
            }

            exec(cmd, { cwd: currentDir }, (error, stdout, stderr) => {
                if (stdout) ws.send(JSON.stringify({ type: "shell", data: stdout }));
                if (stderr) ws.send(JSON.stringify({ type: "shell", data: stderr }));
                if (error && !stdout && !stderr) ws.send(JSON.stringify({ type: "shell", data: `Error: ${error.message}\n` }));
            });

        } catch (e) { }
    });
});
