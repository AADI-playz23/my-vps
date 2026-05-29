"""
shared_server.py — Multi-tenant WebSocket terminal server (Universal Runner).

Each runner serves ALL plan tiers (mixed). Capacity is tracked by
CPU/RAM used, not user count. When a user disconnects, the freed
resources are immediately offered to the next queued user (paid first).

Hard cap: max 3 runners across the whole system.
Priority queue: enterprise > pro > basic > free.

Environment variables:
  UPSTASH_URL       Upstash Redis REST URL
  UPSTASH_TOKEN     Upstash Redis REST token
  RUNNER_ID         Unique runner identifier
"""

import asyncio
import websockets
import json
import os
import sys
import http
import time
import uuid
import urllib.request

# ── Config ────────────────────────────────────────────────────
RUNNER_TOTAL_CPU = 4.0
RUNNER_TOTAL_RAM = 16384   # MB

UPSTASH_URL   = os.environ.get('UPSTASH_URL',   '')
UPSTASH_TOKEN = os.environ.get('UPSTASH_TOKEN', '')
RUNNER_ID     = os.environ.get('RUNNER_ID', f'runner-{uuid.uuid4().hex[:8]}')
TUNNEL_URL    = ''  # Set after tunnel starts

COMMAND_TIMEOUT = 60
DOCKER_IMAGE    = 'absoracloud-base'

# Plan specs (must match db.php)
PLAN_SPECS = {
    'free':       {'cpu': 0.5, 'ram': 2048,  'storage': 100,  'fm': False, 'session': 3600},
    'basic':      {'cpu': 1.0, 'ram': 4096,  'storage': 3072, 'fm': False, 'session': 10800},
    'pro':        {'cpu': 2.0, 'ram': 8192,  'storage': 4096, 'fm': True,  'session': 21600},
    'enterprise': {'cpu': 4.0, 'ram': 16384, 'storage': 5120, 'fm': True,  'session': 21600},
}

# ── Resource tracking ────────────────────────────────────────
used_cpu = 0.0
used_ram = 0      # MB

# session_id → {container_name, current_dir, websocket, plan, cpu, ram,
#               created_at, expires_at}
sessions = {}


# ═══════════════════════════════════════════════════════════════
#  REDIS HELPERS
# ═══════════════════════════════════════════════════════════════

def redis_exec(args):
    if not UPSTASH_URL or not UPSTASH_TOKEN:
        return None
    try:
        data = json.dumps(args).encode()
        req = urllib.request.Request(
            UPSTASH_URL, data=data,
            headers={
                'Authorization': f'Bearer {UPSTASH_TOKEN}',
                'Content-Type': 'application/json',
            },
            method='POST'
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode())
            return result.get('result')
    except Exception as e:
        print(f"[Redis] Error: {e}")
        return None


def redis_set(key, value, ex=None):
    args = ["SET", key, value]
    if ex:
        args += ["EX", str(ex)]
    return redis_exec(args)


def redis_get(key):
    return redis_exec(["GET", key])


def redis_del(key):
    return redis_exec(["DEL", key])


def redis_set_json(key, data, ex=None):
    return redis_set(key, json.dumps(data), ex)


def redis_get_json(key):
    raw = redis_get(key)
    if raw:
        try:
            return json.loads(raw)
        except:
            pass
    return None


def redis_zpopmax(key):
    """Pop highest-priority item from sorted set."""
    return redis_exec(["ZPOPMAX", key])


def redis_zcard(key):
    return redis_exec(["ZCARD", key])


# ═══════════════════════════════════════════════════════════════
#  RUNNER REGISTRATION & HEARTBEAT
# ═══════════════════════════════════════════════════════════════

