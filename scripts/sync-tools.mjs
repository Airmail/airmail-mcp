#!/usr/bin/env node

/**
 * Sync tool definitions from Airmail's Swift MCP source into manifest.json.
 *
 * Usage:
 *   node scripts/sync-tools.mjs [path-to-MCP-swift-dir]
 *
 * Default Swift source path: ../airmailmac/PostinoNG191/PostinoNG/SwiftCore/MCP
 *
 * Parses Tool(...) definitions from the Swift files and updates
 * the "tools" array in manifest.json. Run before `npm publish`.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// Swift source files containing tool definitions
const TOOL_FILES = [
  "AMZMCPToolRouter.swift",    // manage_capabilities
  "AMZMCPReadTools.swift",     // read + semantic tools
  "AMZMCPActionTools.swift",   // action tools
  "AMZMCPComposeTools.swift",  // compose tools
  "AMZMCPFolderTools.swift",   // folder tools
  "AMZMCPProfileTools.swift",  // profile tools
  "AMZMCPCalendarTools.swift", // calendar + reminder tools
  "AMZMCPContactTools.swift",  // contact tools
];

/**
 * Extract Tool definitions from Swift source code.
 * Matches patterns like:
 *   Tool(name: "tool_name", description: "Some description...", ...)
 * Uses word-boundary check to avoid matching e.g. `SomeTool(`.
 * String-aware paren counting to handle strings containing parens.
 */
function extractTools(source) {
  const tools = [];

  // Word-boundary: Tool( not preceded by a letter/digit/underscore
  const toolBlockRegex = /(?<![a-zA-Z0-9_])Tool\s*\(/g;
  let match;

  while ((match = toolBlockRegex.exec(source)) !== null) {
    const start = match.index;
    // Find the matching closing paren — handle nested parens and strings
    let depth = 1;
    let i = start + match[0].length;
    let inString = false;
    let stringChar = "";

    while (i < source.length && depth > 0) {
      const ch = source[i];

      // Handle string literals (skip parens inside strings)
      if (!inString) {
        if (ch === '"') {
          // Check for triple-quote """
          if (source.slice(i, i + 3) === '"""') {
            inString = true;
            stringChar = '"""';
            i += 3;
            continue;
          }
          inString = true;
          stringChar = '"';
          i++;
          continue;
        }
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
      } else {
        // Inside string — look for closing delimiter
        if (stringChar === '"""' && source.slice(i, i + 3) === '"""') {
          inString = false;
          i += 3;
          continue;
        }
        if (stringChar === '"' && ch === '"' && source[i - 1] !== "\\") {
          inString = false;
        }
      }
      i++;
    }
    const block = source.slice(start, i);

    // Skip if inside a comment (check preceding lines)
    const lineStart = source.lastIndexOf("\n", start) + 1;
    const prefix = source.slice(lineStart, start).trim();
    if (prefix.startsWith("//") || prefix.startsWith("*")) continue;

    // Extract name
    const nameMatch = block.match(/name:\s*"([^"]+)"/);
    if (!nameMatch) continue;

    // Extract description — handles both single-line "..." and multi-line """..."""
    const name = nameMatch[1];
    let description;

    // Try triple-quote first (Swift multi-line string)
    const tripleMatch = block.match(/description:\s*"""\n([\s\S]*?)"""/);
    if (tripleMatch) {
      description = tripleMatch[1]
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .join(" ")
        .replace(/\\\s*/g, " ")  // Swift line continuation backslashes
        .replace(/\s+/g, " ")
        .trim();
    } else {
      // Single-line "..."
      const singleMatch = block.match(/description:\s*"((?:[^"\\]|\\.)*)"/);
      if (!singleMatch) continue;
      description = singleMatch[1]
        .replace(/\\"/g, '"')
        .replace(/\\n/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    // Take only the first sentence for the manifest (keep it concise).
    let shortDesc = description.split(/\.\s/)[0].replace(/\.$/, "");
    if (shortDesc.length < 5) {
      shortDesc = description.length > 120 ? description.slice(0, 117) + "..." : description;
    }
    if (!shortDesc.endsWith(".")) shortDesc += ".";

    tools.push({ name, description: shortDesc });
  }

  return tools;
}

function main() {
  const swiftDir =
    process.argv[2] ||
    join(ROOT, "..", "airmailmac", "PostinoNG191", "PostinoNG", "SwiftCore", "MCP");

  if (!existsSync(swiftDir)) {
    console.error(`Swift source directory not found: ${swiftDir}`);
    console.error("Pass the path as an argument: node scripts/sync-tools.mjs /path/to/MCP");
    process.exit(1);
  }

  console.log(`Reading Swift sources from: ${swiftDir}`);

  const allTools = [];
  const seen = new Set();

  // Recursively find each tool file in swiftDir and subdirectories
  function findFile(dir, name) {
    const direct = join(dir, name);
    if (existsSync(direct)) return direct;
    try {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          const found = findFile(full, name);
          if (found) return found;
        }
      }
    } catch {}
    return null;
  }

  for (const file of TOOL_FILES) {
    const path = findFile(swiftDir, file);
    if (!path) {
      console.warn(`  SKIP ${file}: not found in ${swiftDir} (recursive)`);
      continue;
    }
    let source;
    try {
      source = readFileSync(path, "utf-8");
    } catch (err) {
      console.warn(`  SKIP ${file}: ${err.message}`);
      continue;
    }

    const tools = extractTools(source);
    for (const t of tools) {
      if (!seen.has(t.name)) {
        seen.add(t.name);
        allTools.push(t);
      }
    }
    console.log(`  ${file}: ${tools.length} tools`);
  }

  console.log(`\nTotal: ${allTools.length} tools`);

  // Update manifest.json
  const manifestPath = join(ROOT, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    console.error(`Failed to read manifest.json: ${err.message}`);
    process.exit(1);
  }

  manifest.tools = allTools;

  try {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.error(`Failed to write manifest.json: ${err.message}`);
    process.exit(1);
  }

  console.log(`Updated ${manifestPath}`);
}

main();
