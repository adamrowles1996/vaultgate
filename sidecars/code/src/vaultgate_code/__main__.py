"""`python3 -m vaultgate_code serve ...`."""

from __future__ import annotations

import os
import sys
from collections.abc import Sequence

from vaultgate_code.config import ConfigError, parse


def main(argv: Sequence[str] | None = None) -> int:
    """Parse the configuration, then serve."""
    try:
        config = parse(argv, os.environ)
    except ConfigError as error:
        sys.stderr.write(f"vaultgate-code: {error}\n")
        return 2
    from vaultgate_code import app  # noqa: PLC0415 - semble loads only once the flags are good

    return app.run(config)


if __name__ == "__main__":
    sys.exit(main())
