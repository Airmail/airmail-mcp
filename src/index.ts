#!/usr/bin/env node

/**
 * Airmail MCP — Desktop Extension
 *
 * stdio↔HTTP bridge connecting Claude Desktop / Claude Code to Airmail's
 * built-in MCP server on localhost.
 *
 * Uses raw TCP sockets instead of Node.js http module because Airmail's
 * NWListener closes the connection immediately after sending — the http
 * module can miss the response body ("socket hang up"). Raw sockets
 * collect all data before the FIN arrives.
 */

import { execFileSync, spawnSync } from "child_process";
import { createHash } from "crypto";
import { readFileSync, writeSync } from "fs";
import * as net from "net";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const AIRMAIL_HOST = "127.0.0.1";
const AIRMAIL_PORT = (() => {
  const p = parseInt(process.env.AIRMAIL_MCP_PORT ?? "9876", 10);
  if (isNaN(p) || p < 1 || p > 65535) {
    try { writeSync(2, `[airmail-mcp] Invalid AIRMAIL_MCP_PORT: "${process.env.AIRMAIL_MCP_PORT}". Must be 1-65535.\n`); } catch { /* fd closed */ }
    process.exit(1);
  }
  return p;
})();
const AIRMAIL_PATH = "/mcp";
const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch { return "0.0.0"; }
})();
let currentToken = "";
let clientTokenPromise: Promise<void> | null = null;

const RETRY_DELAY_MS = 2000;
const MAX_LAUNCH_RETRIES = 5;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_STDIN_BUFFER = 10 * 1024 * 1024; // 10 MB — matches server limit
const REMEMBER_CLIENT_TOKEN = /^(1|true|yes)$/i.test(process.env.AIRMAIL_MCP_REMEMBER_CLIENT_TOKEN ?? "");

