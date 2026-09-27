"""Install the managed compatibility symlink, retaining old real directories."""
from __future__ import annotations

import os
from pathlib import Path
import sys
import uuid


def install(source: Path, destination: Path) -> None:
    if not source.is_dir():
        raise ValueError(f"compatibility stub source is missing: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Old releases installed a real extension directory. Never let ln -sfn
    # create an unnoticed nested symlink, or discard that user's prior files.
    backup = None
    if destination.exists() and not destination.is_symlink():
        if not destination.is_dir():
            raise ValueError(f"refusing to replace non-directory: {destination}")
        backup = destination.with_name(f"{destination.name}.pre-symlink-{uuid.uuid4().hex}")
        destination.rename(backup)
    temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.symlink_to(source, target_is_directory=True)
        os.replace(temporary, destination)
    except BaseException:
        if backup is not None and not destination.exists() and not destination.is_symlink():
            backup.rename(destination)
        raise
    finally:
        temporary.unlink(missing_ok=True)
    if backup:
        print(f"Retained the previous extension directory at {backup}")


if __name__ == "__main__":
    install(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).absolute())
