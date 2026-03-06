# Glitch CLI

Command-line tool for capturing UI bugs, generating AI-ready context packs, and integrating with Cursor, Claude, and Windsurf via MCP.

**One command. No extension. No manual MCP setup.**

```bash
glitch capture --url "https://example.com"
```

Browser opens → you click elements → pack is saved → use `contextpacks://<packId>` in your AI agent.

---

## Install

```bash
# Global install (recommended)
npm install -g glitch-cli

# Or run via npx
npx glitch-cli capture --url "https://example.com"
```

**Requirements:** Node.js 18+, Chromium (installed automatically with Playwright on first run)

---

## Quick Start

1. **Capture a page** (interactive picker):

   ```bash
   glitch capture --url "https://example.com"
   ```

2. **Save locally** (default) or **upload to cloud**:

   ```bash
   glitch capture --url "https://example.com" --local
   glitch capture --url "https://example.com" --cloud   # requires api_key in config
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
| `glitch capture` | Capture page elements (snapshot or recorder mode) |
| `glitch pull <packId>` | Download a cloud pack bundle and unpack locally |
| `glitch connect <target>` | Write MCP config for `cursor`, `claude`, or `windsurf` |
| `glitch init` | Create `~/.glitch/config.json` with defaults |
| `glitch config set <key> <value>` | Update a config value |
| `glitch doctor` | Run local/cloud diagnostics |
| `glitch status` | Show cloud URL, auth, and usage |
| `glitch help` | Show help |

---

## Capture Reference

```bash
glitch capture --url "<url>" [options]
```

**Required:** `--url` — Page URL to capture

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
| `--screenshot <path>` | Save screenshot | — |
| `--wait <mode>` | `domcontentloaded`, `load`, `networkidle` | `domcontentloaded` |
| `--no-close` | Keep browser open after capture | — |

**Examples:**

```bash
# Snapshot with picker
glitch capture --url "https://example.com"

# Recorder, multi-element, save locally
glitch capture --url "https://example.com" --mode recorder --multi --local

# Headless with selectors
glitch capture --url "https://example.com" --selector ".card" --selector "button" --headless --cloud
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
- `api_key` — API key for cloud uploads

Initialize config: `glitch init`  
Set a value: `glitch config set api_key glk_live_xxx`

---

## Pull

Download a cloud pack and unpack it locally:

```bash
glitch pull <packId> [options]
```

**Options:** `--mode slim|full`, `--format dir|bundle`, `--to <path>`

---

## Connect

Generate MCP configuration for your editor:

```bash
glitch connect cursor    # Writes to .cursor/mcp.json
glitch connect claude    # Writes to Claude desktop config
glitch connect windsurf  # Writes to Windsurf config
```

Requires `api_key` in config (or use `--template` to write a placeholder).

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
