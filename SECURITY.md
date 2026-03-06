# Security

## Reporting a Vulnerability

If you discover a security vulnerability, please email **security@tryglitch.app** (or open a private security advisory on GitHub). Do not open a public issue.

Include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We aim to respond within 48 hours and will keep you updated on progress.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Security Practices

- **API keys** — Never log or expose API keys. Config files (`~/.glitch/config.json`) should have restrictive permissions (e.g. `600`).
- **Redaction** — Capture and upload payloads are redacted for sensitive patterns (tokens, emails, credit cards) before upload.
- **HTTPS** — Use HTTPS for `cloud_url` in production.
