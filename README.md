# PhantomAuth

MCP server that fills web forms with secrets from [SecureVault](https://github.com/andriyshevchenko/SecureVault) — AI agents never see raw credentials.

## How it works

PhantomAuth sits between your AI agent and Microsoft's Playwright MCP:

```
AI Agent → PhantomAuth MCP → Playwright MCP → Browser
               ↕
          SecureVault (OS Keychain)
```

1. Agent calls `secure_fill("Microsoft Email", "#email-input")`
2. PhantomAuth resolves "Microsoft Email" from SecureVault's OS keychain
3. The raw value is forwarded directly to Playwright MCP's `browser_fill_form`
4. Agent only sees "✅ Filled — value hidden from agent"

The agent **never** sees the actual password, token, or credential.

## Prerequisites

- [SecureVault](https://github.com/andriyshevchenko/SecureVault) installed with secrets in the OS keychain
- [Playwright MCP](https://github.com/microsoft/playwright-mcp) running in HTTP mode:
  ```bash
  npx @playwright/mcp@latest --port 8931 --shared-browser-context
  ```

## Setup

Add to your MCP client configuration (e.g. VS Code `mcp.json`):

```json
{
  "mcpServers": {
    "phantomauth": {
      "command": "node",
      "args": ["C:/src/PhantomAuth/index.js"],
      "env": {
        "PLAYWRIGHT_MCP_URL": "http://localhost:8931/mcp"
      }
    }
  }
}
```

## Tools

### `secure_fill`
Fill a form field with a secret. Uses Playwright's fill (sets value directly).

```
secure_fill(secretTitle: "My Password", selector: "#password")
```

### `secure_type`
Type a secret into a field keystroke-by-keystroke. Use for React-controlled inputs.

```
secure_type(secretTitle: "TOTP Code", selector: "#otp-input", pressEnterAfter: true)
```

### `secure_authenticate`
Multi-step login flow using a SecureVault profile.

```
secure_authenticate(
  profileName: "Microsoft",
  steps: [
    { selector: "#email", envVar: "EMAIL", action: "fill" },
    { selector: "#password", envVar: "PASSWORD", action: "fill", pressEnterAfter: true, waitMs: 2000 }
  ]
)
```

### `list_vault_secrets`
List available secret names (values are never exposed).

### `list_vault_profiles`
List profiles and their env var → secret mappings.

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `PLAYWRIGHT_MCP_URL` | `http://localhost:8931/mcp` | URL of the Playwright MCP HTTP endpoint |

## License

MIT
