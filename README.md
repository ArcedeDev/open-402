<p align="center">
  <h1 align="center">Open 402 Directory</h1>
  <p align="center">
    The open registry of paid APIs using HTTP 402 payment protocols.
    <br />
    <a href="https://open402.directory"><strong>Browse the directory &rarr;</strong></a>
    <br />
    <br />
    <a href="#add-your-api">Add your API</a>
    &middot;
    <a href="#fork-this-registry">Fork the registry</a>
    &middot;
    <a href="https://agentinternetruntime.com/spec/agent-json">agent.json spec</a>
  </p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FFransDevelopment%2Fopen-402-directory%2Fmain%2Fregistry%2Fsnapshot.json&query=%24.total&label=domains&color=blue" alt="Domains indexed" />
  <img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FFransDevelopment%2Fopen-402-directory%2Fmain%2Fregistry%2Fsnapshot.json&query=%24.verified&label=verified&color=green" alt="Verified" />
  <img src="https://img.shields.io/badge/protocols-x402%20%C2%B7%20L402%20%C2%B7%20MPP-orange" alt="Protocols" />
  <img src="https://img.shields.io/badge/license-MIT-lightgrey" alt="License" />
</p>

---

## What is this?

This is the **canonical, open-source registry** of domains that accept payments via HTTP 402. Think of it as a phone book for the paid API economy.

