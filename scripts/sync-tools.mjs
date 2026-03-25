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

/**
 * Discover all Swift tool files dynamically.
 * Matches AMZMCPToolRouter.swift and any AMZMCP*Tools.swift files.
 */
function discoverToolFiles(dir) {
  const files = [];
  function walk(d) {
    try {
      for (const entry of readdirSync(d)) {
        const full = join(d, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (
          entry === "AMZMCPToolRouter.swift" ||
          (entry.startsWith("AMZMCP") && entry.endsWith("Tools.swift"))
        ) {
          files.push({ name: entry, path: full });
        }
      }
    } catch (err) {
      console.warn(`  Warning: could not read ${d}: ${err.message}`);
    }
  }
  walk(dir);
  // Sort: ToolRouter first, then alphabetical
  files.sort((a, b) => {
    if (a.name === "AMZMCPToolRouter.swift") return -1;
    if (b.name === "AMZMCPToolRouter.swift") return 1;
    return a.name.localeCompare(b.name);
  });
  return files;
}

/**
 * Strip block comments from Swift source to avoid extracting Tool() from comments.
 * Preserves string literals (does not strip inside strings).
 */
function stripBlockComments(source) {
  let result = "";
  let i = 0;
  let inString = false;
  let stringKind = ""; // '"' or '"""'

  while (i < source.length) {
    // Handle string literals
    if (!inString) {
      if (source.slice(i, i + 3) === '"""') {
        inString = true;
        stringKind = '"""';
        result += '"""';
        i += 3;
        continue;
      }
      if (source[i] === '"') {
        inString = true;
        stringKind = '"';
        result += '"';
        i++;
        continue;
      }
      // Block comment start
      if (source[i] === '/' && source[i + 1] === '*') {
        // Find matching end, handling nested block comments
        let depth = 1;
        i += 2;
        while (i < source.length && depth > 0) {
          if (source[i] === '/' && source[i + 1] === '*') { depth++; i += 2; }
          else if (source[i] === '*' && source[i + 1] === '/') { depth--; i += 2; }
          else { i++; }
        }
        result += " "; // Replace comment with space to preserve token separation
        continue;
      }
      result += source[i];
    } else {
      // Inside string — look for closing delimiter
      if (stringKind === '"""' && source.slice(i, i + 3) === '"""') {
        inString = false;
        result += '"""';
        i += 3;
        continue;
      }
      if (stringKind === '"' && source[i] === '"') {
        // Check for escaped quote — count consecutive preceding backslashes
        let bs = 0;
        let j = i - 1;
        while (j >= 0 && source[j] === '\\') { bs++; j--; }
        if (bs % 2 === 0) {
          inString = false;
        }
      }
      result += source[i];
    }
    i++;
  }
  return result;
}

/**
 * Extract Tool definitions from Swift source code.
 * Matches patterns like:
 *   Tool(name: "tool_name", description: "Some description...", ...)
 * Uses word-boundary check to avoid matching e.g. `SomeTool(`.
 * String-aware paren counting to handle strings containing parens.
 *
 * NOTE: Swift string interpolation \(expr) inside tool descriptions is not
 * handled — parens in \() would break depth counting. Current Swift sources
 * do not use interpolation in Tool() definitions.
 */
function extractTools(source) {
  // Strip block comments before extraction
  source = stripBlockComments(source);

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
        if (stringChar === '"' && ch === '"') {
          // Count consecutive preceding backslashes — escaped only if odd count
          let bs = 0;
          let j = i - 1;
          while (j >= 0 && source[j] === '\\') { bs++; j--; }
          if (bs % 2 === 0) {
            inString = false;
          }
        }
      }
      i++;
    }
    const block = source.slice(start, i);

    // Skip if on a line-commented line (// ...)
    const lineStart = source.lastIndexOf("\n", start) + 1;
    const prefix = source.slice(lineStart, start).trim();
    if (prefix.startsWith("//")) continue;

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
        .replace(/\\\n\s*/g, " ")  // Swift line continuation backslashes (\ at end of line)
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

  const toolFiles = discoverToolFiles(swiftDir);

  for (const { name: file, path } of toolFiles) {
    let source;
    try {
      source = readFileSync(path, "utf-8");
    } catch (err) {
      console.warn(`  SKIP ${file}: ${err.message}`);
      continue;
    }

    const tools = extractTools(source);
    for (const t of tools) {
      if (seen.has(t.name)) {
        console.warn(`  DUPLICATE: ${t.name} already seen, skipping`);
      } else {
        seen.add(t.name);
        allTools.push(t);
      }
    }
    console.log(`  ${file}: ${tools.length} tools`);
  }

  console.log(`\nTotal: ${allTools.length} tools`);

  // Guard against empty tool list — would produce a broken publish
  if (allTools.length === 0) {
    console.error("No tools extracted — aborting to prevent empty manifest.");
    process.exit(1);
  }

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
