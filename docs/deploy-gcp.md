# Deploying Doop on Google Cloud (HODL)

HODL runs Doop at https://doop.hodlmarkets.com in the GCP project `hodlmarkets-tools` (Linear HOD-134). This page is
the plan: what runs where, the one-time setup in order, how to deploy, and what to check. The service's configuration
is [`deploy/gcp/service.yaml`](../deploy/gcp/service.yaml), built and deployed by
[`deploy/gcp/cloudbuild.yaml`](../deploy/gcp/cloudbuild.yaml). The general self-hosting guide is
https://doop.design/docs/self-hosting.

## What runs where

All in `hodlmarkets-tools`, region `us-east1`.

| Part     | Service                                                    | Notes                                                                |
| -------- | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| App      | Cloud Run service `doop`: 1 instance, 1 vCPU, 2 GiB, gen2  | Doop keeps canvases and WebSocket rooms in memory, so min = max = 1  |
| Database | Cloud SQL for PostgreSQL 16 `doop-db`, database `doop`     | Reached through Cloud Run's built-in Cloud SQL connection (a socket) |
| Uploads  | Cloud Storage bucket `hodlmarkets-tools-doop-assets`       | Doop's S3 client, through Cloud Storage's S3-compatible API          |
| Secrets  | Secret Manager, `doop-*`                                   | Read by the service account `doop-run` only                          |
| Images   | Artifact Registry repository `doop`                        | Built by Cloud Build from hodl-doop                                  |
| Address  | Global external Application Load Balancer, managed cert    | Google's recommended way to put a domain on Cloud Run                |
| DNS      | Cloudflare, `doop` A record to the balancer's IP, DNS only | Existing CAA records already allow Google Trust Services             |
| Sign-in  | Microsoft Entra, HODL tenant only                          | Plus `SIGNUP_EMAIL_DOMAINS=hodlmarkets.com`                          |

Why these choices:

