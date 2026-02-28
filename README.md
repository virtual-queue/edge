# Edge Queue Connector

A Cloudflare Worker that acts as an edge-level gateway for virtual queue platforms. It intercepts incoming requests, evaluates ACL rules, and redirects visitors to a waiting room when needed — all at the edge, with minimal latency.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/virtual-queue/edge)

## How it works

```
Visitor → Cloudflare Edge (this Worker) → ACL check → Allow / Redirect to Queue
```

1. **Request arrives** at Cloudflare's edge network
2. **ACL rules** are loaded (Memory cache → KV → API fallback)
3. **Pattern matching** determines if the path is protected (prefix, exact, contains, glob)
4. If protected and visitor has no valid bypass cookie → **redirect to waiting room**
5. When the visitor finishes the queue, they return with a token that is verified and exchanged for a **signed bypass cookie**

## Features

- ⚡ **Edge-first** — runs on Cloudflare's global network, close to users
- 🔒 **Signed cookies** — HMAC-SHA256 bypass tokens prevent tampering
- 📦 **3-tier cache** — Memory → KV → API for fast ACL lookups
- 🎯 **Flexible rules** — prefix, exact, contains, and glob pattern matching
- 📊 **Ingress reporting** — deduplicated visitor counts sent back to your platform
- 🛠️ **Debug mode** — toggle verbose logging via environment variable

## Setup

### Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) with Workers enabled
- A domain proxied through Cloudflare
- Your queue platform API credentials

### Quick deploy

Click the **Deploy to Cloudflare** button above, or deploy manually:

```bash
# Clone the repo
git clone https://github.com/virtual-queue/edge.git
cd edge

# Install dependencies
npm install

# Set your secrets
npx wrangler secret put EDGE_INGRESS_TOKEN
npx wrangler secret put JWT_SECRET

# Deploy
npm run deploy
```

### Post-deploy: connect to your domain

After deploying, you need to add a **Worker Route** so the worker intercepts traffic on your domain:

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → your domain → **Workers Routes**
2. Click **Add Route**
3. Set the route pattern to your domain (e.g. `yourdomain.com/*`)
4. Select the `edge-queue-connector` worker
5. Click **Save**

> ⚠️ Your domain must be **proxied through Cloudflare** (orange cloud) for this to work.

### Configuration

Edit `wrangler.jsonc` → `vars` to set:

| Variable | Description |
|---|---|
| `QUEUE_DOMAIN` | Your assigned queue subdomain (e.g. `yourcompany.virtual-queue.com`) |
| `DEBUG_MODE` | Set to `"true"` to enable verbose logging |

### API contract

The worker expects your queue platform API to implement these endpoints:

#### `GET /api/v1/edge/config/:domain`

Returns ACL rules for a domain. Requires `Authorization: Bearer <token>`.

```json
{
  "data": {
    "queue_subdomain": "node1",
    "acls": [
      {
        "id": 1,
        "enabled": true,
        "priority": 10,
        "pattern_type": "prefix",
        "pattern": "/shop",
        "action": "queue",
        "event_id": "evt_123"
      }
    ]
  }
}
```

#### `POST /api/v1/edge/ingress`

Reports visitor counts. Requires `Authorization: Bearer <token>`.

```json
{ "event_id": "evt_123", "incoming": 42 }
```

#### `GET /api/v1/queue/verify?token=<token>`

Verifies a queue completion token.

```json
{ "success": true, "data": { "token": "abc", "finished_line": true } }
```

## License

MIT
