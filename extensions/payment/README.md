# Payment

Agent-driven purchases for OpenClaw. Issue single-use virtual cards via Stripe Link, fill checkout forms in a browser without the agent ever seeing real card data, and pay HTTP 402 endpoints over the Machine Payments Protocol — all behind explicit, severity-graded approvals.

## Overview

The `payment` plugin gives an OpenClaw agent two safe paths to spend money on a user's behalf:

- **Virtual card checkout** — the plugin asks Stripe Link to mint a single-use card, the user approves on their phone, and the agent fills the merchant's checkout form using opaque `sentinel` placeholders. A runtime hook substitutes the real card values into the browser at fill time. The agent never sees the PAN, CVV, or full billing details — they're not in its transcript, parameters, or state.
- **Machine Payment** — the plugin executes a payment directly against an HTTP 402 endpoint that advertises the [Machine Payments Protocol](https://machinepayments.dev/). No browser. No card form. Useful for paid APIs, crawl quotas, or any per-call billing surface.

Every spend is gated by an OpenClaw approval (`warning` for issuing a card, `critical` for fill-time substitution and machine payments). Outgoing transcripts are scrubbed by a `before_message_write` hook that redacts Luhn-valid PANs, CVV-context strings, and MPP authorization tokens regardless of which key they appear under.

## Install

```bash
clawhub package install @pejmanjohn/openclaw-payment
```

Then enable in your OpenClaw config:

```json
{
  "plugins": {
    "entries": {
      "payment": {
        "enabled": true,
        "provider": "stripe-link"
      }
    }
  }
}
```

## Prerequisites

The `stripe-link` provider requires the [Stripe Link CLI](https://github.com/stripe/link-cli) on your `PATH`:

```bash
npm install -g @stripe/link-cli
```

- Minimum required version: `0.4.0`
- `link-cli` must be resolvable as that exact name on `PATH` — the plugin invokes it via `execFile("link-cli", […])`
- A Link account with at least one saved payment method
- The Stripe Link mobile app on your phone (for biometric approval)

The `mock` provider has no external dependencies and is suitable for tests, CI, and demos.

## Tools

The plugin contributes a single tool, `payment`, with five actions:

| Action                    | Severity | What it does                                                                                                                                                                                        |
| ------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup_status`            | none     | Reports whether the configured provider is ready to spend (CLI installed, account linked, etc.). Always call this first.                                                                            |
| `list_funding_sources`    | none     | Lists the user's available funding sources and their supported rails (`virtual_card`, `machine_payment`).                                                                                           |
| `issue_virtual_card`      | warning  | Mints a single-use card with a per-card `maxAmountCents` cap. Returns a `handle` and a `fillSentinels` map the agent uses with `browser.act fill`. Requires biometric approval on the user's phone. |
| `redeem_handle`           | none     | Reads non-secret status (`active`, `expired`, `denied`) for a handle. Use this after fill to confirm the card was used or to detect 3DS / approval timeouts.                                        |
| `execute_machine_payment` | critical | Calls a remote HTTP 402 endpoint with an MPP authorization. No browser. The agent must include a clear `purchaseIntent` describing what is being purchased and why.                                 |

The runtime sentinel-fill substitution (which fires when the agent calls `browser.act fill` with a sentinel value) is itself a **critical** approval gate — the user sees the merchant URL, the field set, and the card display info before the real values are typed.

## Action Groups

| Group           | Actions                                | Notes                                                                                         |
| --------------- | -------------------------------------- | --------------------------------------------------------------------------------------------- |
| Discovery       | `setup_status`, `list_funding_sources` | Read-only; no approval required.                                                              |
| Virtual card    | `issue_virtual_card`, `redeem_handle`  | Card issuance gates on user biometric approval; fill substitution gates on critical approval. |
| Machine payment | `execute_machine_payment`              | One-shot HTTP 402 spend with critical approval.                                               |

## Quick start (virtual card checkout)

```jsonc
// 1. Verify the provider is ready
{ "action": "setup_status" }

// 2. Pick a funding source
{ "action": "list_funding_sources" }

// 3. Issue a single-use card (warning approval + biometric)
{
  "action": "issue_virtual_card",
  "providerId": "stripe-link",
  "fundingSourceId": "fs_...",
  "amount": { "amountCents": 2999, "currency": "usd" },
  "merchant": { "name": "Example Store", "url": "https://example.com" },
  "purchaseIntent": "Blue widget (SKU W-123) for $29.99 — home office order placed 2026-04-30"
}
// → returns { handle, fillSentinels: { pan, cvv, exp_month, exp_year, exp_mm_yy, holder_name, billing_line1, ... } }

// 4. Fill the merchant's checkout form using sentinel objects (critical approval at fill time)
{
  "action": "act",
  "request": {
    "kind": "fill",
    "fields": [
      { "ref": "input[name=cardnumber]", "type": "text", "value": { "$paymentHandle": "<handle-id>", "field": "pan" } },
      { "ref": "input[name=exp-date]",   "type": "text", "value": { "$paymentHandle": "<handle-id>", "field": "exp_mm_yy" } },
      { "ref": "input[name=cvc]",        "type": "text", "value": { "$paymentHandle": "<handle-id>", "field": "cvv" } }
    ]
  }
}
```

The agent never sees real card values — substitution happens at the OpenClaw runtime boundary, after the user approves the fill prompt.

## Quick start (machine payment)

```jsonc
{
  "action": "execute_machine_payment",
  "providerId": "stripe-link",
  "fundingSourceId": "fs_...",
  "endpoint": "https://api.example.com/v1/premium/generate",
  "amount": { "amountCents": 500, "currency": "usd" },
  "purchaseIntent": "Generate a high-resolution variant of the user's uploaded image.",
}
```

## Sentinel reference

`fillSentinels` exposes:

- **Card fields** — `pan`, `cvv`, `exp_month`, `exp_year`, `exp_mm_yy`, `exp_mm_yyyy`, `holder_name`
- **Billing address** — `billing_line1`, `billing_line2`, `billing_city`, `billing_state`, `billing_postal_code`, `billing_country`
- **Forward-compat extras** — string-typed top-level fields surfaced by the provider (e.g. `email`, `phone`) become available automatically as new fields ship in `link-cli`. Object-typed fields are never passed through.

Use `exp_mm_yy` / `exp_mm_yyyy` for forms with a single combined expiry input (Stripe Elements, modern checkouts). Use `exp_month` + `exp_year` for split forms.

## Security model

- **Sentinels never carry secrets.** A sentinel is `{ "$paymentHandle": "<id>", "field": "<name>" }`. Real card data is fetched from `link-cli` immediately before fill and zeroized from process memory immediately after.
- **Single retrieval site.** Only one place in the plugin calls `link-cli retrieveCardSecrets` — easy to audit, never reachable from agent input.
- **Outbound redaction.** A `before_message_write` hook scans every assistant message and tool argument for Luhn-valid PANs, CVV-context strings, and MPP authorization tokens. Matches block the message rather than redacting silently.
- **Approval gates.** Issuing a card surfaces a `warning`-level OpenClaw approval; sentinel substitution surfaces a `critical`-level approval; machine payments surface a `critical`-level approval. None of these can be bypassed by agent input.
- **No shell.** The runner uses `execFile("link-cli", […])` with array args and no shell. There is no path from agent state to arbitrary command execution.

## Configuration

```json
{
  "enabled": true,
  "provider": "stripe-link",
  "defaultCurrency": "usd",
  "store": "~/.openclaw/payments",
  "providers": {
    "stripe-link": {
      "clientName": "OpenClaw",
      "testMode": false,
      "maxAmountCents": 50000
    }
  }
}
```

| Field                                     | Default                | Notes                                                                            |
| ----------------------------------------- | ---------------------- | -------------------------------------------------------------------------------- |
| `provider`                                | —                      | `"stripe-link"` or `"mock"`. Required.                                           |
| `defaultCurrency`                         | `"usd"`                | Used when an action omits `currency`.                                            |
| `store`                                   | `~/.openclaw/payments` | Where issued-handle metadata is persisted.                                       |
| `providers["stripe-link"].clientName`     | `"OpenClaw"`           | Shown in the Link approval prompt.                                               |
| `providers["stripe-link"].testMode`       | `false`                | Use Link's `--test` flag. Cards always show holder "Jane Doe" in test mode.      |
| `providers["stripe-link"].maxAmountCents` | `50000`                | Hard upper bound per card; Stripe Link's own ceiling is also 50000 (= $500 USD). |

## Ideas to try

- "Buy this domain on Namecheap if it's under $30" — checkout flow with a virtual card
- "Pay $0.05 to call this paid API and summarize the result" — `execute_machine_payment` against an HTTP 402 endpoint
- "Subscribe to my Substack of choice if the annual price is under $80" — checkout flow with billing-address fill

## License

MIT
