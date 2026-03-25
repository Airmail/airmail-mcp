# Airmail MCP

MCP server for [Airmail](https://airmailapp.com) — manage emails, calendars, contacts, and more from Claude.

This is a lightweight bridge that connects Claude Desktop and Claude Code to Airmail's built-in MCP server. All operations run locally on your Mac — your data never leaves your machine.

## Requirements

- macOS 13+
- [Airmail](https://airmailapp.com) installed with MCP enabled (Preferences → MCP)
- Node.js 18+

## Installation

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

The auth token is read automatically from the macOS Keychain. If you set `AIRMAIL_MCP_TOKEN`, the Keychain is not accessed:

```json
{
  "mcpServers": {
    "airmail": {
      "command": "npx",
      "args": ["-y", "airmail-mcp"],
      "env": {
        "AIRMAIL_MCP_TOKEN": "your-token-here"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add --transport stdio airmail -- npx -y airmail-mcp
```

## Authentication

The bridge reads the auth token automatically from the macOS Keychain — no configuration needed. When macOS prompts for Keychain access, click **Always Allow** so it won't ask again.

If you set `AIRMAIL_MCP_TOKEN`, the Keychain is skipped entirely:

```bash
export AIRMAIL_MCP_TOKEN="your-token-here"
```

To find your token: open Airmail → **Preferences → MCP** → copy the **Auth Token**.

## Tools (89)

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

### Preferences
`get_preferences` · `set_preferences`

### Meta
`manage_capabilities` — enable/disable tool groups to reduce context usage

## How it works

```
Claude ←stdio→ airmail-mcp (Node.js) ←HTTP→ Airmail.app (localhost:9876)
```

This package is a thin transport bridge. All tool logic runs inside Airmail's native Swift MCP server. The bridge:

1. Reads JSON-RPC messages from stdin
2. Forwards them via HTTP POST to Airmail's local MCP server
3. Writes responses back to stdout

If Airmail is not running, the bridge will attempt to launch it automatically.

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AIRMAIL_MCP_TOKEN` | Auth token (optional — automatically read from macOS Keychain if not set) | — |
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
