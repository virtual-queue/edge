// Edge Queue Connector — Cloudflare Worker
// Intercepts requests and redirects visitors to a waiting room
// when matching ACL rules are active.
//
// Required secrets (set via `npx wrangler secret put <NAME>`):
//   EDGE_INGRESS_TOKEN  – Bearer token for your queue platform API
//   JWT_SECRET          – Random string used to sign bypass cookies
//                         (generate one with: openssl rand -hex 32)

// ─── Configuration ───────────────────────────────────────────
// Set these via environment variables in wrangler.jsonc → vars
const CACHE_TTL = 5_000;
const MAX_CACHE_SIZE = 1_000;
const ASSET_REGEX = /\.(css|js|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|map|json)$/i;

let domainCache = new Map();

const NOOP_CONSOLE = {
    log: () => { },
    error: console.error.bind(console),
    warn: console.warn.bind(console),
};

function buildConsole(env) {
    if (env.DEBUG_MODE === "true") return console;
    return NOOP_CONSOLE;
}

// ─── Cache helpers ───────────────────────────────────────────

function cleanupCache() {
    const now = Date.now();
    for (const [key, value] of domainCache) {
        if (now >= value.expire) domainCache.delete(key);
    }
    if (domainCache.size > MAX_CACHE_SIZE) {
        const entries = [...domainCache.entries()]
            .sort((a, b) => a[1].expire - b[1].expire);
        const toRemove = entries.slice(0, domainCache.size - MAX_CACHE_SIZE);
        for (const [key] of toRemove) domainCache.delete(key);
    }
}

// ─── Pattern matching ────────────────────────────────────────

function matchRule(rule, path) {
    switch (rule.pattern_type) {
        case "prefix":
            return path.startsWith(rule.pattern);
        case "exact":
            return rule.pattern === path;
        case "contains":
            return path.includes(rule.pattern);
        case "glob": {
            const escaped = rule.pattern.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&");
            const regex = new RegExp("^" + escaped.replace(/\*/g, ".*") + "$");
            return regex.test(path);
        }
        default:
            return false;
    }
}

// ─── ACL loader (Memory → KV → API) ─────────────────────────

async function fetchACL(domain, env, console) {
    const now = Date.now();
    console.log(`[ACL] Fetching domain=${domain}`);

    if (domainCache.size > MAX_CACHE_SIZE / 2) cleanupCache();

    const cached = domainCache.get(domain);
    if (cached && now < cached.expire) {
        console.log(`[ACL] HIT memory cache`);
        return cached.data;
    }

    const kv = await env.RULES_KV.get(domain, { type: "json" });
    if (kv) {
        console.log(`[ACL] HIT KV`);
        domainCache.set(domain, { data: kv, expire: now + CACHE_TTL });
        return kv;
    }

    console.log(`[ACL] MISS → Fetching API`);
    const safeDomain = encodeURIComponent(domain);
    const resp = await fetch(`${env.API_BASE_URL}/api/v1/edge/config/${safeDomain}`, {
        headers: { Authorization: `Bearer ${env.EDGE_INGRESS_TOKEN}` },
    });

    if (!resp.ok) {
        console.error(`[ACL] API FAIL status=${resp.status}`);
        return null;
    }

    const json = await resp.json();
    console.log(`[ACL] API OK`);
    domainCache.set(domain, { data: json.data, expire: now + CACHE_TTL });

    await env.RULES_KV.put(domain, JSON.stringify(json.data), {
        expirationTtl: 60,
    });

    return json.data;
}

// ─── JWT helpers (HS256) ─────────────────────────────────────

async function sign(payload, secret) {
    const data = JSON.stringify(payload);
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
    const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
    return btoa(`${data}.${hex}`);
}

async function verify(token, secret) {
    try {
        const decoded = atob(token);
        const idx = decoded.lastIndexOf(".");
        if (idx === -1) return false;

        const payloadStr = decoded.slice(0, idx);
        const sigHex = decoded.slice(idx + 1);

        const key = await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(secret),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"]
        );
        const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadStr));
        const calcHex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");

        if (calcHex !== sigHex) return false;

        const payload = JSON.parse(payloadStr);
        if (payload.exp < Math.floor(Date.now() / 1000)) return false;

        return payload;
    } catch {
        return false;
    }
}

// ─── Queue token verification ────────────────────────────────

