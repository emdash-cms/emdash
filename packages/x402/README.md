# @emdash-cms/x402

[x402](https://x402.org) payment protocol integration for Astro sites. Lets you charge for access to content using HTTP 402 — no subscriptions, no accounts, just pay-per-request with stablecoins.

Built for [EmDash](https://github.com/emdash-cms/emdash), works with any Astro project.

## Installation

```bash
npm install @emdash-cms/x402
```

## Quick Start

### 1. Add the integration

```ts
// astro.config.mjs
import { x402 } from "@emdash-cms/x402";

export default defineConfig({
	integrations: [
		x402({
			payTo: "0xYourWalletAddress",
			network: "eip155:8453", // Base mainnet
			defaultPrice: "$0.01",
			botOnly: true, // only charge bots/agents, not humans
		}),
	],
});
```

### 2. Enforce payment in a page

```astro
---
const { x402 } = Astro.locals;

const result = await x402.enforce(Astro.request, {
  price: "$0.05",
  description: "Premium article",
});

// 402 Payment Required — return it directly
if (result instanceof Response) return result;

// Payment verified — add settlement proof headers
x402.applyHeaders(result, Astro.response);
---

<article>Your premium content here</article>
```

## Configuration

| Option              | Required | Default                        | Description                                                                               |
| ------------------- | -------- | ------------------------------ | ----------------------------------------------------------------------------------------- |
| `payTo`             | Yes      | —                              | Wallet address to receive payments                                                        |
| `network`           | Yes      | —                              | [CAIP-2](https://chainagnostic.org/CAIPs/caip-2) network ID (e.g. `eip155:8453` for Base) |
| `defaultPrice`      | No       | —                              | Default price, can be overridden per-page                                                 |
| `facilitatorUrl`    | No       | `https://x402.org/facilitator` | Payment verification endpoint                                                             |
| `scheme`            | No       | `"exact"`                      | Payment scheme                                                                            |
| `maxTimeoutSeconds` | No       | `60`                           | Signature timeout                                                                         |
| `botOnly`           | No       | `false`                        | Only enforce for bots (requires Cloudflare Bot Management)                                |
| `botScoreThreshold` | No       | `30`                           | Bot score threshold (1–99). Below = bot                                                   |
| `evm`               | No       | `true`                         | Enable EVM chain support                                                                  |
| `svm`               | No       | `false`                        | Enable Solana chain support                                                               |

### Price formats

```ts
"$0.10"           // USD string ($ prefix stripped automatically)
"0.10"            // Raw amount string
0.10              // Number
{ amount: "100000", asset: "USDC" }  // Explicit asset
```

### Networks

Common CAIP-2 identifiers:

| Network                | ID             |
| ---------------------- | -------------- |
| Base                   | `eip155:8453`  |
| Ethereum               | `eip155:1`     |
| Base Sepolia (testnet) | `eip155:84532` |

## API

### `x402.enforce(request, options?)`

Checks the request for a valid payment signature. Returns a `Response` (402) if payment is missing or invalid, or an `EnforceResult` if the request should proceed.

```ts
interface EnforceResult {
	paid: boolean; // true if payment was verified
	skipped: boolean; // true if skipped (e.g. human in botOnly mode)
	payer?: string; // payer's wallet address
	responseHeaders: Record<string, string>;
}
```

### `x402.applyHeaders(result, response)`

Adds settlement proof headers to the response. Call after a successful `enforce()`.

### `x402.hasPayment(request)`

Returns `true` if the request includes a payment signature header, without verifying it. Useful for conditional rendering.

## How it works

1. Client sends a request
2. Server calls `enforce()` — no payment header? Returns **402 Payment Required** with payment instructions
3. Client (agent/browser) signs a payment and retries with a `Payment-Signature` header
4. Server verifies the payment via the facilitator, settles, and serves the content

In `botOnly` mode, step 2 is skipped for human visitors (determined by Cloudflare Bot Management score).

## License

MIT
