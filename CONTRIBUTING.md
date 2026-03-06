# Contributing to Glitch CLI

Thanks for your interest in contributing. This guide covers development setup, workflow, and how to submit changes.

## Table of Contents

1. [Getting Started](#getting-started)
2. [Development Setup](#development-setup)
3. [Project Structure](#project-structure)
4. [Development Workflow](#development-workflow)
5. [Testing](#testing)
6. [Pull Request Process](#pull-request-process)
7. [Code Style](#code-style)

---

## Getting Started

### Ways to Contribute

- **Bug reports** — Report issues on GitHub
- **Feature requests** — Open an issue with your idea
- **Documentation** — Improve README, CONTRIBUTING, or add usage docs
- **Code** — Fix bugs or implement features
- **Tests** — Add or improve tests

### Before You Start

1. Check [existing issues](https://github.com/glitch-cli/glitch-cli/issues)
2. For larger changes, open an issue first to discuss

---

## Development Setup

### Prerequisites

- Node.js 18+
- npm 9+
- Git

### Initial Setup

```bash
git clone https://github.com/glitch-cli/glitch-cli.git
cd glitch-cli
npm install
npx playwright install chromium   # Required for capture command
npm run build
```

### Verify Installation

```bash
node cli/dist/glitch.js help
node cli/dist/glitch.js doctor --json
```

---

## Project Structure

```
glitch-cli/
├── cli/                    # CLI source
│   ├── glitch.ts           # Main entry, command dispatch
│   ├── capture.ts          # Capture workflow
│   ├── capture-inject.ts   # Browser-injected script (built to cli/dist/)
│   ├── pull.ts             # Pull command
│   ├── connect.ts          # Connect command
│   └── bundle.ts           # Bundle utilities
├── src/lib/                # Shared libraries
│   ├── capture/            # Element capture (styles)
│   ├── context-pack/       # Pack building, delta, summary, upload schema
│   ├── security/           # Redaction (client-side)
│   ├── analysis/           # Bug patterns
│   └── framework/          # Framework detection
├── src/types/              # Type definitions
├── tests/
│   ├── unit/               # Unit tests
│   └── integration/        # Integration tests
└── cli/dist/               # Built artifacts (gitignored)
```

---

## Development Workflow

### Branching

- `main` — Stable releases
- `develop` — Active development (optional)
- `feature/name` — Feature branches

### Making Changes

```bash
git checkout -b feature/your-feature
# Make changes
npm run build
npm test
```

### Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat: add something` — New feature
- `fix: resolve capture bug` — Bug fix
- `docs: update README` — Documentation
- `test: add pull tests` — Tests
- `chore: bump deps` — Maintenance

---

## Testing

```bash
# Run all tests
npm test

# Run specific test file
npm test -- tests/unit/cli-bundle.test.ts
```

Tests use Vitest. Add unit tests for new CLI logic and integration tests for pack flows.

---

## Pull Request Process

### Before Submitting

1. Run `npm run build` — must succeed
2. Run `npm test` — all tests must pass
3. Test manually: `node cli/dist/glitch.js capture --url "https://example.com" --selector "body" --headless`
4. Update docs if you changed behavior or added options

### PR Checklist

- [ ] Tests added/updated as needed
- [ ] Build succeeds
- [ ] Manual smoke test done
- [ ] Documentation updated if applicable

### After Merge

Your changes will ship in the next release. Thank you!

---

## Code Style

- TypeScript with strict mode
- Prefer `const` over `let`
- Use explicit types for function parameters and return values
- Keep functions focused; extract helpers when logic grows

---

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
