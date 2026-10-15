# Deploying

The server is a single container that listens on `$PORT` (default 8080), with its state in one encrypted file under `DATA_DIR`. Run **exactly one instance** with a persistent volume (see [auth-design.md](./auth-design.md#storage-and-scaling)).

In every option below, the Google OAuth client must list this redirect URI:

```
https://<your-public-host>/oauth/google/callback
```

## Google Cloud Run (primary)

Set the variables first:

```bash
PROJECT_ID=your-gcp-project
REGION=us-central1
SERVICE=rogue-signal-mcp
BUCKET=${PROJECT_ID}-rogue-signal-mcp-data
gcloud config set project "$PROJECT_ID"
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com secretmanager.googleapis.com youtube.googleapis.com
```

### 1. Secrets

```bash
printf '%s' 'YOUR_GOOGLE_CLIENT_SECRET' | gcloud secrets create google-client-secret --data-file=-
openssl rand -base64 32 | tr -d '\n' | gcloud secrets create token-encryption-key --data-file=-
```

Back up the encryption key somewhere safe. If you lose it, every connection has to be re-authorized.

### 2. Persistent storage

Cloud Run's filesystem is ephemeral, so mount a Cloud Storage bucket as a volume:

```bash
gcloud storage buckets create "gs://$BUCKET" --location="$REGION" --uniform-bucket-level-access
# Service account the service runs as (default compute SA shown; a dedicated SA is better):
SA="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$SA" --role=roles/storage.objectUser
gcloud secrets add-iam-policy-binding google-client-secret --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor
gcloud secrets add-iam-policy-binding token-encryption-key --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor
```

### 3. Deploy

```bash
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --min-instances 0 --max-instances 1 \
  --concurrency 20 \
  --timeout 3600 \
  --memory 1Gi \
  --execution-environment gen2 \
  --add-volume name=data,type=cloud-storage,bucket="$BUCKET" \
  --add-volume-mount volume=data,mount-path=/data \
  --set-env-vars "DATA_DIR=/data,GOOGLE_CLIENT_ID=YOUR_CLIENT_ID.apps.googleusercontent.com,ALLOWED_GOOGLE_EMAILS=you@example.com" \
  --set-secrets "GOOGLE_CLIENT_SECRET=google-client-secret:latest,TOKEN_ENCRYPTION_KEY=token-encryption-key:latest"
```

`--allow-unauthenticated` only opens the service at the Cloud Run IAM layer. The server enforces OAuth itself, and `/mcp` rejects any request without a valid bearer token.

### 4. Set the public URL

Get the service URL, then set `PUBLIC_BASE_URL` to it (you can also map a custom domain first):

```bash
URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')
gcloud run services update "$SERVICE" --region "$REGION" --update-env-vars "PUBLIC_BASE_URL=$URL"
echo "MCP endpoint: $URL/mcp"
echo "Add redirect URI in Google Cloud: $URL/oauth/google/callback"
```

Optionally pin the channel with `--update-env-vars ALLOWED_CHANNEL_IDS=UCxxxxxxxx`.

### Notes

- `--max-instances 1` is required because the file store is single-writer.
- `--timeout 3600` gives long uploads the full hour Cloud Run allows. Very large files from slow sources may still exceed it, or exceed the MCP client's own tool-call timeout, so host episode files on fast storage (for example a signed GCS URL in the same region).
- Uploads stream in 16 MiB chunks, so 1 GiB of memory is plenty.

## Fly.io

```bash
fly launch --no-deploy --copy-config=false --name rogue-signal-mcp
fly volumes create data --size 1 --region iad
fly secrets set \
  GOOGLE_CLIENT_ID=YOUR_CLIENT_ID.apps.googleusercontent.com \
  GOOGLE_CLIENT_SECRET=YOUR_GOOGLE_CLIENT_SECRET \
  TOKEN_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  ALLOWED_GOOGLE_EMAILS=you@example.com \
  PUBLIC_BASE_URL=https://rogue-signal-mcp.fly.dev
```

`fly.toml`:

```toml
app = "rogue-signal-mcp"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[env]
  DATA_DIR = "/data"
  PORT = "8080"

[[mounts]]
  source = "data"
  destination = "/data"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

  [[http_service.checks]]
    method = "GET"
    path = "/healthz"
    interval = "30s"
    timeout = "5s"
```

```bash
fly deploy
fly scale count 1
```

The Fly volume is mounted as root. If the non-root `node` user cannot write to `/data`, run this once: `fly ssh console -C "chown -R 1000:1000 /data"`.

## After deploying

1. Open `https://<host>/healthz` and check that it returns `{"status":"ok"}`.
2. Run `curl -i -X POST https://<host>/mcp`. It should return `401` with a `WWW-Authenticate` header that contains `resource_metadata=...`.
3. Add the connector in claude.ai (see the README).
