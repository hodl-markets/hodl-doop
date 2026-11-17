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
for s in doop-microsoft-client-id doop-microsoft-client-secret doop-microsoft-tenant-id; do
  gcloud secrets create "$s" --replication-policy=automatic
  gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:$RUN_SA" \
    --role=roles/secretmanager.secretAccessor >/dev/null
done
```

- The three Microsoft secrets start empty. Add each value from step 4 in the console (Secret Manager, the secret, New
  version), so it never passes through a terminal or a chat: the application (client) ID, the client secret, and
  the HODL directory (tenant) ID.

- `doop-better-auth-secret` must not change: it signs sessions and agent tokens, so a new value signs everyone out.
- Losing `doop-secrets-encryption-keys` loses the model keys and tokens people connected (they reconnect).

**6. Build staging bucket**

```bash
gcloud storage buckets create "gs://$PROJECT-doop-build" --location="$REGION" \
  --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update "gs://$PROJECT-doop-build" \
  --lifecycle-file=<(echo '{"rule":[{"action":{"type":"Delete"},"condition":{"age":7}}]}')
gcloud storage buckets add-iam-policy-binding "gs://$PROJECT-doop-build" \
  --member="serviceAccount:$BUILD_SA" --role=roles/storage.objectViewer
```

`gcloud builds submit` uploads the checkout here and `doop-build` reads it; uploads are deleted after 7 days. There is
no Cloud Build trigger and no GitHub App. Deploys are manual on purpose: `main` follows upstream Doop, and hodl-doop's
CI does not run yet (GitHub Actions is off on the repository).

## Deploy

From a checkout of hodl-doop on the commit to deploy (normally `main`):

```bash
gcloud builds submit --project=hodlmarkets-tools --region=us-east1 --config=deploy/gcp/cloudbuild.yaml \
  --service-account=projects/hodlmarkets-tools/serviceAccounts/doop-build@hodlmarkets-tools.iam.gserviceaccount.com \
  --gcs-source-staging-dir=gs://hodlmarkets-tools-doop-build/source \
  --substitutions=_TAG="$(git rev-parse --short HEAD)"
```

- The build runs as `doop-build`: it pushes the image, then `gcloud run services replace` applies `service.yaml`, then
  every revision that no longer takes traffic is deleted (below, "Deploys").
- Whoever runs it needs `roles/cloudbuild.builds.editor`, `roles/iam.serviceAccountUser` on `doop-build`, and write
  access to the staging bucket.
- `_TAG` is required, since `gcloud builds submit` sets no `SHORT_SHA`; the first step stops the build without it.
- Migrations run when the server starts. The first deploy creates the service; the balancer below needs it to exist.

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
- Add the record before creating the certificate if you can. On 2026-11-17 the certificate was created about 3
  minutes before the record; its domain showed `FAILED_NOT_VISIBLE` for over half an hour. A second certificate for
  the same domain, attached alongside, forces an immediate re-check
  ([Google](https://docs.cloud.google.com/load-balancing/docs/ssl-certificates/google-managed-certs)): both were
  active within 20 minutes, and the extra one was then detached and deleted.
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
- **Deploys.** Cloud Run sends SIGTERM to an instance it shuts down, with 10 s before SIGKILL
  ([container contract](https://cloud.google.com/run/docs/container-contract)); Doop saves pending writes and exits
  within 1.5 s (`server/index.ts`). Seen on the redeploy of 2026-11-17 (revision `doop-00002-k8d`):
  - No downtime: a request to `/healthz` every second through the switch, 234 of 234 answered 200 (slowest 0.56 s).
  - The new revision started at 06:37:28 UTC, passed its startup probe at 06:37:43 and served from 06:37:50.
  - The old revision did not stop. Its minimum of one instance belongs to the revision (`minScale` in the template),
    so it kept running with no traffic until deleted at 06:42:49, and a WebSocket opened on it at 06:32:43 stayed on
    it until about 06:39:31, while new visitors reached the new revision: two copies of Doop at once.
  - So the build's last step deletes every revision without traffic. That shuts the old instance down (SIGTERM above)
    and closes its WebSockets; Doop's client reconnects 1.2 s later, to the new revision.
  - Rollback: a deleted revision cannot be routed back to. Images stay in Artifact Registry by commit tag; deploy an
    older one with `gcloud run services update doop --region=us-east1 --image=us-east1-docker.pkg.dev/hodlmarkets-tools/doop/doop:<tag>`,
    then delete the revision it replaced.
- **Organization policies.** If the organization restricts public access, `run.googleapis.com/invoker-iam-disabled`
  or the public load balancer may be refused; the error names the policy.