def register_runner():
    runner_data = {
        'tunnel_url':    TUNNEL_URL,
        'used_cpu':      0,
        'used_ram':      0,
        'current_users': 0,
        'started_at':    int(time.time()),
        'expires_at':    int(time.time()) + 21600,
    }
    redis_set_json(f"runner:{RUNNER_ID}", runner_data, ex=21600)
    redis_set(f"heartbeat:{RUNNER_ID}", "1", ex=60)
    print(f"[Runner] Registered: {RUNNER_ID} (universal, {RUNNER_TOTAL_CPU} CPU, {RUNNER_TOTAL_RAM}MB RAM)")


def sync_runner_to_redis():
    """Sync current resource usage to Redis."""
    runner_data = {
        'tunnel_url':    TUNNEL_URL,
        'used_cpu':      used_cpu,
        'used_ram':      used_ram,
        'current_users': len(sessions),
        'started_at':    int(time.time()),
        'expires_at':    int(time.time()) + 21600,
    }
    redis_set_json(f"runner:{RUNNER_ID}", runner_data, ex=21600)


def update_runner_tunnel(url):
    global TUNNEL_URL
    TUNNEL_URL = url
    sync_runner_to_redis()
    print(f"[Runner] Tunnel URL set: {url}")


async def heartbeat_loop():
    while True:
        redis_set(f"heartbeat:{RUNNER_ID}", "1", ex=60)
        sync_runner_to_redis()
        await asyncio.sleep(30)


# ═══════════════════════════════════════════════════════════════
#  QUEUE PROCESSOR — pull highest-priority queued user
# ═══════════════════════════════════════════════════════════════

async def queue_processor():
    """Check the priority queue and accept sessions if we have capacity."""
    global TUNNEL_URL
    while True:
        try:
            # DO NOT process queue if we don't know our tunnel URL yet!
            if not TUNNEL_URL:
                runner_data = redis_get_json(f"runner:{RUNNER_ID}")
                if runner_data and runner_data.get('tunnel_url'):
                    TUNNEL_URL = runner_data['tunnel_url']
                    print(f"[Runner] Tunnel URL discovered for queue: {TUNNEL_URL}")
                else:
                    await asyncio.sleep(3)
                    continue

            free_cpu = RUNNER_TOTAL_CPU - used_cpu
            free_ram = RUNNER_TOTAL_RAM - used_ram

            if free_cpu >= 0.5 and free_ram >= 2048:  # At least a free-tier slot
                queue_len = redis_zcard('vps_queue')
                if queue_len and queue_len > 0:
                    # Peek at the highest-priority session
                    result = redis_zpopmax('vps_queue')
                    if result and len(result) >= 2:
                        session_id = result[0]
                        session = redis_get_json(f"session:{session_id}")

                        if session and session.get('status') == 'queued':
                            plan  = session.get('plan', 'free')
                            spec  = PLAN_SPECS.get(plan, PLAN_SPECS['free'])
                            s_cpu = spec['cpu']
                            s_ram = spec['ram']

                            if free_cpu >= s_cpu and free_ram >= s_ram:
                                # Accept this session
                                session['status']     = 'active'
                                session['runner_id']  = RUNNER_ID
                                session['tunnel_url'] = TUNNEL_URL
                                ttl = max(60, session.get('expires_at', 0) - int(time.time()))
                                redis_set_json(f"session:{session_id}", session, ex=ttl + 300)
                                print(f"[Queue] Activated: {session_id} (plan={plan}, cpu={s_cpu}, ram={s_ram})")
                            else:
                                # Not enough resources — put back in queue
                                priorities = {'free': 100, 'basic': 200, 'pro': 300, 'enterprise': 400}
                                redis_exec(["ZADD", "vps_queue", str(priorities.get(plan, 100)), session_id])
                                print(f"[Queue] Not enough resources for {session_id} (need {s_cpu}cpu/{s_ram}ram, have {free_cpu}/{free_ram})")
        except Exception as e:
            print(f"[Queue] Error: {e}")
        await asyncio.sleep(3)