async function processQueueToken(token, url, env, domain, clientKey, console) {
    console.log(`[QUEUE TOKEN] received token param`);

    const queueApiBaseUrl = `https://${env.QUEUE_DOMAIN}`;
    const redirectTarget = `${url.protocol}//${domain}${url.pathname}`;

    const verifyUrl = new URL("/api/v1/queue/verify", queueApiBaseUrl);
    verifyUrl.searchParams.set("token", token);

    const verifyResp = await fetch(verifyUrl.toString(), {
        headers: { Accept: "application/json" },
    });

    if (!verifyResp.ok) {
        console.log(`[QUEUE TOKEN] verify fail status=${verifyResp.status}`);
        return Response.redirect(redirectTarget, 302);
    }

    const res = await verifyResp.json();
    if (!res.success || !res.data?.finished_line) {
        console.log(`[QUEUE TOKEN] invalid response`);
        return Response.redirect(redirectTarget, 302);
    }

    const payload = {
        t: res.data.token,
        dom: domain,
        ck: clientKey,
        exp: Math.floor(Date.now() / 1000) + 600,
    };

    const signed = await sign(payload, env.JWT_SECRET);

    return new Response("", {
        status: 302,
        headers: {
            "Set-Cookie": `queue_verified=${signed}; Path=/; HttpOnly; Secure; SameSite=Lax`,
            Location: redirectTarget,
        },
    });
}

// ─── Ingress reporting ───────────────────────────────────────

let ingressAccum = new Map();
const DEDUPE_WINDOW_MS = 2_000;
let recentClients = new Map();

async function reportIngress(eventId, env) {
    const accum = ingressAccum.get(eventId) || 0;
    if (accum === 0) return;
    ingressAccum.set(eventId, 0);

    try {
        await fetch(`${env.API_BASE_URL}/api/v1/edge/ingress`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${env.EDGE_INGRESS_TOKEN}`,
            },
            body: JSON.stringify({ event_id: eventId, incoming: accum }),
        });
    } catch (e) {
        console.error(`[INGRESS] report failed`, e);
    }
}

// ─── Main handler ────────────────────────────────────────────

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;

        // Fast bypass for static assets and API routes
        if (path.startsWith("/api/") || ASSET_REGEX.test(path)) {
            return fetch(request);
        }

        const console = buildConsole(env);
        console.log(`[REQ] url=${request.url}`);

        const domain =
            request.headers.get("CF-Original-Host") ||
            request.headers.get("Host");

        const clientKey = request.headers.get("User-Agent") || "";
        const clientIP = request.headers.get("CF-Connecting-IP") || "";

        // 1) Handle ?token= callback from queue
        const token = url.searchParams.get("token");
        if (token) {
            return processQueueToken(token, url, env, domain, clientKey, console);
        }

        // 2) Load ACL rules for this domain
        const rules = await fetchACL(domain, env, console);
        if (!rules?.acls) return fetch(request);

        const rule = rules.acls
            .filter(r => r.enabled)
            .sort((a, b) => b.priority - a.priority)
            .find(r => matchRule(r, path));

        if (!rule) return fetch(request);

        // 3) Bypass action
        if (rule.action === "bypass") return fetch(request);

        // 4) Check for valid bypass cookie
        const cookie = request.headers.get("Cookie") || "";
        const m = cookie.match(/(?:^|;\s*)queue_verified=([^;]+)/);

        if (m) {
            const payload = await verify(m[1], env.JWT_SECRET);
            if (payload && payload.dom === domain && payload.ck === clientKey) {
                return fetch(request);
            }
        }

        // 5) Count visitor for ingress reporting (deduplicated)
        const now = Date.now();
        const dedupeKey = `${clientIP}|${clientKey}`;

        for (const [key, ts] of recentClients) {
            if (now - ts > DEDUPE_WINDOW_MS) recentClients.delete(key);
        }

        if (!recentClients.has(dedupeKey)) {
            recentClients.set(dedupeKey, now);
            ingressAccum.set(rule.event_id, (ingressAccum.get(rule.event_id) || 0) + 1);
        }

        ctx.waitUntil(reportIngress(rule.event_id, env));

        // 6) Redirect to waiting room
        const waitUrl = `https://${env.QUEUE_DOMAIN}/queue/${rule.event_id}`;
        console.log(`[REDIRECT] → ${waitUrl}`);
        return Response.redirect(waitUrl, 302);
    },
};
