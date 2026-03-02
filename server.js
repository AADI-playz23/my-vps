const WebSocket = require('ws');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 8765;

// Absolute path targeting ensures files NEVER end up in runner temp storage
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

const wss = new WebSocket.Server({ port: PORT });
console.log(`Compute Node Active. Storage mounted at ${BASE_DIR}`);

// --- 3-SECOND REAL-TIME AUTO-SYNC DAEMON ---
let isSyncing = false;

setInterval(() => {
    if (isSyncing) return; // Prevent overlapping git commands
    
    try {
        // Check if ANY files changed in the background (via bash or UI)
        const status = execSync(`git status --porcelain "users/${USERNAME}"`, { cwd: BASE_DIR }).toString().trim();
        
        if (status.length > 0) {
            isSyncing = true;
            execSync(`git add "users/${USERNAME}"`, { cwd: BASE_DIR, stdio: 'ignore' });
            execSync(`git commit -m "[Auto-Sync] Workspace updated by ${USERNAME}"`, { cwd: BASE_DIR, stdio: 'ignore' });
            execSync(`git push origin HEAD:main`, { cwd: BASE_DIR, stdio: 'ignore' });
            
            // Broadcast to frontend to refresh the File Manager UI silently
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

            // Manual File Manager controls
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
                    // We no longer trigger sync here manually. The 3-second daemon will catch it automatically!
                } catch (fsErr) {
                    ws.send(JSON.stringify({ type: "fm_error", message: fsErr.message }));
                }
                return;
            }

            // Terminal Command handling
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