/** Resolve parent process code signing Team ID (macOS only). */
let parentCodeSignTeamID: string | null = null;
let parentPhysicalIdentity: string | null = null;
let parentBundleIdentifier: string | null = null;
function resolveParentCodeSign(): void {
  try {
    const ppid = process.ppid;
    // Get parent executable path — ppid is always numeric, safe for arg
    const parentPath = execFileSync("ps", ["-p", String(ppid), "-o", "comm="], { encoding: "utf-8" }).trim();
    if (!parentPath) return;

    // Walk up to find .app bundle (if any)
    let appPath = parentPath;
    const appIdx = parentPath.indexOf(".app/");
    if (appIdx !== -1) {
      appPath = parentPath.slice(0, appIdx + 4);
    }
    parentPhysicalIdentity = appIdx !== -1 ? `app:${appPath}` : `path:${parentPath}`;

    // codesign writes everything to stderr — use spawnSync to capture it
    const result = spawnSync("codesign", ["-dv", "--verbose=2", appPath], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output = (result.stdout || "") + (result.stderr || "");
    const identifierMatch = output.match(/Identifier=(\S+)/);
    if (identifierMatch) {
      parentBundleIdentifier = identifierMatch[1];
      log(`Parent identity: ${parentBundleIdentifier} (${parentPhysicalIdentity})`);
    }
    const match = output.match(/TeamIdentifier=(\S+)/);
    if (match && match[1] !== "not" && match[1] !== "not set") {
      parentCodeSignTeamID = match[1];
      log(`Parent code sign: Team ID ${parentCodeSignTeamID}`);
    }
  } catch {
    // Not code-signed or codesign not available — leave as null
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  const line = `${new Date().toISOString()} [airmail-mcp] ${msg}\n`;
  try { writeSync(2, line); } catch { /* fd closed or unavailable */ }
}

/** Sanitize a string for use in an HTTP header value (strip CR/LF). */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

function splitClientIdentity(clientName: string): { name: string; version: string } {
  const idx = clientName.indexOf("/");
  if (idx === -1) {
    return { name: clientName || "airmail-mcp", version: VERSION };
  }
  const name = clientName.slice(0, idx) || "airmail-mcp";
  const version = clientName.slice(idx + 1) || VERSION;
  return { name, version };
}

function canonicalClientName(clientName: string): string {
  return splitClientIdentity(clientName).name;
}

function clientTokenAccount(clientName: string): string {
  const identity = parentPhysicalIdentity ?? "unknown";
  const hash = createHash("sha256").update(`${canonicalClientName(clientName)}|${identity}`).digest("hex").slice(0, 24);
  return `airmail-mcp:${hash}`;
}

function readClientToken(clientName: string): string {
  try {
    return execFileSync("security", [
      "find-generic-password",
      "-s", "com.airmail.mcp.client",
      "-a", clientTokenAccount(clientName),
      "-w",
    ], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

function saveClientToken(clientName: string, token: string): void {
  execFileSync("security", [
    "add-generic-password",
    "-U",
    "-s", "com.airmail.mcp.client",
    "-a", clientTokenAccount(clientName),
    "-w", token,
  ], { stdio: ["pipe", "pipe", "pipe"] });
}

function deleteClientToken(clientName: string): void {
  try {
    execFileSync("security", [
      "delete-generic-password",
      "-s", "com.airmail.mcp.client",
      "-a", clientTokenAccount(clientName),
    ], { stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    // Missing token is fine.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function ping(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    function settle(v: boolean) { if (!settled) { settled = true; resolve(v); } }

    const sock = net.createConnection({ host: AIRMAIL_HOST, port: AIRMAIL_PORT }, () => {
      sock.destroy();
      settle(true);
    });
    sock.setTimeout(3000);
    sock.on("error", () => settle(false));
    sock.on("timeout", () => { sock.destroy(); settle(false); });
  });
}

async function ensureAirmailRunning(): Promise<void> {
  if (await ping()) return;
  log("Airmail MCP server not reachable, launching Airmail...");
  try {
    execFileSync("open", ["-a", "Airmail"], { stdio: "ignore" });
  } catch {
    log("Could not launch Airmail. Is it installed?");
    process.exit(1);
  }
  for (let i = 0; i < MAX_LAUNCH_RETRIES; i++) {
    await sleep(RETRY_DELAY_MS);
    if (await ping()) { log("Airmail MCP server is ready."); return; }
  }
  log("Airmail launched but MCP server not available. Enable MCP in Airmail Preferences.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// HTTP response parsing (operates on Buffers for byte-correct handling)
// ---------------------------------------------------------------------------

interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const HEADER_SEPARATOR = Buffer.from("\r\n\r\n");
const CRLF = Buffer.from("\r\n");

/** Parse raw HTTP response bytes into status, headers, and body. Handles chunked TE. */
function parseHttpResponse(raw: Buffer): HttpResponse | null {
  const headerEnd = raw.indexOf(HEADER_SEPARATOR);
  if (headerEnd === -1) return null;

  // Headers are always ASCII-safe
  const headerPart = raw.subarray(0, headerEnd).toString("utf-8");
  let bodyBuf = raw.subarray(headerEnd + 4);

  // Status line
  const statusMatch = headerPart.match(/^HTTP\/\d\.\d\s+(\d+)/);
  const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 0;

  // Parse headers
  const headers: Record<string, string> = {};
  for (const line of headerPart.split("\r\n").slice(1)) {
    const colon = line.indexOf(":");
    if (colon !== -1) {
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
  }

  // Decode chunked transfer encoding (byte-level)
  if (headers["transfer-encoding"]?.toLowerCase() === "chunked") {
    bodyBuf = decodeChunked(bodyBuf);
  }

  // Validate Content-Length if present
  const contentLength = headers["content-length"];
  if (contentLength && !headers["transfer-encoding"]) {
    const expected = parseInt(contentLength, 10);
    if (!isNaN(expected) && bodyBuf.length < expected) {
      return null; // Incomplete response
    }
  }

  return { statusCode, headers, body: bodyBuf.toString("utf-8").trim() };
}

/** Decode a chunked HTTP body. Operates on Buffer for byte-correct slicing. */
function decodeChunked(raw: Buffer): Buffer {
  const parts: Buffer[] = [];
  let pos = 0;
  while (pos < raw.length) {
    const lineEnd = raw.indexOf(CRLF, pos);
    if (lineEnd === -1) break;
    // Chunk size line — parseInt stops at non-hex chars (handles chunk extensions per RFC 7230)
    const sizeStr = raw.subarray(pos, lineEnd).toString("ascii").trim();
    const size = parseInt(sizeStr, 16);
    if (isNaN(size) || size === 0) break;
    const chunkStart = lineEnd + 2;
    if (chunkStart + size > raw.length) break; // Incomplete chunk
    parts.push(raw.subarray(chunkStart, chunkStart + size));
    pos = chunkStart + size + 2; // skip chunk data + \r\n
  }
  return Buffer.concat(parts);
}

/** Settle a forward() promise from parsed HTTP response or raw chunks. */
function settleFromChunks(
  chunks: Buffer[],
  hasId: boolean,
  resolve: (v: string) => void,
  reject: (e: Error) => void
): void {
  if (chunks.length === 0) {
    if (hasId) {
      reject(new Error("Empty response from Airmail"));
    } else {
      resolve("");
    }
    return;
  }

  const raw = Buffer.concat(chunks);
  const parsed = parseHttpResponse(raw);

  if (!parsed) {
    if (hasId) {
      reject(new Error("Incomplete or malformed HTTP response from Airmail"));
    } else {
      resolve("");
    }
    return;
  }
  if (parsed.statusCode === 202) { resolve(""); return; }
  if (parsed.statusCode >= 400) {
    // Truncate body in error message to avoid leaking sensitive data
    const safeBody = parsed.body.length > 200 ? parsed.body.slice(0, 200) + "..." : parsed.body;
    reject(new Error(`Airmail HTTP ${parsed.statusCode}: ${safeBody}`));
    return;
  }
  resolve(parsed.body);
}

// ---------------------------------------------------------------------------
// Raw TCP HTTP forwarding
// ---------------------------------------------------------------------------

/**
 * Send an HTTP POST via raw TCP socket and return the response body.
 *
 * Airmail's NWListener calls connection.cancel() in the send completion handler,
 * which means the TCP FIN can arrive before Node.js http module finishes parsing.
 * Using raw sockets, we collect all data until the connection closes, then parse
 * the HTTP response ourselves.
 */
function forward(body: string, clientName: string, token: string, hasId: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) { settled = true; sock.destroy(); reject(new Error("Request timed out")); }
    }, REQUEST_TIMEOUT_MS);

    function finish(err?: Error) {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (err && chunks.length === 0) { reject(err); return; }
      // If we have an error but also data, the connection may have closed
      // after sending a complete response (expected with NWListener).
      // Only trust the data if it parses as valid HTTP.
      if (err && chunks.length > 0) {
        const raw = Buffer.concat(chunks);
        const parsed = parseHttpResponse(raw);
        if (!parsed) {
          reject(new Error(`Connection error with partial response: ${err.message}`));
          return;
        }
      }
      settleFromChunks(chunks, hasId, resolve, reject);
    }

    const sock = net.createConnection({ host: AIRMAIL_HOST, port: AIRMAIL_PORT }, () => {
      // Build and send raw HTTP request as a single write
      const bodyBuf = Buffer.from(body, "utf-8");
      const safeClient = sanitizeHeaderValue(clientName);
      let reqHeaders = `POST ${AIRMAIL_PATH} HTTP/1.1\r\n`;
      reqHeaders += `Host: ${AIRMAIL_HOST}:${AIRMAIL_PORT}\r\n`;
      reqHeaders += `Content-Type: application/json\r\n`;
      reqHeaders += `Content-Length: ${bodyBuf.length}\r\n`;
      reqHeaders += `Accept: application/json\r\n`;
      reqHeaders += `Connection: close\r\n`;
      reqHeaders += `User-Agent: airmail-mcp/1.0\r\n`;
      if (token) {
        reqHeaders += `Authorization: Bearer ${sanitizeHeaderValue(token)}\r\n`;
      }
      reqHeaders += `X-MCP-Client: ${safeClient}\r\n`;
      if (parentPhysicalIdentity) {
        reqHeaders += `X-MCP-Physical-Identity: ${sanitizeHeaderValue(parentPhysicalIdentity)}\r\n`;
      }
      if (parentBundleIdentifier) {
        reqHeaders += `X-MCP-Bundle-ID: ${sanitizeHeaderValue(parentBundleIdentifier)}\r\n`;
      }
      if (parentCodeSignTeamID) {
        reqHeaders += `X-MCP-CodeSign: ${sanitizeHeaderValue(parentCodeSignTeamID)}\r\n`;
      }
      reqHeaders += `\r\n`;

      // Single atomic write to avoid backpressure issues
      sock.write(Buffer.concat([Buffer.from(reqHeaders), bodyBuf]));
    });

    sock.on("data", (chunk) => chunks.push(chunk));
    sock.on("end", () => finish());
    sock.on("error", (err) => finish(err));
    sock.on("close", () => finish());
  });
}

async function pairClient(clientName: string): Promise<string> {
  if (!parentPhysicalIdentity) {
    throw new Error("Cannot pair without a stable parent process identity.");
  }

  const client = splitClientIdentity(clientName);
  const body = JSON.stringify({
    client_name: client.name,
    client_version: client.version,
    physical_identity: parentPhysicalIdentity,
    team_id: parentCodeSignTeamID ?? "",
  });

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; sock.destroy(); reject(new Error("Pairing timed out")); }
    }, REQUEST_TIMEOUT_MS);

    function finish(err?: Error) {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (err && chunks.length === 0) { reject(err); return; }
      const parsed = parseHttpResponse(Buffer.concat(chunks));
      if (!parsed) { reject(new Error("Malformed pairing response from Airmail")); return; }
      if (parsed.statusCode >= 400) {
        reject(new Error(`Pairing failed (HTTP ${parsed.statusCode}): ${parsed.body.slice(0, 200)}`));
        return;
      }
      try {
        const json = JSON.parse(parsed.body) as { client_token?: string };
        if (!json.client_token) { reject(new Error("Pairing response did not include a client token")); return; }
        resolve(json.client_token);
      } catch {
        reject(new Error("Pairing response was not JSON"));
      }
    }

    const sock = net.createConnection({ host: AIRMAIL_HOST, port: AIRMAIL_PORT }, () => {
      const bodyBuf = Buffer.from(body, "utf-8");
      let reqHeaders = `POST /mcp/pair HTTP/1.1\r\n`;
      reqHeaders += `Host: ${AIRMAIL_HOST}:${AIRMAIL_PORT}\r\n`;
      reqHeaders += `Content-Type: application/json\r\n`;
      reqHeaders += `Content-Length: ${bodyBuf.length}\r\n`;
      reqHeaders += `Accept: application/json\r\n`;
      reqHeaders += `Connection: close\r\n`;
      reqHeaders += `User-Agent: airmail-mcp/${VERSION}\r\n`;
      reqHeaders += `X-MCP-Client: ${sanitizeHeaderValue(client.name)}\r\n`;
      reqHeaders += `X-MCP-Physical-Identity: ${sanitizeHeaderValue(parentPhysicalIdentity ?? "")}\r\n`;
      if (parentCodeSignTeamID) {
        reqHeaders += `X-MCP-CodeSign: ${sanitizeHeaderValue(parentCodeSignTeamID)}\r\n`;
      }
      reqHeaders += `\r\n`;
      sock.write(Buffer.concat([Buffer.from(reqHeaders), bodyBuf]));
    });

    sock.on("data", (chunk) => chunks.push(chunk));
    sock.on("end", () => finish());
    sock.on("error", (err) => finish(err));
    sock.on("close", () => finish());
  });
}

