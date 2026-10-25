"""Windows development reload without broadcasting a console Ctrl+C event.

Keep Uvicorn's watcher/socket handling, but terminate only its worker on reload.
The Node supervisor owns Ctrl+C cleanup of the complete development process tree.
"""

import argparse
import sys

from uvicorn import Config, Server
from uvicorn._subprocess import get_subprocess
from uvicorn.supervisors import ChangeReload


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
    config = Config(args.app, host=args.host, port=args.port, reload=True, reload_dirs=args.reload_dir)
    server = Server(config)
    sock = config.bind_socket()
    WindowsReload(config, target=server.run, sockets=[sock]).run()


if __name__ == "__main__":
    main()
