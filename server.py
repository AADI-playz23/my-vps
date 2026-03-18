import asyncio
import websockets
import json
import os
import sys
import http
import psutil

COMMAND_TIMEOUT = 60
FM_DIR = '/tmp/fm'   # temp file manager storage

async def shell_handler(websocket):
    current_dir = os.path.expanduser("~")
    os.makedirs(FM_DIR, exist_ok=True)

    # Read plan limits from env (set by main.yml)
    plan       = os.environ.get('VPS_PLAN',       'free')
    cpu_cores  = float(os.environ.get('VPS_CPU',  '1'))
    ram_mb     = int(os.environ.get('VPS_RAM',    '512'))
    fm_enabled = os.environ.get('VPS_FM',         'false').lower() == 'true'
    storage_mb = int(os.environ.get('VPS_STORAGE','0'))

    print(f"[+] Client connected | plan={plan} cpu={cpu_cores} ram={ram_mb}MB fm={fm_enabled}")

    await send(websocket, f"Connected — AbsoraCloud VPS ({plan} plan)\n")

    try:
        async for message in websocket:
            try:
                data = json.loads(message)
            except json.JSONDecodeError:
                await send(websocket, "Error: Invalid JSON.\n")
                continue

            cmd     = data.get('cmd', '').strip()
            content = data.get('content', '')

            if not cmd:
                continue

            # ── Internal: metrics ─────────────────────────────────
            if cmd == '__metrics__':
                await send_metrics(websocket, cpu_cores, ram_mb, storage_mb)
                continue

            # ── Internal: file manager list ───────────────────────
            if cmd == '__fm_list__':
                if not fm_enabled:
                    await send(websocket, "File manager not available on your plan.\n")
                    continue
                try:
                    files = sorted(os.listdir(FM_DIR))
                except: files = []
                await websocket.send(json.dumps({"type": "file_list", "data": files}))
                continue

            # ── Internal: file manager read ───────────────────────
            if cmd.startswith('__fm_read__ '):
                if not fm_enabled:
                    await send(websocket, "File manager not available on your plan.\n")
                    continue
                filename = cmd[len('__fm_read__ '):].strip()
                filename = os.path.basename(filename)  # safety
                filepath = os.path.join(FM_DIR, filename)
                try:
                    with open(filepath, 'r', errors='replace') as f:
                        file_content = f.read()
                    await websocket.send(json.dumps({"type": "file_content", "data": {"filename": filename, "content": file_content}}))
                except FileNotFoundError:
                    await websocket.send(json.dumps({"type": "file_content", "data": {"filename": filename, "content": ""}}))
                continue

            # ── Internal: file manager write ──────────────────────
            if cmd.startswith('__fm_write__ '):
                if not fm_enabled:
                    await send(websocket, "File manager not available on your plan.\n")
                    continue
                filename = cmd[len('__fm_write__ '):].strip()
                filename = os.path.basename(filename)  # safety
                filepath = os.path.join(FM_DIR, filename)

                # Check storage limit
                if storage_mb > 0:
                    used = sum(os.path.getsize(os.path.join(FM_DIR, f)) for f in os.listdir(FM_DIR) if os.path.isfile(os.path.join(FM_DIR, f)))
                    if used + len(content.encode()) > storage_mb * 1024 * 1024:
                        await send(websocket, f"Storage limit reached ({storage_mb}MB).\n")
                        continue

                try:
                    with open(filepath, 'w') as f:
                        f.write(content)
                    await send(websocket, f"File saved: {filename}\n")
                except Exception as e:
                    await send(websocket, f"Error saving file: {e}\n")
                continue

            # ── Built-in: clear ───────────────────────────────────
            if cmd == 'clear':
                await websocket.send(json.dumps({"type": "clear"}))
                continue

            # ── Built-in: cd ──────────────────────────────────────
            if cmd.startswith('cd'):
                parts  = cmd.split(None, 1)
                target = os.path.expanduser(parts[1] if len(parts) > 1 else '~')
                if not os.path.isabs(target):
                    target = os.path.join(current_dir, target)
                try:
                    os.chdir(target)
                    current_dir = os.getcwd()
                except FileNotFoundError:
                    await send(websocket, f"bash: cd: {target}: No such file or directory\n")
                except PermissionError:
                    await send(websocket, f"bash: cd: {target}: Permission denied\n")
                await websocket.send(json.dumps({"type": "cwd", "data": current_dir}))
                continue

            # ── All other shell commands ──────────────────────────
            try:
                process = await asyncio.create_subprocess_shell(
                    cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=current_dir,
                    env={**os.environ,
                         "TERM": "xterm-256color",
                         "HOME": os.path.expanduser("~"),
                         "VPS_PLAN": plan}
                )

                async def stream(pipe):
                    while True:
                        chunk = await pipe.read(4096)
                        if not chunk: break
                        await send(websocket, chunk.decode(errors='replace'))

                try:
                    await asyncio.wait_for(
                        asyncio.gather(stream(process.stdout), stream(process.stderr)),
                        timeout=COMMAND_TIMEOUT
                    )
                    await process.wait()
                except asyncio.TimeoutError:
                    try: process.kill()
                    except: pass
                    await send(websocket, f"\n[Timeout] Command killed after {COMMAND_TIMEOUT}s\n")

            except Exception as e:
                await send(websocket, f"Error: {e}\n")

    except websockets.exceptions.ConnectionClosedOK:
        print("[-] Client disconnected (clean)")
    except websockets.exceptions.ConnectionClosedError as e:
        print(f"[-] Client disconnected (error): {e}")
    except Exception as e:
        print(f"[!] Unexpected error: {e}")


