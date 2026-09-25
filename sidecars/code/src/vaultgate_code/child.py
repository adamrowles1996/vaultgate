"""The build child's entry point: index one variant, report counts or a class name, exit."""

from __future__ import annotations

import os
from collections.abc import Sequence
from multiprocessing.connection import Connection

from vaultgate_code import engine, guard


def main(tree: str, out: str, content: Sequence[str], model_dir: str, results: Connection) -> None:
    """Build the variant of `tree` for `content` into `out` and send the counts to the parent."""
    silence()
    guard.install()
    try:
        engine.use_model(model_dir)
        files, chunks = engine.build_variant(tree, out, content)
        results.send({"files": files, "chunks": chunks})
    except Exception as error:  # noqa: BLE001 - only the class name crosses to the parent
        results.send({"error": type(error).__name__})
    finally:
        results.close()


def silence() -> None:
    """Point standard output and error at /dev/null: nothing the libraries print is kept."""
    sink = os.open(os.devnull, os.O_WRONLY | os.O_CLOEXEC)
    os.dup2(sink, 1)
    os.dup2(sink, 2)
    os.close(sink)
