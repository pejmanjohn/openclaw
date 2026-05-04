# Payment plugin

OpenClaw plugin for agent-driven purchases via virtual card (Stripe Link) and machine payment (MPP/HTTP 402), with approval gating and sentinel-based card fill.

**User docs:** `docs/plugins/payment.md`

**Developer notes:** `DEV_NOTES.md`

## Prerequisites

The `stripe-link` provider requires the Stripe Link CLI **on your `PATH`**:

```bash
npm install -g @stripe/link-cli
```

- Minimum required version: `0.4.0`
- `link-cli` must be resolvable on `PATH` — the plugin calls it by that name directly.
- A Link account with at least one saved payment method
- The Link mobile app on your phone (for biometric approval)

The `mock` provider has no external dependencies and is suitable for testing and CI.

## Build / test

```bash
# From the worktree root:
pnpm test extensions/payment

# From this directory:
pnpm plugin:check
```

## License

MIT