The data here powers the [Open 402 Directory](https://open402.directory) at `open402.directory`, but anyone can fork this registry and build their own directory, search engine, monitoring tool, or agent discovery service on top of it.

**Decentralized design principles:**

- **Provider-authoritative** — The source of truth is the `agent.json` file on each provider's domain, not this repo. We just index who has one, so it's completely decentralized and anyone who has a website can add their API to the directory.
- **Protocol-agnostic** — x402, L402, MPP, and any future 402 protocol are treated equally.
- **Zero lock-in** — No accounts, no tokens, no API keys required to list or use.
- **Forkable** — `git clone` and you have the entire registry. Build whatever you want.

## Registry structure

```
registry/
├── domains.txt       # Canonical list of known domains (one per line)
└── snapshot.json     # Cached metadata — auto-generated from agent.json crawls
```

### `domains.txt`

The single source of truth. One domain per line:

```
domain | status | source | added_date
```

| Field | Values | Description |
|-------|--------|-------------|
| `domain` | `api.example.com` | The API's domain |
| `status` | `verified` · `unclaimed` | Whether the domain hosts an `agent.json` |
| `source` | `self` · `submit` · `402index` · `onchain-x402` | How the domain was discovered |
| `added_date` | `2026-03-23` | When it was first added to the registry |

**Verified** means the domain hosts `/.well-known/agent.json` — a machine-readable manifest declaring the API's capabilities, pricing, and payment protocols.

**Unclaimed** means the domain is known to process 402 payments (observed on-chain or via other indexes) but hasn't published an `agent.json` yet.

### `snapshot.json`

A nightly-rebuilt cache of metadata for every domain. Contains display names, descriptions, endpoint counts, pricing, and protocol info. Parsed from each domain's live `agent.json`.

You can read this file directly for structured data without crawling individual domains yourself.

---

## Add your API

### Step 1: Create your `agent.json`

The `agent.json` file tells agents what your API does, what it costs, and how to pay. Here's a minimal example:

```json
{
  "version": "1.3",
  "origin": "api.yourcompany.com",
  "display_name": "Your API Name",
  "description": "What your API does in one sentence.",
  "payout_address": "0xYOUR_WALLET_ADDRESS",
  "payments": {
    "x402": {
      "networks": [
        {
          "network": "base",
          "asset": "USDC",
          "contract": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
        }
      ]
    }
  },
  "intents": [
    {
      "name": "get_data",
      "description": "Returns structured data for the given query.",
      "endpoint": "/api/v1/data",
      "method": "GET",
      "price": { "amount": 0.01, "currency": "USDC" }
    }
  ]
}
```

The `payments` object declares which protocols you support. Keys are lowercase. Add as many as you want:

```json
"payments": {
  "x402": { "networks": [{ "network": "base", "asset": "USDC", "contract": "0x..." }] },
  "l402": { "lightning_address": "you@yourservice.com" },
  "mpp":  { "stripe_account": "acct_..." }
}
```

> **Note:** Protocol keys in JSON are lowercase (`x402`, `l402`, `mpp`). The directory displays them as uppercase (X402, L402, MPP) in the UI.

**Need help?** Use the interactive [agent.json Generator](https://agentinternetruntime.com/spec/agent-json/generator) — it walks you through every field and outputs a valid file.

### Step 2: Host it

Place the file at:

```
https://yourdomain.com/.well-known/agent.json
```

Make sure it's:
- Served with `Content-Type: application/json`
- Accessible over HTTPS (no auth required)
- At the exact path `/.well-known/agent.json`

Most web frameworks make this straightforward:

| Framework | Where to put it |
|-----------|----------------|
| **Next.js** | `public/.well-known/agent.json` |
| **Express** | `app.use('/.well-known', express.static('well-known'))` |
| **Nginx** | Place in your web root at `.well-known/agent.json` |
| **Vercel** | `public/.well-known/agent.json` |
| **Cloudflare Workers** | Return JSON from a route handler at `/.well-known/agent.json` |
| **Static site** | Place the file in your site's root `.well-known/` directory |

### Step 3: Get listed

**Option A: Submit via the directory** (instant)

Go to [open402.directory](https://open402.directory), enter your domain, and hit submit. We crawl it immediately.

**Option B: Open a pull request**

Add your domain to `registry/domains.txt`:

```
yourdomain.com | verified | submit | 2026-03-23
```

**Option C: Wait for auto-discovery**

Our nightly crawler checks all known domains. If you're already processing 402 payments on-chain, we may discover you automatically.

### Verify your listing

After submitting, visit the [directory](https://open402.directory) and search for your domain. Your card should show:
- Your display name and description (from `agent.json`)
- Protocol badges (x402, L402, MPP)
- Endpoint count
- A green "Verified" indicator

If something looks wrong, check your `agent.json` with the [Validator](https://agentinternetruntime.com/spec/agent-json/validator).

---

## Supported protocols

| Protocol | Payment Rails | Currency | Ecosystem |
|----------|--------------|----------|-----------|
| **x402** | Base / Ethereum, stablecoins | USDC | Coinbase |
| **L402** | Lightning Network | BTC / sats | Lightning Labs |
| **MPP** | Fiat rails (Stripe, etc.) | USD / fiat | Tempo |

The registry is protocol-agnostic. If a new 402 protocol emerges, it works automatically — the directory reads `Object.keys(payments)` from each `agent.json` and displays whatever it finds.

---

## Fork this registry

The registry is MIT-licensed. You can fork it and build anything:

### Run your own directory

```bash
# 1. Fork this repo on GitHub

# 2. Clone your fork
git clone https://github.com/YOUR_USERNAME/open-402-directory.git
cd open-402-directory

# 3. Read the data
cat registry/domains.txt          # All known domains
cat registry/snapshot.json        # Structured metadata (JSON)
```

The `snapshot.json` file contains everything you need to build a UI: display names, descriptions, endpoint lists, pricing, protocol info, and health status for every verified domain.

### Build on the data

Some ideas:

| What | How |
|------|-----|
| **Your own directory UI** | Parse `snapshot.json`, render cards, deploy anywhere |
| **Agent discovery service** | Let AI agents query the registry to find APIs by capability |
| **Uptime monitor** | Crawl verified domains periodically, track availability |
| **Protocol analytics** | Aggregate endpoint counts and pricing by protocol |
| **On-chain explorer** | Cross-reference `payout_address` fields with blockchain data |

### Keep your fork in sync

```bash
# Add the upstream remote (one time)
git remote add upstream https://github.com/FransDevelopment/open-402-directory.git

# Pull latest registry data
git fetch upstream
git merge upstream/main
```

The registry is append-only for new domains. Merges are clean.

### Use the API instead

If you don't want to maintain a fork, query the live directory API:

```bash
# List all domains
curl https://agentinternetruntime.com/api/directory

# Search
curl "https://agentinternetruntime.com/api/directory?q=stripe"

# Filter by protocol
curl "https://agentinternetruntime.com/api/directory?protocol=x402"

# Filter by status
curl "https://agentinternetruntime.com/api/directory?status=verified"
```

---

## Contributing

We welcome contributions. The simplest: add a domain you know accepts 402 payments.

1. Fork this repo
2. Add a line to `registry/domains.txt`
3. Open a PR

Use `unclaimed` status if you're not sure whether the domain hosts `agent.json`. Our crawler will verify it.

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for detailed guidelines, what we accept, and the review process.

### Report an issue

- **Dead domain?** [Open an issue](../../issues/new?template=report-domain.yml). Domains are removed after 30+ days of confirmed unreachability.
- **Incorrect metadata?** The metadata comes from the domain's `agent.json`. Ask the provider to update their file — the registry will pick up the changes on the next crawl.
- **Spam / abuse?** [Open an issue](../../issues/new?template=report-domain.yml) with the domain. We take abuse reports seriously.
- **Security vulnerability?** See **[SECURITY.md](SECURITY.md)**. Do not open a public issue.

---

## Community

- **[Contributing guidelines](CONTRIBUTING.md)** — How to submit domains, PR format, review process
- **[Code of Conduct](CODE_OF_CONDUCT.md)** — Contributor Covenant 2.1 with registry-specific standards
- **[Security policy](SECURITY.md)** — How to report malicious domains or vulnerabilities

---

## Related projects

| Project | What it does |
|---------|-------------|
| **[Open Agent Trust Registry](https://github.com/FransDevelopment/open-agent-trust-registry)** | Federated root-of-trust for agent identity. The 402 Directory tells you *what* paid APIs exist — the Trust Registry tells you *whether to trust them*. Complementary infrastructure layer. |
| **[agent.json Spec](https://agentinternetruntime.com/spec/agent-json)** | The open capability manifest standard that verified listings are built on. |
| **[Agent Internet Runtime](https://agentinternetruntime.com)** | The platform that powers this directory — collective intelligence for AI agents to discover, trust, and interact with the web. |

---

## License

[MIT](LICENSE) — do whatever you want with this data.
