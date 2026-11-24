---
name: stripe
description: Work with Stripe — customers, charges, subscriptions, products, invoices, webhooks — via the `stripe` CLI. Use whenever the task involves Stripe billing or payment data.
---

# Stripe (via the `stripe` CLI)

Use the `stripe` CLI. It authenticates via `stripe login` (check `stripe config --list`)
or the `STRIPE_API_KEY` environment variable. **Default to TEST mode** unless the task
explicitly requests live data.

## Common operations
- **List / inspect**: `stripe customers list`, `stripe charges list`,
  `stripe subscriptions list`, `stripe products list`, `stripe customers retrieve <id>`.
- **Create (test)**: `stripe customers create --email "…"`,
  `stripe products create --name "…"`.
- **Raw API** (anything not covered): `stripe get /v1/<resource>`,
  `stripe post /v1/<resource> -d key=value`.
- **Webhooks (local)**: `stripe listen --forward-to <url>`, `stripe trigger <event>`.

## Rules
- **Confirm TEST vs LIVE** (`stripe config --list`) before any write. NEVER create or
  modify live charges, subscriptions, or refunds without explicit confirmation in the task.
- Treat all monetary amounts as integer **cents** (e.g. `$10.00` → `1000`).
- Never print full API keys or customer PII beyond what the task needs.
