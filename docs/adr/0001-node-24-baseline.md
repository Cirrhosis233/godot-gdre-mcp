# ADR 0001: Node.js 24 baseline

- Status: accepted
- Date: 2026-10-19
- Supersedes: the Node baseline sentence in `docs/operation-contract.md` §9.1 as accepted on 2026-10-18.

## Context

The preceding contract supported Node `^22.16.0 || ^24.0.0`. The SDK 2.3.1 requires Node >= 20, so the existing SDK baseline is compatible with Node 24. Supporting two runtime lines adds verification surface without a product requirement; one supported LTS line simplifies verification.

## Decision

The product supports **Node 24.x LTS only** on Windows x64:

- `package.json` declares `engines.node: "^24.0.0"`.
- `@types/node` follows the Node 24 type line.
- README, contract §9.1, and delivery records no longer claim Node 22 support.
- No Node 24-only API is adopted merely because the baseline allows it; APIs are chosen by concrete need.

## Consequences

- Node 22 users must upgrade to Node 24 before running the server.
- Verification runs on Node 24 (`npm ci`, `npm run check`).
- The pinned SDK, Zod, and TypeScript setup are unchanged; this ADR does not authorize a dependency-line upgrade.
