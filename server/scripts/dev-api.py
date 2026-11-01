"""Windows development reload without broadcasting a console Ctrl+C event.

Keep Uvicorn's watcher handling, but terminate only its worker on reload.
The Node supervisor owns Ctrl+C cleanup of the complete development process tree.
"""

import argparse
import socket
import sys

from uvicorn import Config, Server
from uvicorn._subprocess import get_subprocess
from uvicorn.supervisors import ChangeReload


class WindowsServer(Server):
    def run(self, sockets: list[socket.socket] | None = None) -> None:
        # Proactor associates a listener with its worker's IO completion port.
        # A listener shared by the parent cannot be reused after that worker
        # exits (WinError 87). Each worker must bind its own fresh socket.
        super().run()


class WindowsReload(ChangeReload):
    def restart(self) -> None:
        # Uvicorn's Windows restart broadcasts CTRL_C_EVENT to the console.
        # Use process termination, which targets this worker only. A code reload
        # interrupts in-flight development requests; SQLite recovers transactions.
        self.process.terminate()
        self.process.join()
        self.process.close()
        self.process = get_subprocess(config=self.config, target=self.target, sockets=self.sockets)
        self.process.start()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("app")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--reload", action="store_true", required=True)
    parser.add_argument("--reload-dir", action="append", required=True)
    args = parser.parse_args()
    # Match the Uvicorn CLI's default --app-dir (current working directory).
    sys.path.insert(0, "")
    # Uvicorn selects SelectorEventLoop for Windows reload workers. That loop
    # cannot launch async subprocesses, so OfficeCLI/LibreOffice fail before
    # starting. Select Proactor explicitly while retaining the reload supervisor.
    loop = "asyncio:ProactorEventLoop" if sys.platform == "win32" else "auto"
    config = Config(args.app, host=args.host, port=args.port, reload=True, reload_dirs=args.reload_dir, loop=loop)
    server = WindowsServer(config)
    WindowsReload(config, target=server.run, sockets=[]).run()


if __name__ == "__main__":
    main()
