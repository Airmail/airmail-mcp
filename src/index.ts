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

import { execFileSync } from "child_process";
import * as net from "net";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const AIRMAIL_HOST = "127.0.0.1";
const AIRMAIL_PORT = (() => {
  const p = parseInt(process.env.AIRMAIL_MCP_PORT ?? "9876", 10);
  if (isNaN(p) || p < 1 || p > 65535) {
    process.stderr.write(`[airmail-mcp] Invalid AIRMAIL_MCP_PORT: "${process.env.AIRMAIL_MCP_PORT}". Must be 1-65535.\n`);
    process.exit(1);
  }
  return p;
})();
const AIRMAIL_PATH = "/mcp";
const VERSION = "1.0.0";
let currentToken = "";

const RETRY_DELAY_MS = 2000;
const MAX_LAUNCH_RETRIES = 5;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_STDIN_BUFFER = 10 * 1024 * 1024; // 10 MB — matches server limit

/** Resolve parent process code signing Team ID (macOS only). */
let parentCodeSignTeamID: string | null = null;
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

    // Extract code signing Team ID — execFileSync avoids shell injection
    const sigInfo = execFileSync("codesign", ["-dv", "--verbose=2", appPath], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    // codesign writes to stderr; try both stdout and stderr
    const match = sigInfo.match(/TeamIdentifier=(\S+)/);
    if (match && match[1] !== "not" && match[1] !== "not set") {
      parentCodeSignTeamID = match[1];
      log(`Parent code sign: Team ID ${parentCodeSignTeamID}`);
    }
  } catch (err) {
    // codesign outputs to stderr — capture from the error object
    if (err && typeof err === "object" && "stderr" in err) {
      const stderr = String((err as { stderr: unknown }).stderr);
      const match = stderr.match(/TeamIdentifier=(\S+)/);
      if (match && match[1] !== "not" && match[1] !== "not set") {
        parentCodeSignTeamID = match[1];
        log(`Parent code sign: Team ID ${parentCodeSignTeamID}`);
        return;
      }
    }
    // Not code-signed or codesign not available — leave as null
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  process.stderr.write(`[airmail-mcp] ${msg}\n`);
}

/** Sanitize a string for use in an HTTP header value (strip CR/LF). */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

function readTokenFromKeychain(): string {
  try {
    const token = execFileSync("security", [
      "find-generic-password",
      "-s", "com.airmail.mcp",
      "-a", "com.airmail.mcp.token",
      "-w",
    ], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    if (token) {
      log("Auth token read from macOS Keychain.");
    }
    return token;
  } catch {
    log(
      "Could not read auth token from macOS Keychain. " +
      "macOS may prompt you to approve Keychain access — click \"Always Allow\" to avoid this next time. " +
      "Alternatively, set the AIRMAIL_MCP_TOKEN environment variable."
    );
    return "";
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
        reqHeaders += `Authorization: Bearer ${token}\r\n`;
      }
      reqHeaders += `X-MCP-Client: ${safeClient}\r\n`;
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

// ---------------------------------------------------------------------------
// stdio ↔ HTTP bridge
// ---------------------------------------------------------------------------

/** Client identity for X-MCP-Client header. Updated from initialize clientInfo. */
let resolvedClientName = "airmail-mcp/1.0";

/** Whether initialize has been sent and completed. */
let initialized = false;
/** Queue of messages waiting for initialize to complete. */
let pendingAfterInit: string[] = [];

async function processMessage(line: string): Promise<void> {
  let parsed: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    parsed = JSON.parse(line);
  } catch {
    log(`Invalid JSON: ${line.slice(0, 200)}`);
    return;
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
    const response = await forward(line, resolvedClientName, currentToken, hasId);

    if (response) {
      process.stdout.write(response + "\n");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Re-read token from Keychain on 401 and retry once
    if (msg.includes("HTTP 401")) {
      if (!process.env.AIRMAIL_MCP_TOKEN) {
        const newToken = readTokenFromKeychain();
        if (newToken && newToken !== currentToken) {
          log("Token rotated in Keychain, retrying with new token.");
          currentToken = newToken;
          try {
            const response = await forward(line, resolvedClientName, currentToken, hasId);
            if (response) { process.stdout.write(response + "\n"); }
            return;
          } catch {
            // Fall through to error handling
          }
        }
      }
      log(
        "Authentication failed (HTTP 401). The auth token is missing or invalid.\n" +
        "  \u2192 Open Airmail \u2192 Preferences \u2192 MCP and copy the current Auth Token\n" +
        "  \u2192 Set it as: export AIRMAIL_MCP_TOKEN=\"your-token-here\"\n" +
        "  \u2192 Or approve the macOS Keychain access prompt if it appears."
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
  }
}

async function main() {
  log(`airmail-mcp v${VERSION} starting (Node.js ${process.version}, pid ${process.pid})`);

  if (process.platform !== "darwin") {
    log("Airmail MCP is macOS-only.");
    process.exit(1);
  }

  // Resolve auth token — done inside main() so stderr is captured by Claude Desktop
  if (process.env.AIRMAIL_MCP_TOKEN) {
    currentToken = process.env.AIRMAIL_MCP_TOKEN;
    log("Auth token provided via AIRMAIL_MCP_TOKEN environment variable.");
  } else {
    log("AIRMAIL_MCP_TOKEN not set, trying macOS Keychain...");
    currentToken = readTokenFromKeychain();
  }

  if (!currentToken) {
    log(
      "WARNING: no auth token found. Requests will fail with 401.\n" +
      "  1. Open Airmail \u2192 Preferences \u2192 MCP and copy the Auth Token\n" +
      "  2. Set it as: export AIRMAIL_MCP_TOKEN=\"your-token-here\"\n" +
      "  Or approve the macOS Keychain prompt when it appears."
    );
  }

  resolveParentCodeSign();
  await ensureAirmailRunning();
  log(`Bridge ready \u2014 Airmail MCP at ${AIRMAIL_HOST}:${AIRMAIL_PORT} (token: ${currentToken ? "present" : "MISSING"})`);

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
  const inflight = new Set<Promise<void>>();

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
            .then(() => {
              initialized = true;
              // Flush queued messages
              for (const queued of pendingAfterInit) { enqueue(queued); }
              pendingAfterInit = [];
            })
            .catch((err) => log(`Initialize error: ${err}`));
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
