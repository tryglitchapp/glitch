# Glitch CLI

Command-line tool for capturing UI bugs, generating AI-ready context packs, and integrating with Cursor, Claude, and Windsurf via MCP.

**One command. No extension. No manual MCP setup.**

```bash
glitch snapshot "https://example.com"
```

Browser opens → you click elements → pack is saved → use `contextpacks://<packId>` in your AI agent.

---

## Install

```bash
# Global install (recommended)
npm install -g glitch-cli

# Or run via npx
npx glitch-cli snapshot "https://example.com"
```

**Requirements:** Node.js 18+, Chromium (installed automatically with Playwright on first run)

---

## Quick Start

1. **Capture a page** (interactive picker):

   ```bash
   glitch snapshot "https://example.com"
   ```

2. **Save locally** (default) or **upload to cloud**:

   ```bash
   glitch snapshot "https://example.com" --local
   glitch snapshot "https://example.com" --cloud   # requires api_key in config
   ```

3. **Use the pack** — after capture, you'll get:

   ```
   Resource URI: contextpacks://pack_xxxxx
   Next step: paste this URI into Cursor/Claude with the Glitch MCP server enabled.
   ```

---

## Commands

| Command | Description |
|--------|-------------|
| `glitch snapshot <url>` | Capture snapshot shorthand |
| `glitch record <url>` | Capture recorder shorthand |
| `glitch capture` | Capture page elements (snapshot or recorder mode) |
| `glitch packs list` | List cloud packs (`/v1/packs`) |
| `glitch packs show <packRef>` | Show summary metadata for one pack |
| `glitch packs pull <packRef>` | Alias for `glitch pull <packRef>` |
| `glitch pull <packId>` | Download a cloud pack bundle and unpack locally |
| `glitch prompt generate <packRef>` | Generate AI-ready prompt text |
| `glitch prompt copy <packRef>` | Copy generated prompt text to clipboard |
| `glitch workspace init [path]` | Initialize project config, register workspace, and set current (default) |
| `glitch workspace add [path] --name <name>` | Register existing project root as workspace |
| `glitch workspace list` | List saved workspaces |
| `glitch workspace use <name\|path>` | Set current workspace |
| `glitch workspace current` | Show current workspace |
| `glitch login` | Authenticate via browser handoff and store API key |
| `glitch logout` | Clear stored API key from config |
| `glitch whoami` | Show current auth/account identity |
| `glitch keys list` | List API keys for current user |
| `glitch keys create [label]` | Create a new API key (plaintext shown once) |
| `glitch keys revoke <keyId>` | Revoke an API key |
| `glitch connect <target>` | Write MCP config for `cursor`, `claude`, or `windsurf` |
| `glitch init` | Create `~/.glitch/config.json` with defaults |
| `glitch config set <key> <value>` | Update a config value |
| `glitch config get <key>` | Read a config value |
| `glitch config list` | List effective config values |
| `glitch doctor` | Run local/cloud diagnostics |
| `glitch status` | Show cloud URL, auth, and usage |
| `glitch help` | Show help |

---

## Capture Reference

```bash
glitch capture [url] [options]
```

**Required:** Provide a URL either as positional `<url>` or `--url <url>`

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--mode snapshot\|recorder` | Snapshot (one-shot) or recorder (record interactions) | `snapshot` |
| `--bug-type <type>` | `animation`, `layout-shift`, `overlap-zindex`, `color-visibility`, `overflow-clipping`, `other` | — |
| `--selector <css>` | Skip picker, capture selector directly (repeatable) | — |
| `--multi` | Allow picking multiple elements (press Enter in terminal to finish) | — |
| `--headless` | No browser window (requires `--selector`) | — |
| `--cloud` | Upload to MCP server | — |
| `--local` | Save to local directory | default |
| `--out <dir>` | Local output directory | `~/.glitch/context-packs` |
| `--prompt <text>` | Attach prompt/problem statement to pack | — |
| `--prompt-tag <alias>=<css>` | Bind prompt alias to selector (repeatable) | — |
| `--prompt-pick <alias>` | Pick a prompt alias target in browser (repeatable) | — |
| `--activate` | Attempt to add uploaded pack to Active Issues | — |
| `--no-activate` | Skip Active Issues activation | — |
| `--screenshot <path>` | Save screenshot | — |
| `--wait <mode>` | `domcontentloaded`, `load`, `networkidle` | `domcontentloaded` |
| `--no-close` | Keep browser open after capture | — |

**Examples:**

```bash
# Snapshot with picker
glitch snapshot "https://example.com"

# Recorder, multi-element, save locally
glitch record "https://example.com" --multi --local

