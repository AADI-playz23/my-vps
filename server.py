import asyncio
import websockets
import json
import os
import signal

# Max seconds a single command is allowed to run
COMMAND_TIMEOUT = 60

async def shell_handler(websocket):
    current_dir = os.path.expanduser("~")
    client_addr = websocket.remote_address
    print(f"[+] Client connected: {client_addr}")

    await send(websocket, f"Connected to AMD EPYC Shell — cwd: {current_dir}\n")

    try:
        async for message in websocket:
            try:
                data = json.loads(message)
            except json.JSONDecodeError:
                await send(websocket, "Error: Invalid JSON payload.\n")
                continue

            cmd = data.get("cmd", "").strip()
            if not cmd:
                continue

            # ── Built-in: clear ───────────────────────────────────
            if cmd == "clear":
                await websocket.send(json.dumps({"type": "clear"}))
                continue

            # ── Built-in: cd ──────────────────────────────────────
            if cmd.startswith("cd"):
                parts = cmd.split(None, 1)
                target = parts[1] if len(parts) > 1 else os.path.expanduser("~")
                # Support ~ expansion
                target = os.path.expanduser(target)
                if not os.path.isabs(target):
                    target = os.path.join(current_dir, target)
                try:
                    os.chdir(target)
                    current_dir = os.getcwd()
                    await send(websocket, f"")   # silent success like a real shell
                except FileNotFoundError:
                    await send(websocket, f"bash: cd: {target}: No such file or directory\n")
                except PermissionError:
                    await send(websocket, f"bash: cd: {target}: Permission denied\n")
                # Always send updated prompt cwd so frontend can update it
                await websocket.send(json.dumps({"type": "cwd", "data": current_dir}))
                continue

            # ── All other commands ────────────────────────────────
            try:
                process = await asyncio.create_subprocess_shell(
                    cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=current_dir,
                    env={**os.environ, "TERM": "xterm-256color", "HOME": os.path.expanduser("~")}
                )

                # Stream stdout and stderr live as they arrive
                async def stream_pipe(pipe):
                    while True:
                        chunk = await pipe.read(4096)
                        if not chunk:
                            break
                        await send(websocket, chunk.decode(errors="replace"))

                try:
                    await asyncio.wait_for(
                        asyncio.gather(
                            stream_pipe(process.stdout),
                            stream_pipe(process.stderr),
                        ),
                        timeout=COMMAND_TIMEOUT
                    )
                    await process.wait()

                except asyncio.TimeoutError:
                    try:
                        process.kill()
                    except Exception:
                        pass
                    await send(websocket, f"\n[Timeout] Command killed after {COMMAND_TIMEOUT}s\n")

            except Exception as e:
                await send(websocket, f"Error: {str(e)}\n")

    except websockets.exceptions.ConnectionClosedOK:
        print(f"[-] Client disconnected (clean): {client_addr}")
    except websockets.exceptions.ConnectionClosedError as e:
        print(f"[-] Client disconnected (error): {client_addr} — {e}")
    except Exception as e:
        print(f"[!] Unexpected error for {client_addr}: {e}")


async def send(websocket, text):
    """Helper to send a terminal message."""
    if text:
        await websocket.send(json.dumps({"type": "terminal", "data": text}))


async def main():
    print("[BugVPS] WebSocket shell server starting on 0.0.0.0:5000 ...")
    async with websockets.serve(
        shell_handler,
        "0.0.0.0",
        5000,
        ping_interval=30,
        ping_timeout=60,
        max_size=10 * 1024 * 1024,  # 10 MB max message size
    ):
        print("[BugVPS] Ready.")
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())
