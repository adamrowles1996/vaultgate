"""Stand-ins for the build child's entry point, importable by name from a spawned child."""

from __future__ import annotations

import os
import time
from collections.abc import Sequence
from multiprocessing.connection import Connection


def sleep_forever(
    tree: str, out: str, content: Sequence[str], model_dir: str, results: Connection
) -> None:
    """Never answer: the parent's timeout or cancellation must kill this child."""
    del tree, out, content, model_dir, results
    time.sleep(3600)


def exit_silently(
    tree: str, out: str, content: Sequence[str], model_dir: str, results: Connection
) -> None:
    """Exit without a word, as a child killed by the kernel would."""
    del tree, out, content, model_dir
    results.close()
    os._exit(3)


def fail(tree: str, out: str, content: Sequence[str], model_dir: str, results: Connection) -> None:
    """Report a failure the way the real child does: the exception's class name only."""
    del tree, out, content, model_dir
    results.send({"error": "RuntimeError"})
    results.close()
