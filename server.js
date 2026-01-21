const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

// IMPORTANT:
// If you're serving the UI via Live Server, it auto-reloads on ANY file change in the folder.
// Writing `tournament.json` on every pick will cause constant page refreshes and "undo" selections.
// So we default to saving state OUTSIDE the served folder (OS temp dir).
const FILE = process.env.STATE_FILE
  ? path.resolve(process.env.STATE_FILE)
  : path.join(os.tmpdir(), "pool-tournament-state.json");

const LOCK_TTL_MS = 30_000;
let lock = { owner: null, expiresAt: 0 };

function now() {
  return Date.now();
}

function isLockValid() {
  return !!lock.owner && lock.expiresAt > now();
}

function getClientId(req) {
  return String(req.headers["x-client-id"] || "");
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Client-Id, X-Rev",
    "Access-Control-Expose-Headers": "X-Pool-Tournament-API",
    "X-Pool-Tournament-API": "1",
  });
  res.end(JSON.stringify(obj, null, 2));
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "X-Pool-Tournament-API",
    "X-Pool-Tournament-API": "1",
  });
  res.end(text);
}

function loadState() {
  let s;
  if (fs.existsSync(FILE)) s = JSON.parse(fs.readFileSync(FILE, "utf8"));
  if (!s || typeof s !== "object") s = {};
  // Always include a revision for optimistic concurrency.
  if (typeof s.rev !== "number") s.rev = 0;
  if (!("players" in s)) s.players = [];
  if (!("mode" in s)) s.mode = null;
  if (!("groups" in s)) s.groups = null;
  if (!("matches" in s)) s.matches = [];
  if (!("winner" in s)) s.winner = null;
  return s;
}

function saveState(state) {
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2), "utf8");
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Client-Id, X-Rev",
      "Access-Control-Expose-Headers": "X-Pool-Tournament-API",
      "X-Pool-Tournament-API": "1",
    });
    return res.end();
  }

  if (req.method === "GET" && url.pathname === "/") {
    const htmlPath = path.join(__dirname, "index.html");
    if (!fs.existsSync(htmlPath)) return sendText(res, 404, "index.html not found");
    return sendText(res, 200, fs.readFileSync(htmlPath, "utf8"), "text/html; charset=utf-8");
  }

  if (req.method === "GET" && url.pathname === "/tournament") {
    return sendJson(res, 200, loadState());
  }

  if (req.method === "GET" && url.pathname === "/lock") {
    return sendJson(res, 200, { ...lock, valid: isLockValid(), ttlMs: LOCK_TTL_MS });
  }

  if (req.method === "POST" && url.pathname === "/lock") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const clientId = String(data.clientId || "");
        if (!clientId) return sendJson(res, 400, { error: "clientId required" });

        if (!isLockValid() || lock.owner === clientId) {
          lock = { owner: clientId, expiresAt: now() + LOCK_TTL_MS };
          return sendJson(res, 200, { ...lock, granted: true, valid: true });
        }

        return sendJson(res, 200, { ...lock, granted: false, valid: true });
      } catch (e) {
        return sendJson(res, 400, { error: String(e?.message || e) });
      }
    });
    return;
  }

  if (req.method === "POST" && (url.pathname === "/tournament" || url.pathname === "/reset")) {
    // Enforce editor lock for writes.
    const clientId = getClientId(req);
    if (isLockValid() && clientId !== lock.owner) {
      return sendJson(res, 403, { error: "read-only", lock });
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const current = loadState();

        if (url.pathname === "/reset") {
          const next = { players: [], mode: null, groups: null, matches: [], winner: null, rev: current.rev + 1 };
          saveState(next);
          return sendJson(res, 200, next);
        }

        const incoming = body ? JSON.parse(body) : {};
        const headerRev = req.headers["x-rev"];
        const clientRev = Number(headerRev ?? incoming.rev);
        if (!Number.isFinite(clientRev)) {
          return sendJson(res, 400, { error: "missing x-rev", serverRev: current.rev });
        }
        if (clientRev !== current.rev) {
          return sendJson(res, 409, { error: "conflict", serverRev: current.rev, state: current });
        }

        // Full replace (client sends whole state) with server-controlled revision bump.
        const next = { ...incoming, rev: current.rev + 1 };
        saveState(next);
        return sendJson(res, 200, next);
      } catch (e) {
        return sendJson(res, 400, { error: String(e?.message || e) });
      }
    });
    return;
  }

  return sendText(res, 404, "Not Found");
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`State file: ${FILE}`);
});
