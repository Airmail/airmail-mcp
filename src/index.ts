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

import { execSync } from "child_process";
import * as net from "net";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const AIRMAIL_HOST = "127.0.0.1";
const AIRMAIL_PORT = parseInt(process.env.AIRMAIL_MCP_PORT ?? "9876", 10);
const AIRMAIL_PATH = "/mcp";
let currentToken = process.env.AIRMAIL_MCP_TOKEN || readTokenFromKeychain();

const RETRY_DELAY_MS = 2000;
const MAX_LAUNCH_RETRIES = 5;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_STDIN_BUFFER = 10 * 1024 * 1024; // 10 MB — matches server limit

/** Resolve parent process code signing Team ID (macOS only). */
let parentCodeSignTeamID: string | null = null;
function resolveParentCodeSign(): void {
  try {
    const ppid = process.ppid;
    // Get parent executable path
    const parentPath = execSync(`ps -p ${ppid} -o comm=`, { encoding: "utf-8" }).trim();
    if (!parentPath) return;

    // Walk up to find .app bundle (if any)
    let appPath = parentPath;
    const appIdx = parentPath.indexOf(".app/");
    if (appIdx !== -1) {
      appPath = parentPath.slice(0, appIdx + 4);
    }

    // Extract code signing Team ID
    const sigInfo = execSync(`codesign -dv --verbose=2 "${appPath}" 2>&1`, { encoding: "utf-8" });
    const match = sigInfo.match(/TeamIdentifier=(\S+)/);
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
  process.stderr.write(`[airmail-mcp] ${msg}\n`);
}

function readTokenFromKeychain(): string {
  try {
    return execSync(
      'security find-generic-password -s "com.airmail.mcp" -a "com.airmail.mcp.token" -w 2>/dev/null',
      { encoding: "utf-8" }
    ).trim();
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function ping(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: AIRMAIL_HOST, port: AIRMAIL_PORT }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.setTimeout(3000);
    sock.on("error", () => resolve(false));
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
  });
}

