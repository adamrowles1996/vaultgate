"""Process environment set before `semble` and the Hugging Face libraries are imported.

Every module that imports `semble` imports this one first. The variables are fixed, not
defaults: the sidecar never downloads anything, and `semble`'s own cache folder and statistics
file point below `/dev/null`, where nothing can be created or read even by root.
"""

import logging
import os
import warnings

_UNUSABLE = "/dev/null/vaultgate-code"

FIXED = {
    "HF_HUB_OFFLINE": "1",
    "HF_HUB_DISABLE_TELEMETRY": "1",
    "HF_HUB_DISABLE_PROGRESS_BARS": "1",
    "HF_HOME": f"{_UNUSABLE}/huggingface",
    "SEMBLE_CACHE_LOCATION": f"{_UNUSABLE}/semble",
    "XDG_CACHE_HOME": f"{_UNUSABLE}/cache",
    "TOKENIZERS_PARALLELISM": "false",
    # One thread for the linear algebra under numpy, in the server and in every build child:
    # by default it starts one per CPU, which a many-CPU host's task limit cannot hold.
    "OPENBLAS_NUM_THREADS": "1",
    "OMP_NUM_THREADS": "1",
    "MKL_NUM_THREADS": "1",
}

# Loggers whose messages can carry file paths or repository content (semble names every file
# it skips as too large). They never reach stderr; the sidecar writes its own JSON lines.
QUIET_LOGGERS = ("semble", "model2vec", "huggingface_hub", "tokenizers", "py.warnings")


def apply() -> None:
    """Set the fixed variables and silence third-party logging and warnings."""
    os.environ.update(FIXED)
    logging.captureWarnings(capture=True)
    warnings.simplefilter("ignore")
    # A handler on the root logger keeps logging's last-resort stderr handler out of play.
    logging.getLogger().addHandler(logging.NullHandler())
    for name in QUIET_LOGGERS:
        quiet = logging.getLogger(name)
        quiet.addHandler(logging.NullHandler())
        quiet.propagate = False
        quiet.setLevel(logging.CRITICAL + 1)


apply()
