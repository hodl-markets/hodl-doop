# Deploying Doop on Porter (HODL)

HODL runs Doop at https://doop.hodlmarkets.com on its Porter cluster in Google Cloud (Linear HOD-134). This page
lists what to create, in order. The app's configuration is [`porter.yaml`](../porter.yaml); the general self-hosting
guide is https://doop.design/docs/self-hosting.

## What runs where

| Part        | Where                                                   | Why                                                              |
| ----------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| App         | Porter web service `doop/web`, 1 instance, 1 vCPU, 2 GB | Doop keeps canvases and WebSocket rooms in memory: one process   |
| Postgres 16 | Cloud SQL, same GCP project as the cluster              | Porter creates databases on AWS only                             |
| Uploads     | Cloudflare R2 bucket `doop-assets`                      | Porter has no persistent disk on GCP; Doop's docs list R2        |
| TLS         | Let's Encrypt, issued by Porter                         | Porter manages the certificate                                   |
| DNS         | Cloudflare, `doop` A record, DNS only (grey cloud)      | Porter's advice for Cloudflare; CAA already allows Let's Encrypt |
| Sign-in     | Microsoft Entra, HODL tenant only                       | Same identity as the rest of HODL's tools                        |

Sources: Porter [datastores](https://docs.porter.run/addons/datastores) and
[storage](https://docs.porter.run/addons/storage) (AWS only), [custom domains](https://docs.porter.run/applications/configure/custom-domains),
[Cloudflare DNS](https://docs.porter.run/security-and-compliance/cloudflare-dns).

## 1. Create the dependencies

**Cloud SQL** (GCP console, the project Porter's cluster runs in):

- Enable the Cloud SQL Admin API.
- Create a PostgreSQL 16 instance `doop-db` in the cluster's region (smallest tier to start), with automated backups
  on. Create database `doop` and user `doop` with a generated password.
- Create a service account `doop-cloudsql` with the role `roles/cloudsql.client` (what the Cloud SQL Auth Proxy
  needs: https://cloud.google.com/sql/docs/postgres/sql-proxy).
- In Porter: cluster settings, Connections tab, add that service account. Then uncomment the `connections` block in
  `porter.yaml` and fill in the instance's connection name (`project-id:region:doop-db`).

**R2** (Cloudflare dashboard):

- Create the bucket `doop-assets` (private; Doop reads and writes it from the server, nothing is served from the
  bucket directly).
- Create an R2 API token with Object Read and Write on that bucket only. Note its access key ID and secret.

**Entra app registration** (https://entra.microsoft.com, App registrations, platform Web):

- Supported account types: this organizational directory only.
- Redirect URI: `https://doop.hodlmarkets.com/api/auth/callback/microsoft`.
- Create a client secret. Add the `email` optional claim to the ID token, so a Microsoft sign-in can link to an
  existing account with the same address.

## 2. Create the `doop` env group in Porter

Mark every value with the lock icon (stored in GCP Secret Manager). `porter.yaml` sets `BETTER_AUTH_URL` and
`SIGNUP_EMAIL_DOMAINS` itself.

| Variable                  | Value                                                                     |
| ------------------------- | ------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`      | `openssl rand -hex 32`. Keep it stable: changing it signs everyone out    |
| `SECRETS_ENCRYPTION_KEYS` | `k1:` followed by `openssl rand -base64 32`                               |
| `DATABASE_URL`            | `postgres://doop:<password>@127.0.0.1:5432/doop` (host to confirm, below) |
| `MICROSOFT_CLIENT_ID`     | The app registration's application (client) ID                            |
| `MICROSOFT_CLIENT_SECRET` | The client secret                                                         |
| `MICROSOFT_TENANT_ID`     | HODL's directory (tenant) ID                                              |
| `BUCKET`                  | `doop-assets`                                                             |
| `ENDPOINT`                | `https://<cloudflare-account-id>.r2.cloudflarestorage.com`                |
| `REGION`                  | `auto`                                                                    |
| `ACCESS_KEY_ID`           | The R2 token's access key ID                                              |
| `SECRET_ACCESS_KEY`       | The R2 token's secret                                                     |

Every variable is validated at boot (`server/env.ts`); a wrong one stops the server and the log names it. The full
list is in [`.env.example`](../.env.example).

## 3. Deploy

- In Porter, create an application from the GitHub repository `hodl-markets/hodl-doop`, branch `main`, using
  `porter.yaml`. Porter opens a pull request that adds its GitHub Actions workflow; merging it starts the first
  deploy (https://docs.porter.run/applications/deploy/builds). After that, each push to `main` deploys.
- Migrations run when the server starts; there is no separate step.
- The web service's Networking tab shows the load balancer's IP. In Cloudflare DNS, add an A record `doop` with that IP,
  DNS only. Porter issues the certificate once the record resolves (up to 30 minutes).

## 4. After the first deploy

- Sign in at https://doop.hodlmarkets.com with Microsoft.
- Make yourself an admin. Without SMTP, `ADMIN_EMAILS` promotes nobody (`server/auth.ts`), so set the role once in
  Cloud SQL Studio: `UPDATE "user" SET role = 'admin' WHERE email = '<you>@hodlmarkets.com';`
- Straight away, in Admin, Sign-in: turn off email and password sign-up. Until then anyone can register a
  hodlmarkets.com address there without proving they own it, since no verification email can be sent.
- Connect an agent: `claude mcp add --transport http doop https://doop.hodlmarkets.com/mcp`, then sign in when the
  browser opens.

## Not verified

- The host the Cloud SQL Auth Proxy listens on. Porter's docs do not say; `127.0.0.1` is the usual sidecar address.
  Check the service's pods in Porter if the server cannot reach the database.
- Whether the ingress passes WebSocket upgrades on `/ws` without further annotations. Porter's docs do not say. Test
  by opening one canvas in two browsers: each should see the other's cursor.
- Doop's upload code with R2 on this deployment. Doop's own docs list R2 as supported.
