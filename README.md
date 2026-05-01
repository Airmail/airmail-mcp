# Airmail MCP

MCP server for [Airmail](https://airmailapp.com) — manage emails, calendars, contacts, and more from AI assistants.

This is a lightweight bridge that connects AI clients to Airmail's built-in MCP server. The bridge connects locally to Airmail on your Mac. Data retrieved by AI tools is processed by your chosen AI provider.

## Requirements

- macOS 13+
- [Airmail](https://airmailapp.com) installed with MCP enabled (Preferences → MCP)
- Node.js 18+

## Installation

### Local development build

Use this when testing changes from a local checkout before publishing a new npm version.

```bash
git clone https://github.com/Airmail/airmail-mcp.git
cd airmail-mcp
npm install
npm run build
```

Then point your MCP client at the compiled local bridge. Do not commit a machine-specific path in shared docs or config examples; use your own checkout path.

**Codex CLI / Codex Desktop**:

```bash
codex mcp remove airmail
codex mcp add airmail -- node "$(pwd)/dist/index.js"
```

**Claude Desktop JSON only**:

```json
{
  "mcpServers": {
    "airmail": {
      "command": "node",
      "args": ["/absolute/path/to/airmail-mcp/dist/index.js"]
    }
  }
}
```

You can also smoke-test the local stdio bridge without installing it into a client:

```bash
printf '%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-05","capabilities":{},"clientInfo":{"name":"Airmail MCP Local Test","version":"1.0"}}}' \
'{"jsonrpc":"2.0","method":"notifications/initialized"}' \
'{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_inbox","arguments":{"limit":3}}}' \
| node dist/index.js
```

Restart the MCP client after changing its config. On first connection, Airmail shows an authorization prompt; click **Allow**.

Important: `npx -y airmail-mcp` installs the published npm package, not this local checkout. Use the local `node "$(pwd)/dist/index.js"` command until the package is published.

### GitHub development install

Use this when you want the MCP client to install from GitHub instead of a local checkout. This tests pushed GitHub code, not uncommitted local edits.

```bash
codex mcp remove airmail
codex mcp add airmail -- npx -y github:Airmail/airmail-mcp#main
```

Replace `main` with a branch name, tag, or commit SHA when testing a specific version:

```bash
codex mcp add airmail -- npx -y github:Airmail/airmail-mcp#branch-name
```

### Claude Desktop (MCPB extension)

Install from the [Claude MCP Directory](https://claude.ai/mcp) or download the latest `.mcpb` file from [Releases](https://github.com/Airmail/airmail-mcp/releases) and double-click to install.

### Claude Desktop (manual)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "airmail": {
      "command": "npx",
      "args": ["-y", "airmail-mcp"]
    }
  }
}
```

On first use, Airmail shows a pairing prompt and issues a per-client token for this bridge. By default that token stays only in bridge memory for the current session.

### Claude Code

```bash
claude mcp remove airmail && claude mcp add --transport stdio airmail -- npx -y airmail-mcp
```

### Gemini CLI

```bash
gemini mcp remove airmail && gemini mcp add airmail npx -- -y airmail-mcp
```

### Codex CLI

```bash
codex mcp remove airmail && codex mcp add airmail -- npx -y airmail-mcp
```

### Cursor

Add to `.cursor/mcp.json` in your project (or global settings):

```json
{
  "mcpServers": {
    "airmail": {
      "command": "npx",
      "args": ["-y", "airmail-mcp"]
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "airmail": {
      "command": "npx",
      "args": ["-y", "airmail-mcp"]
    }
  }
}
```

### VS Code (GitHub Copilot)

Add to `.vscode/mcp.json` in your project:

```json
{
  "servers": {
    "airmail": {
      "command": "npx",
      "args": ["-y", "airmail-mcp"]
    }
  }
}
```

## Authentication

On first use, the bridge asks Airmail to pair this MCP client. Airmail shows an authorization prompt, then returns a per-client token. By default, the bridge keeps that token only in memory for the current process.

Airmail MCP does not use a global auth token. Access is pairing-only and can be revoked per client in Airmail's MCP Permissions tab.

## Tools (98)

### Email (core)
`list_accounts` · `list_folders` · `list_messages` · `get_message` · `list_inbox` · `list_starred` · `list_sent` · `list_trash` · `list_spam` · `search_messages` · `fetch_message_body` · `list_attachments` · `get_attachment` · `get_unread_counts` · `search_contacts` · `get_draft` · `delete_draft` · `get_message_thread` · `list_windows` · `export_eml`

### Actions
`mark_messages` · `archive_messages` · `trash_messages` · `move_messages` · `copy_messages` · `snooze_messages` · `add_to_list` · `delete_messages` · `empty_folder` · `refresh_inbox` · `enable_disable_account` · `share_icloud`

### Compose
`compose_email` · `reply_to_message` · `forward_message` · `quick_reply` · `send_email` · `save_as_draft` · `list_drafts`

### Folders
`create_folder` · `rename_folder` · `delete_folder`

### Semantic Search
`semantic_search` · `semantic_index_status`

### Profile & Triage
`analyze_email_history` · `batch_triage_inbox` · `get_user_profile` · `update_user_profile` · `suggest_folder` · `get_behavior_stats`

### Calendar & Reminders
`list_calendars` · `list_events` · `get_event` · `create_event` · `update_event` · `delete_event` · `list_reminders` · `create_reminder` · `complete_reminder` · `delete_reminder`

### Contacts
`list_contacts_book` · `get_contact` · `search_contacts_book` · `create_contact` · `update_contact` · `delete_contact` · `list_contact_groups`

### VIP & Blocked Lists
`list_vips` · `add_vip` · `remove_vip` · `list_blocked` · `add_blocked` · `remove_blocked`

### Rules
`list_rules` · `get_rule` · `create_rule` · `delete_rule` · `toggle_rule`

### Signatures
`list_signatures` · `create_signature` · `update_signature` · `delete_signature`

### Smart Folders
`list_smart_folders` · `create_smart_folder` · `update_smart_folder` · `delete_smart_folder`

### Account Settings
`get_account_settings` · `update_account_settings` · `get_vacation_settings` · `set_vacation_settings`

### Aliases
`list_aliases` · `create_alias` · `update_alias` · `delete_alias`

### Preferences
`get_preferences` · `set_preferences`

### Meta
`manage_capabilities` — enable/disable tool groups to reduce context usage

## Tool groups

Tools are organized into capability groups that can be enabled or disabled at runtime via `manage_capabilities`. This reduces context usage by hiding tools you don't need.

| Group | Tools | Default |
|-------|-------|---------|
| mail | read, action, compose | Always on |
| profile | user profile & behavior | On |
| folders | folder create/rename/delete | On |
| semantic | semantic search & index | On |
| calendar | calendar & reminder | On |
| contacts | address book | On |
| preferences | app preferences read/write | On |
| rules | email rules CRUD | On |
| lists | VIP & blocked sender lists | On |
| smartfolders | smart folder CRUD | On |
| signatures | email signature CRUD | On |
| aliases | email alias CRUD | On |
| accountsettings | per-account settings & vacation | On |
To enable all groups, ask the AI to call `manage_capabilities` with `enable: ["preferences", "rules", "lists", "smartfolders", "signatures", "aliases", "accountsettings"]`.

## Deep links

MCP tool responses include `airmail://` deep links that open Airmail directly to the relevant content.

| Command | URL | Description |
|---------|-----|-------------|
| `message` | `airmail://message?mail=...&messageid=...` | Select message in main window |
| `open` | `airmail://open?mail=...&messageid=...` | Open message in reader window |
| `compose` | `airmail://compose?to=...&subject=...` | Open composer with pre-filled content |
| `reply` | `airmail://reply?mail=...&messageid=...` | Reply to a message |
| `draft` | `airmail://draft?mail=...&messageid=...` | Open draft in composer |
| `archive` | `airmail://archive?mail=...&messageid=...` | Archive a message |
| `delete` | `airmail://delete?mail=...&messageid=...` | Move message to trash |
| `view` | `airmail://view?mail=...&folder=...` | Navigate to account/folder |
| `attachment` | `airmail://attachment?mail=...&messageid=...&index=0` | Open an attachment |
| `settings` | `airmail://settings?pref=mcp_server` | Open Preferences pane |

## How it works

```
AI Client ←stdio→ airmail-mcp (Node.js) ←HTTP→ Airmail.app (localhost:9876)
```

This package is a thin transport bridge. All tool logic runs inside Airmail's native Swift MCP server. The bridge:

1. Reads JSON-RPC messages from stdin
2. Forwards them via HTTP POST to Airmail's local MCP server
3. Writes responses back to stdout

If Airmail is not running, the bridge will attempt to launch it automatically.

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AIRMAIL_MCP_REMEMBER_CLIENT_TOKEN` | Set to `1` to persist the bridge's per-client token in Keychain service `com.airmail.mcp.client`. | — |
| `AIRMAIL_MCP_PORT` | MCP server port | `9876` |

## Development

```bash
git clone https://github.com/Airmail/airmail-mcp.git
cd airmail-mcp
npm install
npm run build
```

### Sync tools from Airmail source

```bash
npm run sync-tools          # reads Swift source, updates manifest.json
```

### Build .mcpb extension

```bash
npx @anthropic-ai/mcpb pack .
```

## License

MIT