# Headless with selectors
glitch capture "https://example.com" --selector ".card" --selector "button" --headless --cloud
```

---

## Configuration

Config file: `~/.glitch/config.json`

```json
{
  "default_destination": "local",
  "local_pack_dir": "~/.glitch/context-packs",
  "cloud_url": "https://your-mcp-server.example.com",
  "api_key": "glk_live_..."
}
```

**Config keys:**

- `default_destination` — `local` or `cloud`
- `local_pack_dir` — Directory for local packs
- `cloud_url` — MCP server URL
- `api_key` — API key for cloud uploads (`config get/list` redact it by default)

Initialize config: `glitch init`  
Set a value: `glitch config set api_key glk_live_xxx`
Get a value: `glitch config get cloud_url`  
Get the API key status: `glitch config get api_key`  
Reveal the full API key intentionally: `glitch config get api_key --show-secret`  
List all values: `glitch config list` or `glitch config list --json`

---

## Workspace

Workspace registry file: `~/.glitch/workspaces.json`

```bash
# Initialize project config + register workspace + set current (default behavior)
glitch workspace init ./my-app

# Keep project config setup but skip workspace registry changes
glitch workspace init ./my-app --no-register

# Register workspace without switching current workspace
glitch workspace init ./my-app --name my-app --no-use

# Register existing root without rewriting .glitch/project.json
glitch workspace add ./my-app --name my-app

# List and inspect current workspace
glitch workspace list
glitch workspace list --json
glitch workspace current
glitch workspace current --json

# Switch current workspace by name or path
glitch workspace use my-app
glitch workspace use ./my-app
```

---

## Pull

Download a cloud pack and unpack it locally:

```bash
glitch pull <packId> [options]
glitch packs pull <packId> [options]
```

**Options:** `--mode slim|full`, `--format dir|bundle`, `--to <path>`

---

## Packs

```bash
glitch packs list [--json] [--host <hostname>] [--source <snapshot|recorder>] [--active]
glitch packs show <packRef> [--mode slim|full] [--workspace <name|path>] [--json]
glitch packs pull <packRef> [--workspace <name|path>] [options]
```

`<packRef>` supports:
- cloud pack ID
- local pulled directory pack path
- local bundle JSON path

---

## Prompt

```bash
glitch prompt generate <packRef> [options]
glitch prompt copy <packRef> [options]
```

`generate` options:
- `--target <cursor|claude|copilot|chatgpt>`
- `--framework <auto|react|vue|angular|svelte>`
- `--style <concise|detailed>`
- `--include-code` / `--no-code`
- `--mode <slim|full>`
- `--workspace <name|path>`
- `--json` (generate only)

---

## Auth & Keys

```bash
glitch login
glitch logout
glitch whoami [--json]
glitch keys list [--json]
glitch keys create [label] [--json]
glitch keys revoke <keyId> [--yes]
```

`glitch login` starts Firebase handoff auth in your browser and stores the resulting API key in `~/.glitch/config.json`.

---

## Connect

Generate MCP configuration for your editor:

```bash
glitch connect cursor --gitignore  # Adds .cursor/ to the repo .gitignore, then writes .cursor/mcp.json
glitch connect cursor --template   # Writes a placeholder without a real key
glitch connect claude              # Prints Claude connector instructions with redacted auth output
glitch connect claude --show-token # Prints the live bearer token for manual paste
glitch connect windsurf            # Writes to Windsurf config
```

Repo-scoped Cursor config refuses to write a real API key unless `.cursor/` is already gitignored or you pass `--gitignore`.
Claude remote setup prints `Authorization: Bearer [REDACTED]` by default; use `--show-token` only when you intentionally need the live token in the terminal.

---

## Build from Source

```bash
git clone https://github.com/glitch-cli/glitch-cli.git
cd glitch-cli
npm install
npx playwright install chromium   # Browser binary for capture
npm run build
```

Then run: `node cli/dist/glitch.js help`

---

## Development

```bash
# Run tests
npm test

# Build
npm run build
```

---

## Project Structure

```
glitch-cli/
├── cli/                    # CLI entry points and capture logic
│   ├── glitch.ts           # Main entry (capture, pull, connect, init, doctor, status)
│   ├── capture.ts          # Capture workflow
│   ├── capture-inject.ts   # Browser-injected picker/capture (IIFE)
│   ├── pull.ts             # Pull command
│   ├── connect.ts          # Connect command
│   └── bundle.ts           # Bundle utilities
├── src/lib/                # Shared libraries
│   ├── capture/            # Element capture
│   ├── context-pack/       # Pack building, delta, summary
│   ├── security/           # Redaction
│   ├── analysis/           # Bug patterns
│   └── framework/          # Framework detection
├── tests/                  # Unit and integration tests
└── cli/dist/               # Built output (glitch.js, capture-inject.js)
```

---

## License

MIT