async function ensureClientToken(clientName: string): Promise<void> {
  if (currentToken) return;
  if (clientTokenPromise) {
    await clientTokenPromise;
    return;
  }

  clientTokenPromise = (async () => {
    if (REMEMBER_CLIENT_TOKEN) {
      const storedToken = readClientToken(clientName);
      if (storedToken) {
        currentToken = storedToken;
        log("Client token loaded from bridge Keychain.");
        return;
      }
    }

    log("No client token found; requesting pairing approval from Airmail.");
    const token = await pairClient(clientName);
    currentToken = token;
    if (REMEMBER_CLIENT_TOKEN) {
      saveClientToken(clientName, token);
      log("Client token saved to bridge Keychain.");
    } else {
      log("Client token kept in memory for this bridge session.");
    }
  })();

  try {
    await clientTokenPromise;
  } finally {
    clientTokenPromise = null;
  }
}

// ---------------------------------------------------------------------------
// stdio ↔ HTTP bridge
// ---------------------------------------------------------------------------

/** Client identity for X-MCP-Client header. Updated from initialize clientInfo. */
let resolvedClientName = "airmail-mcp/1.0";

/** Whether initialize has been sent and completed. */
let initialized = false;
/** Queue of messages waiting for initialize to complete. */
let pendingAfterInit: string[] = [];