# ═══════════════════════════════════════════════════════════════
#  DOCKER / BARE-METAL MANAGEMENT
# ═══════════════════════════════════════════════════════════════

async def run_cmd(cmd):
    proc = await asyncio.create_subprocess_shell(
        cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    return stdout.decode(errors='replace'), stderr.decode(errors='replace'), proc.returncode


async def create_container(session_id, plan):
    global used_cpu, used_ram
    name = f"vps-{session_id}"
    spec = PLAN_SPECS.get(plan, PLAN_SPECS['free'])

    # Bare-Metal Enterprise
    if plan == 'enterprise':
        # Check resources
        if used_cpu + spec['cpu'] > RUNNER_TOTAL_CPU or used_ram + spec['ram'] > RUNNER_TOTAL_RAM:
            print(f"[BareMetal] Not enough resources for enterprise")
            return None
        used_cpu += spec['cpu']
        used_ram += spec['ram']
        sync_runner_to_redis()
        # Ensure bare-metal file dir exists
        await run_cmd("mkdir -p /home/runner/files")
        print(f"[BareMetal] Assigned: plan=enterprise | Total: {used_cpu}/{RUNNER_TOTAL_CPU} CPU, {used_ram}/{RUNNER_TOTAL_RAM} RAM")
        return 'bare-metal'

    # Check if already exists (reconnection)
    out, _, rc = await run_cmd(f"docker inspect {name} 2>/dev/null")
    if rc == 0:
        print(f"[Docker] Container {name} already exists (reconnect)")
        return name

    # Check resources
    if used_cpu + spec['cpu'] > RUNNER_TOTAL_CPU or used_ram + spec['ram'] > RUNNER_TOTAL_RAM:
        print(f"[Docker] Not enough resources for {name}")
        return None

    cmd = (
        f"docker run -d --name {name} "
        f"--cpus={spec['cpu']} "
        f"--memory={spec['ram']}m "
        f"--pids-limit=200 "
        f"--network=bridge "
        f"--tmpfs /tmp:size={spec['storage']}m "
        f"{DOCKER_IMAGE} "
        f"sleep infinity"
    )
    out, err, rc = await run_cmd(cmd)
    if rc != 0:
        print(f"[Docker] Create failed: {err}")
        return None

    # Reserve resources
    used_cpu += spec['cpu']
    used_ram += spec['ram']
    sync_runner_to_redis()

    print(f"[Docker] Created {name}: plan={plan} cpu={spec['cpu']} ram={spec['ram']}m | Total: {used_cpu}/{RUNNER_TOTAL_CPU} CPU, {used_ram}/{RUNNER_TOTAL_RAM} RAM")
    return name


async def destroy_container(session_id):
    global used_cpu, used_ram
    name = f"vps-{session_id}"
    plan = None

    # Free resources
    if session_id in sessions:
        sess = sessions[session_id]
        plan = sess.get('plan')
        used_cpu = max(0, used_cpu - sess.get('cpu', 0))
        used_ram = max(0, used_ram - sess.get('ram', 0))

    if plan != 'enterprise':
        await run_cmd(f"docker rm -f {name} 2>/dev/null")
        print(f"[Docker] Destroyed {name} | Total: {used_cpu}/{RUNNER_TOTAL_CPU} CPU, {used_ram}/{RUNNER_TOTAL_RAM} RAM")
    else:
        print(f"[BareMetal] Released resources for {session_id} | Total: {used_cpu}/{RUNNER_TOTAL_CPU} CPU, {used_ram}/{RUNNER_TOTAL_RAM} RAM")

    sync_runner_to_redis()


async def docker_exec_stream(container, cmd, cwd, websocket):
    escaped = cmd.replace("'", "'\\''")
    if container == 'bare-metal':
        # Execute directly on host
        full_cmd = f"cd '{cwd}' && bash -c '{escaped}'"
    else:
        full_cmd = f"docker exec -w '{cwd}' {container} bash -c '{escaped}'"

    try:
        proc = await asyncio.create_subprocess_shell(
            full_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        async def stream(pipe):
            while True:
                chunk = await pipe.read(4096)
                if not chunk:
                    break
                await send(websocket, chunk.decode(errors='replace'))

        try:
            await asyncio.wait_for(
                asyncio.gather(stream(proc.stdout), stream(proc.stderr)),
                timeout=COMMAND_TIMEOUT
            )
            await proc.wait()
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except:
                pass
            await send(websocket, f"\n[Timeout] Command killed after {COMMAND_TIMEOUT}s\n")
    except Exception as e:
        await send(websocket, f"Error: {e}\n")


async def get_container_stats(container):
    try:
        if container == 'bare-metal':
            # Use host system stats
            out, _, _ = await run_cmd("free -m | grep Mem | awk '{print $3}'")
            try: mem_mb = float(out.strip())
            except: mem_mb = 0

            out, _, _ = await run_cmd("top -bn1 | grep 'Cpu(s)' | sed 's/.*, *\\([0-9.]*\\)%* id.*/\\1/' | awk '{print 100 - $1}'")
            try: cpu_pct = float(out.strip())
            except: cpu_pct = 0

            return {
                'cpu':       round(cpu_pct, 1),
                'ram':       min(100, int(mem_mb / 16384 * 100)),
                'ram_mb':    round(mem_mb, 1),
                'disk':      0,
                'cpu_cores': 4,
            }

        # Docker stats
        out, _, rc = await run_cmd(
            f"docker stats --no-stream --format '{{{{.CPUPerc}}}} {{{{.MemUsage}}}}' {container}"
        )
        if rc != 0:
            return None
        parts = out.strip().split()
        if len(parts) < 2:
            return None

        cpu_pct = float(parts[0].replace('%', ''))
        mem_str = parts[1]
        if 'GiB' in mem_str:
            mem_mb = float(mem_str.replace('GiB', '')) * 1024
        elif 'MiB' in mem_str:
            mem_mb = float(mem_str.replace('MiB', ''))
        elif 'KiB' in mem_str:
            mem_mb = float(mem_str.replace('KiB', '')) / 1024
        else:
            mem_mb = 0

        sess_plan = None
        for sid, s in sessions.items():
            if s.get('container_name') == container:
                sess_plan = s.get('plan', 'free')
                break

        spec = PLAN_SPECS.get(sess_plan, PLAN_SPECS['free'])
        ram_limit = spec['ram']
        ram_pct   = min(100, int(mem_mb / ram_limit * 100)) if ram_limit > 0 else 0

        return {
            'cpu':       round(cpu_pct, 1),
            'ram':       ram_pct,
            'ram_mb':    round(mem_mb, 1),
            'disk':      0,
            'cpu_cores': spec['cpu'],
        }
    except Exception as e:
        print(f"[Stats] Error: {e}")
        return None


# ═══════════════════════════════════════════════════════════════
#  FILE MANAGER
# ═══════════════════════════════════════════════════════════════

async def fm_list(container, websocket):
    if container == 'bare-metal':
        out, _, rc = await run_cmd("ls -1 /home/runner/files 2>/dev/null")
    else:
        out, _, rc = await run_cmd(f"docker exec {container} ls -1 /root/files 2>/dev/null")
    files = sorted([f for f in out.strip().split('\n') if f]) if rc == 0 and out.strip() else []
    await websocket.send(json.dumps({"type": "file_list", "data": files}))


async def fm_read(container, filename, websocket):
    safe_name = os.path.basename(filename)
    if container == 'bare-metal':
        out, _, rc = await run_cmd(f"cat '/home/runner/files/{safe_name}' 2>/dev/null")
    else:
        out, _, rc = await run_cmd(f"docker exec {container} cat '/root/files/{safe_name}' 2>/dev/null")
    content = out if rc == 0 else ""
    await websocket.send(json.dumps({
        "type": "file_content",
        "data": {"filename": safe_name, "content": content}
    }))


async def fm_write(container, filename, content, websocket, plan):
    safe_name = os.path.basename(filename)
    spec = PLAN_SPECS.get(plan, PLAN_SPECS['free'])
    storage_limit = spec['storage'] * 1024 * 1024

    if container == 'bare-metal':
        out, _, _ = await run_cmd("du -sb /home/runner/files/ 2>/dev/null")
    else:
        out, _, _ = await run_cmd(f"docker exec {container} du -sb /root/files/ 2>/dev/null")

    used_bytes = 0
    if out.strip():
        try:
            used_bytes = int(out.strip().split()[0])
        except:
            pass

    if used_bytes + len(content.encode()) > storage_limit:
        await send(websocket, f"Storage limit reached ({spec['storage']}MB).\n")
        return

    import tempfile
    with tempfile.NamedTemporaryFile(mode='w', suffix=f'_{safe_name}', delete=False) as f:
        f.write(content)
        tmp_path = f.name
        
    if container == 'bare-metal':
        await run_cmd(f"mv '{tmp_path}' '/home/runner/files/{safe_name}'")
    else:
        await run_cmd(f"docker cp '{tmp_path}' '{container}:/root/files/{safe_name}'")
        os.unlink(tmp_path)
        
    await send(websocket, f"File saved: {safe_name}\n")



# ═══════════════════════════════════════════════════════════════
#  WEBSOCKET HANDLER
# ═══════════════════════════════════════════════════════════════

async def handler(websocket):
    session_id = None
    container  = None

    try:
        # ── 1. Auth handshake ────────────────────────────────────
        try:
            raw = await asyncio.wait_for(websocket.recv(), timeout=15)
            data = json.loads(raw)
        except (asyncio.TimeoutError, json.JSONDecodeError):
            await websocket.close(4001, "Auth timeout")
            return

        if data.get('type') != 'auth' or not data.get('session_id'):
            await websocket.close(4002, "Invalid auth")
            return

        session_id = data['session_id']
        print(f"[WS] Auth: {session_id}")

        # ── 2. Validate session ──────────────────────────────────
        session = redis_get_json(f"session:{session_id}")
        if not session:
            await send(websocket, "Error: Session not found or expired.\n")
            await websocket.close(4003, "Invalid session")
            return

        if session.get('runner_id') and session['runner_id'] != RUNNER_ID:
            await send(websocket, "Error: Session belongs to another runner.\n")
            await websocket.close(4004, "Wrong runner")
            return

        plan      = session.get('plan', 'free')
        spec      = PLAN_SPECS.get(plan, PLAN_SPECS['free'])
        fm_enabled = spec['fm']

        # ── 3. Create / reattach Docker container ────────────────
        is_reconnect = session_id in sessions

        if is_reconnect:
            container   = sessions[session_id]['container_name']
            current_dir = sessions[session_id]['current_dir']
            sessions[session_id]['websocket'] = websocket
            print(f"[WS] Reconnected: {session_id} → {container}")
        else:
            # Check resources
            if used_cpu + spec['cpu'] > RUNNER_TOTAL_CPU or used_ram + spec['ram'] > RUNNER_TOTAL_RAM:
                await send(websocket, "Error: Runner at capacity. You are in the queue.\n")
                await websocket.close(4005, "At capacity")
                return

            container = await create_container(session_id, plan)
            if not container:
                await send(websocket, "Error: Failed to create container.\n")
                await websocket.close(4006, "Container failed")
                return

            await run_cmd(f"docker exec {container} mkdir -p /root/files")

            current_dir = '/root'
            sessions[session_id] = {
                'container_name': container,
                'current_dir':    current_dir,
                'websocket':      websocket,
                'plan':           plan,
                'cpu':            spec['cpu'],
                'ram':            spec['ram'],
                'created_at':     time.time(),
                'expires_at':     session.get('expires_at', time.time() + spec['session']),
            }

            # Update Redis
            session['status']    = 'active'
            session['runner_id'] = RUNNER_ID
            if not session.get('tunnel_url'):
                session['tunnel_url'] = TUNNEL_URL
            ttl = max(60, session.get('expires_at', 0) - int(time.time()))
            redis_set_json(f"session:{session_id}", session, ex=ttl + 300)

            print(f"[WS] New: {session_id} plan={plan} cpu={spec['cpu']} ram={spec['ram']} | "
                  f"Runner: {used_cpu}/{RUNNER_TOTAL_CPU} CPU, {used_ram}/{RUNNER_TOTAL_RAM} RAM, "
                  f"{len(sessions)} users")

        # ── 4. Welcome ───────────────────────────────────────────
        await send(websocket, f"Connected — AbsoraCloud VPS ({plan} plan)\n")
        if not is_reconnect:
            await websocket.send(json.dumps({"type": "cwd", "data": current_dir}))

        # ── 5. Command loop ──────────────────────────────────────
        async for message in websocket:
            try:
                data = json.loads(message)
            except json.JSONDecodeError:
                await send(websocket, "Error: Invalid JSON.\n")
                continue

            cmd     = data.get('cmd', '').strip()
            content = data.get('content', '')
            current_dir = sessions[session_id]['current_dir']

            if not cmd:
                continue

            # Kill session (explicit user terminate)
            if cmd == '__kill_session__':
                await send(websocket, "Session terminated by user.\n")
                await destroy_container(session_id)
                if session_id in sessions:
                    del sessions[session_id]
                redis_del(f"session:{session_id}")
                print(f"[Kill] User terminated: {session_id}")
                await websocket.close(4100, "User terminated")
                return

            # Metrics
            if cmd == '__metrics__':
                stats = await get_container_stats(container)
                if stats:
                    await websocket.send(json.dumps({"type": "metrics", "data": stats}))
                continue

            # File manager
            if cmd == '__fm_list__':
                if not fm_enabled:
                    await send(websocket, "File manager not available on your plan.\n")
                    continue
                await fm_list(container, websocket)
                continue

            if cmd.startswith('__fm_read__ '):
                if not fm_enabled:
                    await send(websocket, "File manager not available on your plan.\n")
                    continue
                await fm_read(container, cmd[len('__fm_read__ '):].strip(), websocket)
                continue

            if cmd.startswith('__fm_write__ '):
                if not fm_enabled:
                    await send(websocket, "File manager not available on your plan.\n")
                    continue
                await fm_write(container, cmd[len('__fm_write__ '):].strip(), content, websocket, plan)
                continue

            # Clear
            if cmd == 'clear':
                await websocket.send(json.dumps({"type": "clear"}))
                continue

            # cd
            if cmd.startswith('cd'):
                parts  = cmd.split(None, 1)
                target = parts[1] if len(parts) > 1 else '~'
                if target == '~':
                    target = '/root'
                if not target.startswith('/'):
                    target = f"{current_dir}/{target}"

                _, _, rc = await run_cmd(f"docker exec {container} test -d '{target}'")
                if rc == 0:
                    out, _, _ = await run_cmd(f"docker exec {container} readlink -f '{target}'")
                    current_dir = out.strip() or target
                    sessions[session_id]['current_dir'] = current_dir
                else:
                    await send(websocket, f"bash: cd: {target}: No such file or directory\n")

                await websocket.send(json.dumps({"type": "cwd", "data": current_dir}))
                continue

            # Shell command
            await docker_exec_stream(container, cmd, current_dir, websocket)

    except websockets.exceptions.ConnectionClosedOK:
        print(f"[-] Disconnected (clean): {session_id}")
    except websockets.exceptions.ConnectionClosedError as e:
        print(f"[-] Disconnected (error): {session_id} — {e}")
    except Exception as e:
        print(f"[!] Error for {session_id}: {e}")
    finally:
        if session_id and session_id in sessions:
            sess = sessions[session_id]
            if time.time() >= sess.get('expires_at', 0):
                # Expired — destroy and backfill
                await destroy_container(session_id)
                del sessions[session_id]
                redis_del(f"session:{session_id}")
                print(f"[Cleanup] Expired: {session_id}")
            else:
                # Still valid — keep container for reconnect
                sessions[session_id]['websocket'] = None
                print(f"[Cleanup] Keeping for reconnect: {session_id}")
                asyncio.create_task(auto_cleanup(session_id))


async def auto_cleanup(session_id, grace_seconds=120):
    """Destroy container if no reconnection within grace period."""
    await asyncio.sleep(grace_seconds)
    if session_id in sessions and sessions[session_id].get('websocket') is None:
        print(f"[Auto-Cleanup] No reconnect for {session_id} — destroying")
        await destroy_container(session_id)
        del sessions[session_id]
        redis_del(f"session:{session_id}")
        # Queue backfill will happen in queue_processor


async def session_expiry_checker():
    """Check for expired sessions and destroy their containers."""
    while True:
        now = time.time()
        expired = [
            sid for sid, s in sessions.items()
            if now >= s.get('expires_at', float('inf'))
        ]
        for sid in expired:
            ws = sessions[sid].get('websocket')
            if ws:
                try:
                    await send(ws, "\n[Session Expired] Your session has ended.\n")
                    await ws.close(4010, "Session expired")
                except:
                    pass
            await destroy_container(sid)
            del sessions[sid]
            redis_del(f"session:{sid}")
            print(f"[Expiry] {sid}")

        await asyncio.sleep(10)


# ═══════════════════════════════════════════════════════════════
#  HELPERS
# ═══════════════════════════════════════════════════════════════

async def send(websocket, text):
    if text:
        try:
            await websocket.send(json.dumps({"type": "terminal", "data": text}))
        except:
            pass


def health_check(connection, request):
    """Handle non-WebSocket HTTP requests (Cloudflare health checks, etc.)."""
    # request may be None for bare TCP connections (Cloudflare probes)
    if request is None:
        return

    upgrade = request.headers.get("Upgrade", "").lower()
    if upgrade != "websocket":
        # websockets 13+: respond(status, text) — only 2 args
        body = json.dumps({
            "status":   "ok",
            "runner":   RUNNER_ID,
            "users":    len(sessions),
            "used_cpu": used_cpu,
            "used_ram": used_ram,
            "free_cpu": RUNNER_TOTAL_CPU - used_cpu,
            "free_ram": RUNNER_TOTAL_RAM - used_ram,
        })
        return connection.respond(http.HTTPStatus.OK, body + "\n")


# ═══════════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════════

import logging

async def main():
    # Suppress noisy websockets handshake errors (Cloudflare probes)
    logging.getLogger("websockets").setLevel(logging.ERROR)

    print(f"[AbsoraCloud] Universal Shared Server")
    print(f"[AbsoraCloud] Runner={RUNNER_ID}")
    print(f"[AbsoraCloud] Capacity: {RUNNER_TOTAL_CPU} CPU, {RUNNER_TOTAL_RAM}MB RAM")
    print(f"[AbsoraCloud] Serves ALL plans: free/basic/pro/enterprise")

    register_runner()

    asyncio.create_task(heartbeat_loop())
    asyncio.create_task(queue_processor())
    asyncio.create_task(session_expiry_checker())

    async with websockets.serve(
        handler, "0.0.0.0", 5000,
        ping_interval=30,
        ping_timeout=60,
        max_size=10 * 1024 * 1024,
        process_request=health_check,
    ):
        print("[AbsoraCloud] Ready — accepting all plans.")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())

