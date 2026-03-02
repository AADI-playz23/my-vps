const WebSocket = require('ws');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 8765;

const BASE_DIR = process.env.STORAGE_PATH ? path.resolve(process.cwd(), process.env.STORAGE_PATH) : process.cwd();
const USERNAME = process.env.VPS_USER || "guest";
const WORKSPACE_DIR = path.resolve(BASE_DIR, "users", USERNAME);

if (!fs.existsSync(WORKSPACE_DIR)) {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}

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

// REAL-TIME BACKGROUND SYNC (Does not freeze the websocket)
function syncToGithubAsync(actionMsg) {
    const cmd = `git pull origin main --rebase && git add "users/${USERNAME}" && git commit -m "[Real-Time] ${actionMsg} by ${USERNAME}" && git push`;
    exec(cmd, { cwd: BASE_DIR }, (error) => {
        if (error) console.error("Auto-sync error:", error.message);
        else console.log(`Real-time sync complete: ${actionMsg}`);
    });
}

const wss = new WebSocket.Server({ port: PORT });
console.log(`Compute Node Active. Storage mounted at ${BASE_DIR}`);

wss.on('connection', (ws) => {
    let currentDir = WORKSPACE_DIR;
    ws.send(JSON.stringify({ type: "shell", data: "BUGVPS OS Initialized...\n[PRIVATE STORAGE MOUNTED]\n[REAL-TIME SYNC ENABLED]\nWorkspace securely mounted at /\n\n" }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const msgType = data.type || "shell";

            if (msgType === "ping") return;

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
                        syncToGithubAsync(`Edited file ${path.basename(absPath)}`); // Real-time
                        ws.send(JSON.stringify({ type: "fm_msg", message: `Saved: ${path.basename(absPath)}` }));
                    } else if (action === "create_file") {
                        if (!fs.existsSync(absPath)) {
                            fs.writeFileSync(absPath, '', 'utf8');
                            syncToGithubAsync(`Created file ${path.basename(absPath)}`); // Real-time
                            ws.send(JSON.stringify({ type: "fm_msg", message: `Created File: ${path.basename(absPath)}` }));
                        }
                    } else if (action === "create_dir") {
                        if (!fs.existsSync(absPath)) {
                            fs.mkdirSync(absPath, { recursive: true });
                            syncToGithubAsync(`Created folder ${path.basename(absPath)}`); // Real-time
                            ws.send(JSON.stringify({ type: "fm_msg", message: `Created Folder: ${path.basename(absPath)}` }));
                        }
                    } else if (action === "delete") {
                        if (fs.statSync(absPath).isDirectory()) {
                            fs.rmSync(absPath, { recursive: true, force: true });
                        } else {
                            fs.unlinkSync(absPath);
                        }
                        syncToGithubAsync(`Deleted ${path.basename(absPath)}`); // Real-time
                        ws.send(JSON.stringify({ type: "fm_msg", message: `Deleted: ${path.basename(absPath)}` }));
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