async function processMessage(line: string): Promise<boolean> {
  let parsed: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    parsed = JSON.parse(line);
  } catch {
    log(`Invalid JSON: ${line.slice(0, 200)}`);
    return false;
  }

  const hasId = parsed.id !== undefined;

  // Extract client identity from initialize for X-MCP-Client header
  if (parsed.method === "initialize" && parsed.params) {
    const ci = parsed.params.clientInfo as { name?: string; version?: string } | undefined;
    if (ci?.name) {
      resolvedClientName = ci.version ? `${ci.name}/${ci.version}` : ci.name;
    }
  }

  try {
    const authClientName = canonicalClientName(resolvedClientName);
    await ensureClientToken(authClientName);
    const response = await forward(line, authClientName, currentToken, hasId);

    if (response) {
      process.stdout.write(response + "\n");
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Client token may have been revoked or bound to an old identity; re-pair once.
    if (msg.includes("HTTP 401")) {
      const authClientName = canonicalClientName(resolvedClientName);
      if (REMEMBER_CLIENT_TOKEN) {
        deleteClientToken(authClientName);
      }
      currentToken = "";
      try {
        await ensureClientToken(authClientName);
        const response = await forward(line, authClientName, currentToken, hasId);
        if (response) { process.stdout.write(response + "\n"); }
        return true;
      } catch {
        // Fall through to error handling
      }
      log(
        "Authentication failed (HTTP 401). The client pairing token is missing, invalid, or revoked.\n" +
        "  \u2192 Approve the Airmail pairing prompt, or revoke the client in Airmail Preferences > MCP > Permissions and pair again."
      );
    }

    if (hasId) {
      // Sanitize error message — don't forward raw server responses that may contain tokens
      const safeMsg = msg.length > 300 ? msg.slice(0, 300) + "..." : msg;
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: parsed.id,
        error: { code: -32000, message: safeMsg },
      }) + "\n");
    } else {
      log(`Notification error: ${msg}`);
    }
    return false;
  }
}