async function ensureAirmailRunning(): Promise<void> {
  if (await ping()) return;
  log("Airmail MCP server not reachable, launching Airmail...");
  try {
    execSync("open -a Airmail", { stdio: "ignore" });
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
// HTTP response parsing
// ---------------------------------------------------------------------------

interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/** Parse raw HTTP response bytes into status, headers, and body. Handles chunked TE. */
function parseHttpResponse(raw: string): HttpResponse | null {
  const headerEnd = raw.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;

  const headerPart = raw.slice(0, headerEnd);
  let body = raw.slice(headerEnd + 4);

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

  // Decode chunked transfer encoding
  if (headers["transfer-encoding"]?.toLowerCase() === "chunked") {
    body = decodeChunked(body);
  }

  return { statusCode, headers, body: body.trim() };
}

/** Decode a chunked HTTP body. */
function decodeChunked(raw: string): string {
  let result = "";
  let pos = 0;
  while (pos < raw.length) {
    const lineEnd = raw.indexOf("\r\n", pos);
    if (lineEnd === -1) break;
    const sizeStr = raw.slice(pos, lineEnd).trim();
    const size = parseInt(sizeStr, 16);
    if (isNaN(size) || size === 0) break;
    const chunkStart = lineEnd + 2;
    result += raw.slice(chunkStart, chunkStart + size);
    pos = chunkStart + size + 2; // skip chunk data + \r\n
  }
  return result;
}

/** Settle a forward() promise from parsed HTTP response or raw chunks. */
function settleFromChunks(
  chunks: Buffer[],
  resolve: (v: string) => void,
  reject: (e: Error) => void
): void {
  if (chunks.length === 0) { resolve(""); return; }

  const raw = Buffer.concat(chunks).toString("utf-8");
  const parsed = parseHttpResponse(raw);

  if (!parsed) { resolve(""); return; }
  if (parsed.statusCode === 202) { resolve(""); return; }
  if (parsed.statusCode >= 400) {
    reject(new Error(`Airmail HTTP ${parsed.statusCode}: ${parsed.body}`));
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
function forward(body: string, clientName: string, token: string): Promise<string> {
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
      settleFromChunks(chunks, resolve, reject);
    }

    const sock = net.createConnection({ host: AIRMAIL_HOST, port: AIRMAIL_PORT }, () => {
      // Build and send raw HTTP request as a single write
      const bodyBuf = Buffer.from(body, "utf-8");
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
      reqHeaders += `X-MCP-Client: ${clientName}\r\n`;
      if (parentCodeSignTeamID) {
        reqHeaders += `X-MCP-CodeSign: ${parentCodeSignTeamID}\r\n`;
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

async function processMessage(line: string): Promise<void> {
  let parsed: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    parsed = JSON.parse(line);
  } catch {
    log(`Invalid JSON: ${line.slice(0, 200)}`);
    return;
  }

  // Extract client identity from initialize for X-MCP-Client header
  if (parsed.method === "initialize" && parsed.params) {
    const ci = parsed.params.clientInfo as { name?: string; version?: string } | undefined;
    if (ci?.name) {
      resolvedClientName = ci.version ? `${ci.name}/${ci.version}` : ci.name;
    }
  }

  try {
    const response = await forward(line, resolvedClientName, currentToken);

    // Re-read token on 401 (token may have been rotated)
    if (!response && parsed.id !== undefined) {
      // Check if forward rejected — handled in catch below
    }

    if (response) {
      process.stdout.write(response + "\n");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Re-read token from Keychain on 401 and retry once
    if (msg.includes("HTTP 401") && !process.env.AIRMAIL_MCP_TOKEN) {
      const newToken = readTokenFromKeychain();
      if (newToken && newToken !== currentToken) {
        log("Token rotated, retrying with new token.");
        currentToken = newToken;
        try {
          const response = await forward(line, resolvedClientName, currentToken);
          if (response) { process.stdout.write(response + "\n"); }
          return;
        } catch (retryErr) {
          // Fall through to error handling
        }
      }
    }

    if (parsed.id !== undefined) {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: parsed.id,
        error: { code: -32000, message: msg },
      }) + "\n");
    } else {
      log(`Notification error: ${msg}`);
    }
  }
}

async function main() {
  if (process.platform !== "darwin") {
    log("Airmail MCP is macOS-only.");
    process.exit(1);
  }
  resolveParentCodeSign();
  if (!currentToken) {
    log("Warning: no auth token. Set AIRMAIL_MCP_TOKEN or enable MCP in Airmail Preferences.");
  }

  await ensureAirmailRunning();
  log(`Bridge ready — Airmail MCP at ${AIRMAIL_HOST}:${AIRMAIL_PORT}`);

  // Handle stdout errors (broken pipe)
  process.stdout.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "EPIPE") {
      process.exit(0);
    }
    log(`stdout error: ${err.message}`);
    process.exit(1);
  });

  // Graceful shutdown
  const shutdown = () => { process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);

  let buffer = "";
  let stdinClosed = false;
  const inflight = new Set<Promise<void>>();

  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;

    // Protect against unbounded memory growth
    if (buffer.length > MAX_STDIN_BUFFER) {
      log("stdin buffer exceeded 10 MB, dropping.");
      buffer = "";
      return;
    }

    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) {
        const p = processMessage(line).catch((err) => log(`Error: ${err}`));
        inflight.add(p);
        p.finally(() => {
          inflight.delete(p);
          if (stdinClosed && inflight.size === 0) process.exit(0);
        });
      }
    }
  });
  process.stdin.on("end", () => {
    stdinClosed = true;
    if (inflight.size === 0) { log("stdin closed, exiting."); process.exit(0); }
  });
}

main().catch((err) => { log(`Fatal: ${err}`); process.exit(1); });
