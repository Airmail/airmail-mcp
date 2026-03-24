# Airmail MCP

MCP server for [Airmail](https://airmailapp.com) — manage emails, calendars, contacts, and more from Claude.

This is a lightweight bridge that connects Claude Desktop and Claude Code to Airmail's built-in MCP server. All operations run locally on your Mac — your data never leaves your machine.

## Requirements

- macOS 13+
- [Airmail](https://airmailapp.com) installed with MCP enabled (Preferences → MCP)
- Node.js 18+

## Installation

### Claude Desktop (MCPB extension)

Download the latest `.mcpb` file from [Releases](https://github.com/Airmail/airmail-mcp/releases) and double-click to install. Claude Desktop will prompt for your auth token (found in Airmail Preferences → MCP).

### Claude Desktop (manual)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

Set the token as environment variable:

```bash
export AIRMAIL_MCP_TOKEN="your-token-here"
```

## Getting your auth token

1. Open Airmail
2. Go to **Preferences → MCP**
3. Copy the **Auth Token** shown in the settings

## Tools (63)

### Email (core)
`list_accounts` · `list_folders` · `list_messages` · `get_message` · `list_inbox` · `list_starred` · `list_sent` · `list_trash` · `list_spam` · `search_messages` · `fetch_message_body` · `list_attachments` · `get_attachment` · `get_unread_counts` · `search_contacts` · `get_draft` · `delete_draft` · `get_message_thread` · `list_windows` · `export_eml` · `list_drafts`

### Actions
`mark_messages` · `archive_messages` · `trash_messages` · `move_messages` · `copy_messages` · `snooze_messages` · `add_to_list` · `delete_messages` · `empty_folder` · `refresh_inbox`

### Compose
`compose_email` · `reply_to_message` · `forward_message` · `quick_reply`

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
| `AIRMAIL_MCP_TOKEN` | Auth token (required) | — |
| `AIRMAIL_MCP_PORT` | MCP server port | `9876` |

## Development

```bash
git clone https://github.com/Airmail/airmail-mcp.git
cd airmail-mcp
npm install
npm run build
```

## License

MIT
