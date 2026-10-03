---
name: m365-copilot
description: Use Microsoft 365 Copilot as your LLM backend via an OpenAI-compatible proxy
user-invocable: false
metadata: {"openclaw":{"requires":{"bins":["node"],"env":["M365_SECRETS_FILE"]}}}
---

# M365 Copilot Provider

This skill configures OpenClaw to use Microsoft 365 Copilot as the LLM backend through an OpenAI-compatible proxy server.

## How it works

The M365 Copilot proxy translates OpenAI-format chat completion requests into M365 Copilot WebSocket calls. It supports:

- **All M365 Copilot models**: m365-copilot, quick, think-deeper, gpt-5.4, gpt-5.3, gpt-5.2 (with quick/reasoning variants)
- **Tool calling**: Automatic translation of OpenAI tool_call format through prompt injection + fenced code block parsing
- **Agent mode**: Uses a Copilot Studio agent for server-side system prompt control
- **Streaming**: Full SSE streaming support
- **Session reuse**: Conversations share a single M365 session, saving quota (600 msg limit per conversation)
- **Delta messages**: Follow-up turns only send new messages, not the full history

## Setup

Run `m365-openclaw-setup` to configure OpenClaw. Add `--start` to also launch the proxy:

```sh
# Configure only
m365-openclaw-setup

# Configure and start proxy
m365-openclaw-setup --start

# Configure with custom port
m365-openclaw-setup --start 8080
```

## Authentication

Auth credentials are stored in `~/.config/opencode-m365/secrets.json`:
- `email`: Your M365 email address
- `password`: Your M365 password
- `mfaSecret`: Your TOTP MFA secret (base32)

The proxy handles token refresh automatically using MSAL with PKCE.
