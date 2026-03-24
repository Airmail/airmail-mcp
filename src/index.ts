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
const AIRMAIL_TOKEN = process.env.AIRMAIL_MCP_TOKEN || readTokenFromKeychain();

const RETRY_DELAY_MS = 2000;
const MAX_LAUNCH_RETRIES = 5;
const REQUEST_TIMEOUT_MS = 120_000;

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

/** Check if Airmail's MCP server is reachable via TCP connect. */
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
function forward(body: string, clientName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) { settled = true; sock.destroy(); reject(new Error("Request timed out")); }
    }, REQUEST_TIMEOUT_MS);

    const sock = net.createConnection({ host: AIRMAIL_HOST, port: AIRMAIL_PORT }, () => {
      // Build raw HTTP request
      const bodyBuf = Buffer.from(body, "utf-8");
      let headers = `POST ${AIRMAIL_PATH} HTTP/1.1\r\n`;
      headers += `Host: ${AIRMAIL_HOST}:${AIRMAIL_PORT}\r\n`;
      headers += `Content-Type: application/json\r\n`;
      headers += `Content-Length: ${bodyBuf.length}\r\n`;
      headers += `Accept: application/json\r\n`;
      headers += `Connection: close\r\n`;
      if (AIRMAIL_TOKEN) {
        headers += `Authorization: Bearer ${AIRMAIL_TOKEN}\r\n`;
      }
      headers += `X-MCP-Client: ${clientName}\r\n`;
      headers += `\r\n`;

      sock.write(headers);
      sock.write(bodyBuf);
    });

    sock.on("data", (chunk) => chunks.push(chunk));

    sock.on("end", () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      const raw = Buffer.concat(chunks).toString("utf-8");
      // Parse HTTP response: find header/body boundary
      const headerEnd = raw.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        resolve(""); // No valid HTTP response
        return;
      }

      const headerPart = raw.slice(0, headerEnd);
      const responseBody = raw.slice(headerEnd + 4).trim();

      // Extract status code
      const statusMatch = headerPart.match(/^HTTP\/\d\.\d\s+(\d+)/);
      const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 0;

      if (statusCode === 202) { resolve(""); return; }
      if (statusCode >= 400) {
        reject(new Error(`Airmail HTTP ${statusCode}: ${responseBody}`));
        return;
      }
      resolve(responseBody);
    });

    sock.on("error", (err) => {
      clearTimeout(timer);
      if (settled) return;
      // Try to use any data we got
      if (chunks.length > 0) {
        settled = true;
        const raw = Buffer.concat(chunks).toString("utf-8");
        const headerEnd = raw.indexOf("\r\n\r\n");
        if (headerEnd !== -1) {
          resolve(raw.slice(headerEnd + 4).trim());
          return;
        }
      }
      settled = true;
      reject(err);
    });

    sock.on("close", () => {
      clearTimeout(timer);
      if (settled) return;
      // Connection closed — use whatever we have
      settled = true;
      if (chunks.length > 0) {
        const raw = Buffer.concat(chunks).toString("utf-8");
        const headerEnd = raw.indexOf("\r\n\r\n");
        if (headerEnd !== -1) {
          resolve(raw.slice(headerEnd + 4).trim());
          return;
        }
      }
      resolve("");
    });
  });
}

// ---------------------------------------------------------------------------
// stdio ↔ HTTP bridge
// ---------------------------------------------------------------------------

/** Client identity for X-MCP-Client header. Starts with a default,
 *  updated with the real clientInfo from the initialize message. */
let resolvedClientName: string = "airmail-mcp/1.0";

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
    const response = await forward(line, resolvedClientName);
    if (response) {
      process.stdout.write(response + "\n");
    }
  } catch (err) {
    if (parsed.id !== undefined) {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: parsed.id,
        error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
      }) + "\n");
    } else {
      log(`Notification error: ${err}`);
    }
  }
}

async function main() {
  if (process.platform !== "darwin") {
    log("Airmail MCP is macOS-only.");
    process.exit(1);
  }
  if (!AIRMAIL_TOKEN) {
    log("Warning: no auth token. Set AIRMAIL_MCP_TOKEN or enable MCP in Airmail Preferences.");
  }

  await ensureAirmailRunning();
  log(`Bridge ready — Airmail MCP at ${AIRMAIL_HOST}:${AIRMAIL_PORT}`);

  let buffer = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) processMessage(line).catch((err) => log(`Error: ${err}`));
    }
  });
  process.stdin.on("end", () => { log("stdin closed, exiting."); process.exit(0); });
}

main().catch((err) => { log(`Fatal: ${err}`); process.exit(1); });
