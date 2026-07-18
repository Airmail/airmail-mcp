# Security Policy

## Supported versions

Security fixes are applied to the latest published Airmail MCP release and the current supported version of Airmail for macOS.

## Reporting a vulnerability

Please report suspected vulnerabilities privately by emailing `support@airmailapp.com` with the subject `[SECURITY] Airmail MCP`.

Include, when available:

- The affected Airmail and Airmail MCP versions
- Your macOS and Claude Desktop versions
- Reproduction steps or a minimal proof of concept
- The expected and observed behavior
- The potential security or privacy impact

Do not open a public GitHub issue for an unpatched vulnerability. Do not send mailbox contents, credentials, pairing tokens, or other personal data. Redact sensitive values from logs and screenshots.

We will acknowledge the report, investigate it with reasonable care, and coordinate disclosure and remediation with the reporter when appropriate.

## Data and authentication

The bridge communicates with Airmail over the IPv4 loopback interface. Airmail displays a pairing request before granting access, and each client authorization can be revoked from Airmail's MCP Permissions tab. Optional persistent client tokens are stored in the macOS Keychain.

See the [Airmail Privacy Policy](https://airmailapp.com/privacy) for information about data handling.
