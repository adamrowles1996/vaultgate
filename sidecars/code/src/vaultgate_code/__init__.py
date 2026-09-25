"""vaultgate's code-search sidecar (docs/adr/0008, spec 14.8.4, PROTOCOL.md).

Importing the package does nothing: `fetch_model` must stay usable with the standard library
alone, so `semble` is imported only by the modules that serve.
"""

PROTOCOL_VERSION = 1
