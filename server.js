import asyncio
import websockets
import json
import subprocess
import os

async def shell_handler(websocket):
    # Set the working directory to home
    current_dir = os.path.expanduser("~")
    
    print("Client connected to Shell")
    await websocket.send(json.dumps({"type": "terminal", "data": "Connected to AMD EPYC Shell\n"}))

    try:
        async for message in websocket:
            data = json.loads(message)
            cmd = data.get("cmd")
            
            if not cmd:
                continue

            # Handle 'cd' command manually (because subprocess spawns a new shell every time)
            if cmd.startswith("cd "):
                try:
                    target = cmd[3:].strip()
                    os.chdir(target)
                    current_dir = os.getcwd()
                    await websocket.send(json.dumps({"type": "terminal", "data": f"Changed directory to {current_dir}\n"}))
                except FileNotFoundError:
                    await websocket.send(json.dumps({"type": "terminal", "data": f"cd: {target}: No such file or directory\n"}))
                continue

            # Run standard Linux commands
            try:
                # Run the command and capture output
                process = await asyncio.create_subprocess_shell(
                    cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=current_dir
                )

                # Stream output live
                stdout, stderr = await process.communicate()
                
                if stdout:
                    await websocket.send(json.dumps({"type": "terminal", "data": stdout.decode()}))
                if stderr:
                    await websocket.send(json.dumps({"type": "terminal", "data": stderr.decode()}))

            except Exception as e:
                await websocket.send(json.dumps({"type": "terminal", "data": f"Error: {str(e)}\n"}))

    except websockets.exceptions.ConnectionClosed:
        print("Client disconnected")

async def main():
    async with websockets.serve(shell_handler, "0.0.0.0", 5000):
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