- **One instance.** A second instance would hold its own copy of each open canvas (`.context/TECHSTACK.md`, section 3).
  Cloud Run's maximum "can be exceeded for a brief period due to circumstances such as traffic spikes"
  ([max instances](https://cloud.google.com/run/docs/configuring/max-instances)); for a small team the risk is low.
- **CPU always allocated** (`cpu-throttling: false`): Doop runs background work between requests.
- **Load balancer, not a domain mapping.** Google calls domain mappings Preview, "not production-ready" and "not
  recommended for production services" ([custom domains](https://cloud.google.com/run/docs/mapping-custom-domains)).
- **WebSockets** work on Cloud Run "with no additional configuration required", and each connection ends at the
  request timeout, here 60 minutes ([WebSockets](https://cloud.google.com/run/docs/triggering/websockets)). Doop's
  client reconnects 1.2 s after a close (`src/lib/ws.ts`).
- **Database socket.** `DATABASE_URL` takes the form
  `postgresql://doop:<password>@localhost/doop?host=/cloudsql/hodlmarkets-tools:us-east1:doop-db`. Parsed with the
  repo's `pg` version, the host is the socket directory (checked on 2026-11-13). The connection is "automatically
  encrypted" ([Cloud SQL from Cloud Run](https://cloud.google.com/sql/docs/postgres/connect-run)).
- **Never without `DATABASE_URL`.** Unset, Doop falls back to an embedded database on the container's disk, which
  Cloud Run discards. The secret must exist before the first deploy.

## One-time setup

Run in Cloud Shell as a project owner. If the project ID differs from its name, set `PROJECT` to the ID.

```bash
PROJECT=hodlmarkets-tools
REGION=us-east1
gcloud config set project "$PROJECT"
gcloud services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com \
  artifactregistry.googleapis.com cloudbuild.googleapis.com compute.googleapis.com storage.googleapis.com
```

**1. Service accounts and the image repository**

```bash
gcloud iam service-accounts create doop-run --display-name="Doop on Cloud Run"
gcloud iam service-accounts create doop-build --display-name="Doop builds and deploys"
RUN_SA=doop-run@$PROJECT.iam.gserviceaccount.com
BUILD_SA=doop-build@$PROJECT.iam.gserviceaccount.com

gcloud artifacts repositories create doop --repository-format=docker --location="$REGION"

gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$RUN_SA" --role=roles/cloudsql.client
for role in roles/run.admin roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$BUILD_SA" --role="$role"
done
gcloud artifacts repositories add-iam-policy-binding doop --location="$REGION" \
  --member="serviceAccount:$BUILD_SA" --role=roles/artifactregistry.writer
gcloud iam service-accounts add-iam-policy-binding "$RUN_SA" \
  --member="serviceAccount:$BUILD_SA" --role=roles/iam.serviceAccountUser
```

`doop-build` has `run.admin` rather than `run.developer` because the service turns off Cloud Run's invoker IAM check,
which is an IAM setting.

**2. Cloud SQL**

```bash
gcloud sql instances create doop-db --database-version=POSTGRES_16 --edition=ENTERPRISE --tier=db-g1-small \
  --region="$REGION" --storage-size=10 --storage-auto-increase --ssl-mode=ENCRYPTED_ONLY \
  --backup-start-time=07:00 --enable-point-in-time-recovery --retained-backups-count=14 \
  --maintenance-window-day=SUN --maintenance-window-hour=9 --deletion-protection
gcloud sql databases create doop --instance=doop-db
DB_PASSWORD=$(openssl rand -hex 24)
gcloud sql users create doop --instance=doop-db --password="$DB_PASSWORD"
```

The instance keeps its public IP with no authorized networks: only connections through Cloud SQL's connector, which
checks IAM (`roles/cloudsql.client`), get in.

**3. Storage bucket and its key**

```bash
gcloud storage buckets create "gs://$PROJECT-doop-assets" --location="$REGION" \
  --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets add-iam-policy-binding "gs://$PROJECT-doop-assets" \
  --member="serviceAccount:$RUN_SA" --role=roles/storage.objectUser
gcloud storage hmac create "$RUN_SA"
```

The last command prints an access ID and a secret, shown once. They go into the next step. Doop serves uploads
itself, so the bucket stays private.

**4. Entra app registration** (https://entra.microsoft.com, App registrations, platform Web)

- Supported account types: this organizational directory only.
- Redirect URI: `https://doop.hodlmarkets.com/api/auth/callback/microsoft`.
- Create a client secret. Add the `email` optional claim to the ID token, so a Microsoft sign-in can link to an
  existing account with the same address.

**5. Secrets**

```bash
put() { printf %s "$2" | gcloud secrets create "$1" --data-file=- --replication-policy=automatic; \
  gcloud secrets add-iam-policy-binding "$1" --member="serviceAccount:$RUN_SA" \
    --role=roles/secretmanager.secretAccessor >/dev/null; }

put doop-database-url "postgresql://doop:$DB_PASSWORD@localhost/doop?host=/cloudsql/$PROJECT:$REGION:doop-db"
put doop-better-auth-secret "$(openssl rand -hex 32)"
put doop-secrets-encryption-keys "k1:$(openssl rand -base64 32)"
put doop-storage-access-key-id '<access ID from step 3>'
put doop-storage-secret-access-key '<secret from step 3>'
put doop-microsoft-client-id '<application (client) ID>'
put doop-microsoft-client-secret '<client secret>'
put doop-microsoft-tenant-id '<HODL directory (tenant) ID>'
```

- `doop-better-auth-secret` must not change: it signs sessions and agent tokens, so a new value signs everyone out.
- Losing `doop-secrets-encryption-keys` loses the model keys and tokens people connected (they reconnect).

**6. Build trigger**

- Cloud Build, Repositories (2nd gen): link GitHub and pick `hodl-markets/hodl-doop`. This installs the Cloud Build
  GitHub App, which an owner of the `hodl-markets` organization may have to approve.
- Cloud Build, Triggers, Create, in `us-east1`: name `doop-deploy`, event "Manual invocation", the linked repository,
  branch `main`, configuration file `deploy/gcp/cloudbuild.yaml`, service account `doop-build`.
- Deploys are manual on purpose: `main` follows upstream Doop, and hodl-doop's CI does not run yet (GitHub Actions is
  off on the repository).

## Deploy

```bash
gcloud builds triggers run doop-deploy --region=us-east1 --branch=main
```

The build pushes the image, then `gcloud run services replace` applies `service.yaml`. Migrations run when the server
starts. The first deploy creates the service; the balancer below needs it to exist.

## The address (once, after the first deploy)

```bash
gcloud compute addresses create doop-ip --global
gcloud compute network-endpoint-groups create doop-neg --region="$REGION" \
  --network-endpoint-type=serverless --cloud-run-service=doop
gcloud compute backend-services create doop-backend --global --load-balancing-scheme=EXTERNAL_MANAGED
gcloud compute backend-services add-backend doop-backend --global \
  --network-endpoint-group=doop-neg --network-endpoint-group-region="$REGION"
gcloud compute url-maps create doop-lb --default-service=doop-backend
gcloud compute ssl-certificates create doop-cert --domains=doop.hodlmarkets.com --global
gcloud compute target-https-proxies create doop-https --url-map=doop-lb --ssl-certificates=doop-cert
gcloud compute forwarding-rules create doop-https --global --load-balancing-scheme=EXTERNAL_MANAGED \
  --address=doop-ip --target-https-proxy=doop-https --ports=443
gcloud compute addresses describe doop-ip --global --format='value(address)'
```

- In Cloudflare DNS, add an A record `doop` with that IP, DNS only (grey cloud). The certificate is issued once the
  record resolves to the balancer; `gcloud compute ssl-certificates describe doop-cert --global` shows its status.
- Optional: a second forwarding rule on port 80 that redirects to HTTPS.

## After the first deploy

- Sign in at https://doop.hodlmarkets.com with Microsoft.
- Make yourself an admin. Without SMTP, `ADMIN_EMAILS` promotes nobody (`server/auth.ts`), so set the role once in
  Cloud SQL Studio: `UPDATE "user" SET role = 'admin' WHERE email = '<you>@hodlmarkets.com';`
- Straight away, in Admin, Sign-in: turn off email and password sign-up. Until then anyone can register a
  hodlmarkets.com address there without proving they own it, since no verification email can be sent.
- Connect an agent: `claude mcp add --transport http doop https://doop.hodlmarkets.com/mcp`, then sign in when the
  browser opens.
- Monitoring: a Cloud Monitoring uptime check on `https://doop.hodlmarkets.com/healthz` that emails the team.

## Backups

- Cloud SQL: daily backups kept 14 days, and point-in-time recovery (step 2).
- Uploads: new buckets keep deleted objects for 7 days (soft delete), as I understand Google's default; confirm on the
  bucket's Protection tab.

## Cost

Not verified: Google's pricing pages did not load when this plan was written. Rough monthly figures from memory, to
confirm in the pricing calculator: Cloud Run, 1 vCPU and 2 GiB always on, about $50 to $65; Cloud SQL `db-g1-small`,
about $25 to $30; the load balancer's forwarding rule, about $18; storage, secrets, images and builds, a few dollars.
About $100 a month in all. Cheaper settings: `db-f1-micro`, or a domain mapping instead of the balancer, both with the
caveats above. The handbook records $2,000 of Google for Startups credit on a Cloud Billing account; check whether
`hodlmarkets-tools` bills to it.

## To check on the first deploy

- **WebSockets through the balancer.** Open one canvas in two browsers: each should see the other's cursor.
- **Uploads to Cloud Storage.** Paste an image onto a canvas and reload. Google documents its S3-compatible API with
  region `auto` and endpoint `https://storage.googleapis.com` ([interoperability](https://cloud.google.com/storage/docs/interoperability)),
  but not this SDK's checksum headers; the two `AWS_*_CHECKSUM_*` variables are a precaution. If uploads fail, the
  fallback is a Cloudflare R2 bucket with the same variables.
- **Exports.** Export a frame as PDF (Chromium in the container).
- **Deploys.** Cloud Run lets requests in progress finish before shutdown and then sends SIGTERM, with 10 s before
  SIGKILL ([container contract](https://cloud.google.com/run/docs/container-contract)). Doop saves pending writes and
  exits on SIGTERM. Google does not say how long an old revision with open WebSockets keeps running; if both revisions
  stay up for long, lower `timeoutSeconds`.
- **Organization policies.** If the organization restricts public access, `run.googleapis.com/invoker-iam-disabled`
  or the public load balancer may be refused; the error names the policy.