async function main() {
  log(`airmail-mcp v${VERSION} starting (Node.js ${process.version}, pid ${process.pid})`);

  if (process.platform !== "darwin") {
    log("Airmail MCP is macOS-only.");
    process.exit(1);
  }

  resolveParentCodeSign();

  log(`Bridge will use per-client pairing (${REMEMBER_CLIENT_TOKEN ? "remembered Keychain token" : "memory-only token"}).`);

  await ensureAirmailRunning();
  log(`Bridge ready \u2014 Airmail MCP at ${AIRMAIL_HOST}:${AIRMAIL_PORT} (pairing mode)`);

  // Handle stdout errors (broken pipe)
  process.stdout.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "EPIPE") {
      process.exit(0);
    }
    log(`stdout error: ${err.message}`);
    process.exit(1);
  });

  // Graceful shutdown — drain inflight requests before exiting
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (inflight.size === 0) { process.exit(0); }
    log(`Shutting down, waiting for ${inflight.size} inflight request(s)...`);
    // Force exit after 5 seconds if inflight requests don't complete
    setTimeout(() => { process.exit(0); }, 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);

  let buffer = "";
  let stdinClosed = false;
  const inflight = new Set<Promise<unknown>>();

  function enqueue(line: string) {
    const p = processMessage(line).catch((err) => log(`Error: ${err}`));
    inflight.add(p);
    p.finally(() => {
      inflight.delete(p);
      if ((stdinClosed || shuttingDown) && inflight.size === 0) process.exit(0);
    });
  }

  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => {
    if (shuttingDown) return;
    buffer += chunk;

    // Protect against unbounded memory growth — drop only the oversized portion,
    // preserving any trailing partial line for framing continuity
    if (buffer.length > MAX_STDIN_BUFFER) {
      log("stdin buffer exceeded 10 MB, dropping accumulated data.");
      const lastNewline = buffer.lastIndexOf("\n");
      if (lastNewline !== -1) {
        // Keep the trailing partial line so framing stays aligned
        buffer = buffer.slice(lastNewline + 1);
      } else {
        buffer = "";
      }
      return;
    }

    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;

      // Serialize initialize — queue other messages until it completes
      if (!initialized) {
        let parsed: { method?: string };
        try { parsed = JSON.parse(line); } catch { continue; }

        if (parsed.method === "initialize") {
          const p = processMessage(line)
            .then((ok) => {
              if (!ok) throw new Error("initialize failed");
              initialized = true;
              // Flush queued messages
              for (const queued of pendingAfterInit) { enqueue(queued); }
              pendingAfterInit = [];
            })
            .catch((err) => {
              log(`Initialize error: ${err}`);
              // Send error responses for queued requests so clients don't hang
              for (const queued of pendingAfterInit) {
                try {
                  const q = JSON.parse(queued);
                  if (q.id !== undefined) {
                    process.stdout.write(JSON.stringify({
                      jsonrpc: "2.0", id: q.id,
                      error: { code: -32002, message: "Server failed to initialize" },
                    }) + "\n");
                  }
                } catch { /* not valid JSON, skip */ }
              }
              pendingAfterInit = [];
            });
          inflight.add(p);
          p.finally(() => {
            inflight.delete(p);
            if ((stdinClosed || shuttingDown) && inflight.size === 0) process.exit(0);
          });
        } else {
          // Queue until initialize completes (notifications/initialized are fine to queue)
          pendingAfterInit.push(line);
        }
      } else {
        enqueue(line);
      }
    }
  });
  process.stdin.on("end", () => {
    stdinClosed = true;
    if (inflight.size === 0) { log("stdin closed, exiting."); process.exit(0); }
  });
}

main().catch((err) => { log(`Fatal: ${err}`); process.exit(1); });
