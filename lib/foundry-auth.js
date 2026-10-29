// ── Entra ID (managed identity) auth for the Foundry agent ──
// Keyless: the app authenticates as itself, so there is no static secret to
// rotate, leak or commit. Two identity endpoints are supported because they are
// not interchangeable:
//
//   1. IDENTITY_ENDPOINT + IDENTITY_HEADER — Azure App Service, Functions,
//      Container Apps. IMDS is NOT reachable from these.
//   2. IMDS 169.254.169.254 — VMs, AKS, Container Instances.
//
// Tokens are cached in-process until shortly before expiry.

const DEFAULT_SCOPE = "https://ai.azure.com/.default";
const REFRESH_SKEW_MS = 5 * 60 * 1000; // refresh 5 min early
const IDENTITY_TIMEOUT_MS = 5000;
const IMDS_TIMEOUT_MS = 2000;
// Identity probes that fail are remembered briefly, otherwise every chat turn
// would pay the IMDS timeout again on a host that has no identity.
const NEGATIVE_TTL_MS = 30 * 1000;

const cache = new Map();
const failures = new Map();

function normalizeScope(scope) {
  const s = String(scope || "").trim() || DEFAULT_SCOPE;
  return /\/\.default$/.test(s) ? s : s.replace(/\/+$/, "") + "/.default";
}

// AAD wants ".../.default"; the identity endpoints want the resource URI.
function resourceForScope(scope) {
  return normalizeScope(scope).replace(/\/\.default$/, "");
}

async function withTimeout(fn, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function expiryFrom(data) {
  const fallback = Date.now() + 30 * 60 * 1000;
  if (!data) return fallback;

  // expires_on / expiresOn: an absolute epoch (seconds, occasionally ms) or ISO.
  const on = data.expires_on !== undefined ? data.expires_on : data.expiresOn;
  if (on !== undefined && on !== null && on !== "") {
    if (typeof on === "number") return on > 1e12 ? on : on * 1000;
    if (/^\d+$/.test(String(on))) return Number(on) * 1000;
    const parsed = Date.parse(String(on));
    if (!Number.isNaN(parsed)) return parsed;
  }

  // expires_in / expiresIn: a duration in seconds, relative to now.
  const inSec = data.expires_in !== undefined ? data.expires_in : data.expiresIn;
  if (inSec !== undefined && inSec !== null && inSec !== "") {
    const seconds = Number(inSec);
    if (Number.isFinite(seconds) && seconds > 0) return Date.now() + seconds * 1000;
  }

  return fallback;
}

function readToken(data, source) {
  if (!data || !data.access_token) return null;
  return { token: data.access_token, expiresAt: expiryFrom(data), source };
}

// App Service / Functions / Container Apps
async function fromIdentityEndpoint({ resource, clientId }) {
  const endpoint = process.env.IDENTITY_ENDPOINT;
  const header = process.env.IDENTITY_HEADER;
  if (!endpoint) return null;
  const version = process.env.IDENTITY_ENDPOINT_API_VERSION || "2019-08-01";
  const url =
    endpoint +
    (endpoint.includes("?") ? "&" : "?") +
    `api-version=${encodeURIComponent(version)}&resource=${encodeURIComponent(resource)}` +
    (clientId ? `&client_id=${encodeURIComponent(clientId)}` : "");
  try {
    return await withTimeout(async (signal) => {
      const res = await fetch(url, {
        headers: header ? { "X-IDENTITY-HEADER": header } : {},
        signal,
      });
      if (!res.ok) {
        console.error(`[foundry-auth] IDENTITY_ENDPOINT returned HTTP ${res.status}`);
        return null;
      }
      return readToken(await res.json(), "identity-endpoint");
    }, IDENTITY_TIMEOUT_MS);
  } catch (err) {
    console.error("[foundry-auth] IDENTITY_ENDPOINT failed:", err.message);
    return null;
  }
}

// VMs / AKS / ACI
async function fromImds({ resource, clientId }) {
  const base =
    process.env.IMDS_ENDPOINT ||
    "http://169.254.169.254/metadata/identity/oauth2/token";
  const url =
    `${base}?api-version=2018-02-01&resource=${encodeURIComponent(resource)}` +
    (clientId ? `&client_id=${encodeURIComponent(clientId)}` : "");
  try {
    return await withTimeout(async (signal) => {
      const res = await fetch(url, { headers: { Metadata: "true" }, signal });
      if (!res.ok) return null;
      return readToken(await res.json(), "imds");
    }, IMDS_TIMEOUT_MS);
  } catch (err) {
    // No identity on this host is the normal case for a laptop or sandbox.
    return null;
  }
}

async function getFoundryToken({ scope, clientId, forceRefresh = false } = {}) {
  const normalized = normalizeScope(scope);
  const resource = resourceForScope(normalized);
  const cacheKey = `${resource}|${clientId || ""}`;

  if (!forceRefresh) {
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAt - REFRESH_SKEW_MS > Date.now()) return hit;
    const failedAt = failures.get(cacheKey);
    if (failedAt && Date.now() - failedAt < NEGATIVE_TTL_MS) return null;
  }

  const token =
    (await fromIdentityEndpoint({ resource, clientId })) ||
    (await fromImds({ resource, clientId }));

  if (!token) {
    cache.delete(cacheKey);
    failures.set(cacheKey, Date.now());
    return null;
  }
  failures.delete(cacheKey);
  cache.set(cacheKey, token);
  return token;
}

function describeIdentityConfig() {
  return {
    identityEndpoint: Boolean(process.env.IDENTITY_ENDPOINT),
    imdsEndpoint: process.env.IMDS_ENDPOINT || "http://169.254.169.254",
    clientId: process.env.FOUNDRY_CLIENT_ID || null,
  };
}

function clearTokenCache() {
  cache.clear();
  failures.clear();
}

module.exports = {
  getFoundryToken,
  normalizeScope,
  resourceForScope,
  describeIdentityConfig,
  clearTokenCache,
  DEFAULT_SCOPE,
  REFRESH_SKEW_MS,
};
