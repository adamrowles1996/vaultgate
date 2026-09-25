"""vaultgate's code-search sidecar (docs/adr/0008, spec 14.8.4, PROTOCOL.md).

Importing the package fixes the process environment before anything else (`environment`: the
Hugging Face libraries offline, `semble`'s cache folder and statistics file pointed nowhere,
third-party logging silenced), so no module of it can import `semble` first. That uses the
standard library only: `fetch_model` must stay usable without `semble`, which only the modules
that serve import.
"""

from vaultgate_code import environment  # noqa: F401 - applied on import, before semble loads

PROTOCOL_VERSION = 1
