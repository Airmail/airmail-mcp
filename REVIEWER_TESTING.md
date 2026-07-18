# Anthropic Reviewer Testing

Airmail MCP is a local macOS extension that connects Claude Desktop to Airmail's authenticated loopback MCP server. It requires macOS 13 or later, Airmail with MCP enabled, and the submitted `.mcpb` bundle.

## Request private test access

Anthropic reviewers can request temporary test credentials and sample mailbox data at `support@airmailapp.com` using the subject `[ANTHROPIC REVIEW] Airmail MCP`.

The private handoff can include:

- Temporary credentials for a dedicated mailbox containing synthetic data
- A description of the available sample messages, folders, and attachments
- Installation and activation instructions for the review build, when required
- A direct contact for setup or security questions

Credentials must not be posted in GitHub issues or committed to this repository. They should be shared through a private channel and revoked after the review.

## Suggested sample data

The dedicated mailbox should contain only synthetic data, including:

- An unread urgent request that requires a response
- A multi-message project thread
- A travel confirmation
- A newsletter or low-priority notification
- A message with a harmless sample attachment
- Archive and project folders for move and search tests

Calendar, reminder, and contact tools use the review Mac's local system stores. Reviewers should use synthetic local records and grant Airmail the corresponding macOS permissions before testing those tools.

## Core review prompts

1. "Summarize my unread inbox and highlight messages that require an urgent response."
2. "Find messages about the upcoming product launch, group them by topic, and give me links to open the relevant messages in Airmail."
3. "Find the latest email from Sarah and open a reply thanking her and proposing Tuesday at 10:00 AM. Do not send it."

The third prompt opens a populated composer for user review and does not send the message. Destructive and immediate-send tools remain subject to Airmail's MCP permission controls.

## Expected setup

1. Install and open Airmail on the review Mac.
2. Add the temporary test mailbox using the privately supplied credentials.
3. Enable the MCP server in Airmail Preferences.
4. Install the submitted `.mcpb` bundle in Claude Desktop.
5. Approve Airmail's pairing request when Claude first connects.
6. Run the core review prompts above.

For connection and authorization problems, see the troubleshooting section in [README.md](README.md#troubleshooting).