async def send_metrics(websocket, cpu_cores, ram_mb, storage_mb):
    try:
        cpu  = psutil.cpu_percent(interval=0.5)
        mem  = psutil.virtual_memory()
        used_ram_mb = mem.used / (1024*1024)
        ram_pct     = min(100, int(used_ram_mb / ram_mb * 100)) if ram_mb else 0

        # Disk usage of FM dir
        disk_pct = 0
        if storage_mb > 0 and os.path.isdir(FM_DIR):
            used_bytes = sum(
                os.path.getsize(os.path.join(FM_DIR, f))
                for f in os.listdir(FM_DIR)
                if os.path.isfile(os.path.join(FM_DIR, f))
            )
            disk_pct = min(100, int(used_bytes / (storage_mb * 1024 * 1024) * 100))

        await websocket.send(json.dumps({
            "type": "metrics",
            "data": {
                "cpu":     round(cpu, 1),
                "ram":     ram_pct,
                "ram_mb":  round(used_ram_mb, 1),
                "disk":    disk_pct,
                "cpu_cores": cpu_cores,
            }
        }))
    except Exception as e:
        print(f"Metrics error: {e}")


async def send(websocket, text):
    if text:
        await websocket.send(json.dumps({"type": "terminal", "data": text}))


from websockets.http11 import Response
from websockets.datastructures import Headers

def health_check(connection, request):
    # Cloudflare and load balancers send plain HTTP GET health checks.
    # Return a 200 so they don't flood the logs with errors.
    upgrade = request.headers.get("Upgrade", "").lower()
    if upgrade != "websocket":
        headers = Headers([("Content-Type", "text/plain"), ("Content-Length", "2")])
        return connection.respond(http.HTTPStatus.OK, headers, b"OK")

async def main():
    print(f"[AbsoraCloud] WS shell server starting on 0.0.0.0:5000")
    print(f"[AbsoraCloud] Plan={os.environ.get('VPS_PLAN','free')} CPU={os.environ.get('VPS_CPU','1')} RAM={os.environ.get('VPS_RAM','512')}MB")
    async with websockets.serve(
        shell_handler, "0.0.0.0", 5000,
        ping_interval=30,
        ping_timeout=60,
        max_size=10 * 1024 * 1024,
        process_request=health_check,
    ):
        print("[AbsoraCloud] Ready.")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
