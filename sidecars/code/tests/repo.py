"""A small fixture repository: code, docs, config, a secret, links, a large and a binary file."""

from __future__ import annotations

from pathlib import Path

from archives import Member, file, link

INVOICE = '''"""Invoices: totals, tax and discounts."""

from decimal import Decimal


def compute_invoice_total(lines: list[Decimal], tax_rate: Decimal) -> Decimal:
    """Sum the invoice lines and add tax at the given rate."""
    subtotal = sum(lines, Decimal(0))
    return subtotal * (1 + tax_rate)


def apply_discount(total: Decimal, percent: int) -> Decimal:
    """Take a percentage off an invoice total."""
    return total * (100 - percent) / 100
'''

REFUND = '''"""Refunds against a paid invoice."""


class RefundError(Exception):
    """A refund larger than what was paid."""


def refund_invoice(paid: int, amount: int) -> int:
    """Return what remains paid after refunding `amount`."""
    if amount > paid:
        raise RefundError("cannot refund more than was paid")
    return paid - amount
'''

SESSION = '''"""Sign-in sessions and refresh-token rotation."""

import secrets


def login(user: str, password: str, store: dict[str, str]) -> str:
    """Check a password and open a session, returning its token."""
    if store.get(user) != password:
        raise PermissionError("wrong password")
    return secrets.token_urlsafe(32)


def rotate_refresh_token(old: str, family: dict[str, str]) -> str:
    """Replace a refresh token with a new one of the same family."""
    new = secrets.token_urlsafe(32)
    family[new] = family.pop(old)
    return new
'''

ROUTER = """import { login } from './session';

export function registerRoutes(app: { post: (path: string, handler: unknown) => void }): void {
  app.post('/login', login);
  app.post('/invoices', createInvoice);
}

export function createInvoice(request: { body: { lines: number[] } }): number {
  return request.body.lines.reduce((sum, line) => sum + line, 0);
}
"""

BILLING_DOC = """# Billing

An invoice lists its lines, adds tax at the customer's rate and may carry a discount.

## Refunds

A refund can never exceed what the customer paid for the invoice.
"""

AUTH_DOC = """# Authentication

Users sign in with a password. Each session holds a refresh token, rotated on every use.
"""

SETTINGS = """billing:
  currency: GBP
  tax_rate: 0.2
auth:
  session_minutes: 30
  rotate_refresh_tokens: true
"""

FILES: dict[str, bytes] = {
    "README.md": b"# Acme widgets\n\nAcme widgets computes invoices and signs users in.\n",
    "src/billing/invoice.py": INVOICE.encode(),
    "src/billing/refund.py": REFUND.encode(),
    "src/auth/session.py": SESSION.encode(),
    "src/web/router.ts": ROUTER.encode(),
    "docs/billing.md": BILLING_DOC.encode(),
    "docs/auth.md": AUTH_DOC.encode(),
    "config/settings.yaml": SETTINGS.encode(),
    "package.json": b'{\n  "name": "acme-widgets",\n  "version": "1.0.0"\n}\n',
    "empty.py": b"",
    "notes/lines.txt": "".join(f"line {n}\n" for n in range(1, 51)).encode(),
    "notes/crlf.txt": b"one\r\ntwo\r\nthree",
    "notes/latin1.txt": b"caf\xe9\n",
    "assets/logo.png": b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR",
}
EXCLUDED = {".env": b"SECRET=not-for-agents\n", "keys/deploy.pem": b"-----BEGIN KEY-----\n"}
LARGE = {"data/huge.json": b"[" + b"0," * 40_000 + b"0]\n"}  # over the 64 KiB cap used below
MAX_FILE_BYTES = 64 << 10


def members() -> list[Member]:
    """The archive members: every file, the excluded and large ones, and two links."""
    everything = {**FILES, **EXCLUDED, **LARGE}
    entries = [file(name, data) for name, data in everything.items()]
    entries.append(link("src/alias.py", "billing/invoice.py"))
    entries.append(link("src/copy.py", "acme-widgets-0123456/src/billing/refund.py", hard=True))
    return entries


def write(root: Path, files: dict[str, bytes] = FILES) -> Path:
    """Write the files the snapshot keeps (no excluded, large or linked ones) under `root`."""
    for name, data in files.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    return root
