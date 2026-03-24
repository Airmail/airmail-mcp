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

import { readFileSync, writeFileSync } from "fs";
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
 * Handles multi-line descriptions by accumulating until we find the name+description pair.
 */
function extractTools(source) {
  const tools = [];

  // Match Tool( with name: "..." and description: "..."
  // The regex handles multi-line Tool(...) blocks
  const toolBlockRegex = /Tool\s*\(/g;
  let match;

  while ((match = toolBlockRegex.exec(source)) !== null) {
    const start = match.index;
    // Find the matching closing paren — handle nested parens
    let depth = 1;
    let i = start + match[0].length;
    while (i < source.length && depth > 0) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
      i++;
    }
    const block = source.slice(start, i);

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
    // If the first sentence is too short (e.g. description starts with special formatting),
    // fall back to the full description truncated at 120 chars.
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

  console.log(`Reading Swift sources from: ${swiftDir}`);

  const allTools = [];
  const seen = new Set();

  for (const file of TOOL_FILES) {
    const path = join(swiftDir, file);
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
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  manifest.tools = allTools;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  console.log(`Updated ${manifestPath}`);
}

main();
