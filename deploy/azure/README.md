# vaultgate on Azure Container Apps

One click (or one command) provisions everything vaultgate needs on Azure and
starts it from the public image `ghcr.io/adamrowles1996/vaultgate`. The
template is `mainTemplate.json`; the resources are split by concern into
linked templates under `modules/` and the portal form is
`createUiDefinition.json`. Specification: [`docs/spec/09-deployment.md`](../../docs/spec/09-deployment.md) §9.3.

## What gets created

| Resource                                 | Purpose                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Log Analytics workspace `<name>-logs`    | Console logs (JSON lines) and system events, 30-day retention.                                                            |
| Container Apps environment `<name>-env`  | Consumption plan; public ingress with a managed `*.azurecontainerapps.io` certificate.                                    |
| Key Vault `<name>-<hash>`                | RBAC authorization, soft delete, purge protection. Holds `bw-password`, `bw-client-id`, `bw-client-secret`, `secret-key`. |
| User-assigned identity `<name>-identity` | **Key Vault Secrets User** on the vault; the app resolves its secret references with it.                                  |
| Storage account `<name><hash>` + share   | Standard LRS, TLS 1.2, no public blob access. The Azure Files share `vaultgate-data` is mounted at `/data` over SMB.      |
| Container App `<name>`                   | External HTTPS ingress → port 8080, one replica, health probes on `/healthz` and `/readyz`.                               |

Secrets never appear as plain environment values: the Container App holds Key
Vault references and Azure injects the values at start-up. Redeploying the
template with the same parameters is idempotent.

## Deploy from the portal

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fadamrowles1996%2Fvaultgate%2Fmain%2Fdeploy%2Fazure%2FmainTemplate.json/createUIDefinitionUri/https%3A%2F%2Fraw.githubusercontent.com%2Fadamrowles1996%2Fvaultgate%2Fmain%2Fdeploy%2Fazure%2FcreateUiDefinition.json)

You need a Bitwarden **personal API key** (Settings → Security → Keys →
View API key) and your master password. The form asks for a name, a region,
the credentials, and optionally an image tag, a Bitwarden server, a custom
public URL and the write scope switch. Leave the secret key empty to have one
generated; read the note on rotation below either way.

## Deploy from the command line

The main template links its modules by relative path, so deploy it from a
URI (a local `--template-file` cannot resolve `relativePath` links):

```sh
az group create --name rg-vaultgate --location uksouth
az deployment group create \
  --resource-group rg-vaultgate \
  --template-uri https://raw.githubusercontent.com/adamrowles1996/vaultgate/main/deploy/azure/mainTemplate.json \
  --parameters name=vaultgate imageTag=latest \
  --parameters bwClientId='user.…' bwClientSecret='…' bwPassword='…' \
  --parameters secretKey="$(openssl rand -base64 32)"
```

Or copy [`mainTemplate.parameters.json`](mainTemplate.parameters.json),
replace the placeholders, and pass `--parameters @your.parameters.json`.
Every secret is a `securestring` and is stored only in Key Vault. To preview
changes before applying them use `az deployment group what-if` with the same
arguments.

Pin `imageTag` to a release (`1.2.3`) for production; `latest` follows the
newest release.

## First run: create the operator account

vaultgate has no accounts until you complete the one-time setup page, whose
URL contains a bootstrap token printed once to the log at start-up:

```sh
az containerapp logs show --name vaultgate --resource-group rg-vaultgate --tail 200 \
  | grep 'setup?token='
```

Open the printed `https://<app>.azurecontainerapps.io/setup?token=…` link
within 15 minutes, create the operator account and enrol TOTP. The
deployment's `bootstrapInstructions` output repeats this command with your
names filled in. If the token expired, restart the app to mint a new one:

```sh
az containerapp revision restart --name vaultgate --resource-group rg-vaultgate \
  --revision "$(az containerapp revision list --name vaultgate --resource-group rg-vaultgate --query '[0].name' -o tsv)"
```

`/readyz` returns `503` until the Bitwarden vault has been unlocked and
synced once; the readiness probe tolerates a couple of minutes for that.

## Custom domain and managed certificate

Ingress is HTTPS-only and the generated host already has a certificate. To
use your own name (DEP-9):

1. Create a `CNAME` for `vault.example.com` pointing at the app FQDN
   (the `appFqdn` output) and a `TXT` record `asuid.vault.example.com` with the
   verification id:

   ```sh
   az containerapp show --name vaultgate --resource-group rg-vaultgate \
     --query properties.customDomainVerificationId -o tsv
   ```

2. Add the hostname and let Azure issue a free managed certificate:

   ```sh
   az containerapp hostname add --name vaultgate --resource-group rg-vaultgate \
     --hostname vault.example.com
   az containerapp hostname bind --name vaultgate --resource-group rg-vaultgate \
     --hostname vault.example.com --environment vaultgate-env --validation-method CNAME
   ```

3. Tell vaultgate its new origin, because the issuer and the canonical MCP
   resource are derived from it. Redeploy the template with
   `publicUrl=https://vault.example.com` (portal: "Custom public URL"), or:

   ```sh
   az containerapp update --name vaultgate --resource-group rg-vaultgate \
     --set-env-vars VAULTGATE_PUBLIC_URL=https://vault.example.com
   ```

Clients registered before the change must re-authorize against the new
issuer.

## Operating notes

- **Secret key rotation.** `secretKey` (`VAULTGATE_SECRET_KEY`) encrypts TOTP
  secrets. If the template generated it, store the value from Key Vault with
  your backups and pass the same value on every redeployment; a redeployment
  with a different value writes a new Key Vault secret version and forces
  TOTP re-enrolment. Key Vault keeps earlier versions, so an accidental
  rotation is reversible by restoring the previous value.
- **Single replica.** `maxReplicas` is 1 and `VAULTGATE_SQLITE_NETWORK_FS=true`:
  SQLite on an SMB share is safe only with one writer, rollback journal and
  exclusive locking. The share is mounted with `nobrl` for that reason. Do not
  raise the replica count.
- **Rotating Bitwarden credentials.** Set the new secret version in Key Vault
  (`az keyvault secret set --vault-name <vault> --name bw-password …`) and
  restart the revision; the app reads the latest version at start-up.
- **Logs.** `az containerapp logs show --follow`, or query
  `ContainerAppConsoleLogs_CL` in the workspace. Log lines are JSON with
  secrets redacted.
- **Redeploying an existing installation** with the same name is safe: every
  resource name is derived from `name` and the resource group id, so
  `az deployment group create` re-applies the same resources. Supply the same
  four secret values to avoid rotating them.

## Deviation from the specification

DEP-6 asks for a system-assigned identity. The template uses a user-assigned
identity instead: a system-assigned identity only exists once the app
exists, but the app cannot be created until its Key Vault references resolve,
which needs the role assignment first. A user-assigned identity is created
and role-assigned before the app in one deployment (see `modules/secrets.json`),
which removes the two-pass deployment the system-assigned variant would need.
Its permissions are identical (Key Vault Secrets User on this vault only).

## Validating changes

CI runs `python3 -m json.tool` over every file here and
[ARM-TTK](https://github.com/Azure/arm-ttk) over the folder on every pull
request (`template-validate` in `.github/workflows/ci.yml`). Locally:

```sh
pwsh -c 'Import-Module ./arm-ttk/arm-ttk/arm-ttk.psd1; Test-AzTemplate -TemplatePath deploy/azure'
```

A `what-if` against a real subscription is the last check before a release
and needs credentials CI does not hold; run it from a signed-in shell with
the command shown above.
