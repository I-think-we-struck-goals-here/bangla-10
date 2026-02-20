const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const PROGRESS_KEY = process.env.BANGLA10_PROGRESS_KEY || "bangla10:progress:v1";
const BLOB_PATH = process.env.BANGLA10_PROGRESS_BLOB_PATH || "bangla10/progress.json";
const MAX_STATE_BYTES = 900_000;

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function resolveStorageMode() {
  if (KV_URL && KV_TOKEN) return "kv";
  if (BLOB_TOKEN) return "blob";
  return null;
}

async function runRedisCommand(command) {
  const response = await fetch(KV_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    const detail = payload.error || `KV request failed (${response.status})`;
    throw new Error(detail);
  }

  return payload.result;
}

async function getBlobSdk() {
  const mod = await import("@vercel/blob");
  return mod;
}

function parseEnvelope(raw) {
  if (!raw) return null;
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!parsed || typeof parsed !== "object") return null;
  if (typeof parsed.revision !== "number") return null;
  if (!parsed.state || typeof parsed.state !== "object") return null;
  return parsed;
}

async function readEnvelopeFromKv() {
  const raw = await runRedisCommand(["GET", PROGRESS_KEY]);
  return parseEnvelope(raw);
}

async function writeEnvelopeToKv(envelope) {
  await runRedisCommand(["SET", PROGRESS_KEY, JSON.stringify(envelope)]);
}

async function readEnvelopeFromBlob() {
  const { list } = await getBlobSdk();
  const { blobs } = await list({
    prefix: BLOB_PATH,
    limit: 5,
    token: BLOB_TOKEN
  });

  const target = blobs.find((blob) => blob.pathname === BLOB_PATH);
  if (!target) return null;

  const response = await fetch(target.url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Blob read failed (${response.status})`);
  }

  const payload = await response.json();
  return parseEnvelope(payload);
}

async function writeEnvelopeToBlob(envelope) {
  const { put } = await getBlobSdk();
  await put(BLOB_PATH, JSON.stringify(envelope), {
    token: BLOB_TOKEN,
    access: "public",
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: "application/json; charset=utf-8",
    cacheControlMaxAge: 0
  });
}

async function readEnvelope(mode) {
  if (mode === "kv") return readEnvelopeFromKv();
  return readEnvelopeFromBlob();
}

async function writeEnvelope(mode, envelope) {
  if (mode === "kv") {
    await writeEnvelopeToKv(envelope);
    return;
  }
  await writeEnvelopeToBlob(envelope);
}

function normalizeIncomingBody(body) {
  if (!body) return {};
  if (typeof body === "object") return body;
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  return {};
}

function sanitizeState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("Invalid state payload");
  }

  const asText = JSON.stringify(state);
  if (Buffer.byteLength(asText, "utf8") > MAX_STATE_BYTES) {
    throw new Error("State payload is too large");
  }
  return JSON.parse(asText);
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  const storageMode = resolveStorageMode();
  if (!storageMode) {
    sendJson(res, 503, {
      ok: false,
      error:
        "No server storage configured. Set KV_REST_API_URL/KV_REST_API_TOKEN or BLOB_READ_WRITE_TOKEN."
    });
    return;
  }

  if (req.method === "GET") {
    try {
      const envelope = await readEnvelope(storageMode);
      if (!envelope) {
        sendJson(res, 200, {
          ok: true,
          enabled: true,
          backend: storageMode,
          revision: 0,
          updatedAt: null,
          state: null
        });
        return;
      }

      sendJson(res, 200, {
        ok: true,
        enabled: true,
        backend: storageMode,
        revision: envelope.revision,
        updatedAt: envelope.updatedAt || null,
        state: envelope.state
      });
    } catch (error) {
      sendJson(res, 502, {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to read progress"
      });
    }
    return;
  }

  if (req.method === "POST") {
    try {
      const body = normalizeIncomingBody(req.body);
      const nextState = sanitizeState(body.state);

      const current = await readEnvelope(storageMode);
      const nextRevision = (current?.revision || 0) + 1;
      const updatedAt = new Date().toISOString();

      nextState.meta = {
        ...(nextState.meta || {}),
        revision: nextRevision,
        lastSyncedAt: updatedAt,
        dirty: false
      };

      const envelope = {
        revision: nextRevision,
        updatedAt,
        state: nextState
      };

      await writeEnvelope(storageMode, envelope);

      sendJson(res, 200, {
        ok: true,
        backend: storageMode,
        revision: nextRevision,
        updatedAt
      });
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to save progress"
      });
    }
    return;
  }

  sendJson(res, 405, { ok: false, error: "Method not allowed" });
};
