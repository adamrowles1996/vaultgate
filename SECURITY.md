# Security policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting:
<https://github.com/adamrowles1996/vaultgate/security/advisories/new>.

Do not open a public issue. Include the version or commit, a description, and
reproduction steps if you have them. You will receive an acknowledgement
within 3 working days and a resolution plan within 14 days for confirmed
issues. Fixes ship as a patch release with a GitHub Security Advisory and a
CVE where appropriate. Reporters are credited unless they ask not to be.

## Supported versions

| Version      | Supported         |
| ------------ | ----------------- |
| latest minor | yes               |
| earlier      | upgrade to latest |

## Scope

In scope: anything in this repository, the published container image and the
Azure deployment template. Out of scope: Bitwarden's own services and clients,
and the hosted agent products that connect to vaultgate.

## Design references

The threat model is in [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md); the
security requirements are the numbered items in [`docs/spec/`](docs/spec/README.md).
