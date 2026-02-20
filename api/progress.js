const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const PROGRESS_KEY = process.env.BANGLA10_PROGRESS_KEY || "bangla10:progress:v1";
const MAX_STATE_BYTES = 900_000;

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function isKvConfigured() {
  return Boolean(KV_URL && KV_TOKEN);
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

async function readEnvelope() {
  const raw = await runRedisCommand(["GET", PROGRESS_KEY]);
  if (!raw) return null;

  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") return null;
  if (typeof parsed.revision !== "number") return null;
  if (!parsed.state || typeof parsed.state !== "object") return null;
  return parsed;
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

  if (!isKvConfigured()) {
    sendJson(res, 503, {
      ok: false,
      error: "KV not configured. Add KV_REST_API_URL and KV_REST_API_TOKEN."
    });
    return;
  }

  if (req.method === "GET") {
    try {
      const envelope = await readEnvelope();
      if (!envelope) {
        sendJson(res, 200, {
          ok: true,
          enabled: true,
          revision: 0,
          updatedAt: null,
          state: null
        });
        return;
      }

      sendJson(res, 200, {
        ok: true,
        enabled: true,
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

      const current = await readEnvelope();
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

      await runRedisCommand(["SET", PROGRESS_KEY, JSON.stringify(envelope)]);

      sendJson(res, 200, {
        ok: true,
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
