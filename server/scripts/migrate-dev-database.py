"""Copy the legacy development database, including its WAL, without altering it."""

import os
import sqlite3
import sys
from contextlib import closing
from pathlib import Path


def migrate(root: Path) -> None:
    source = root / "dev.db"
    target = root / "matrius.db"
    if target.exists() or not source.exists():
        return
    temporary = root / ".matrius-migration.db"
    try:
        with closing(sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True)) as old:
            with closing(sqlite3.connect(temporary)) as new:
                old.backup(new)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    migrate(Path(sys.argv[1]).resolve())
