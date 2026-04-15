# @emdash-cms/marketplace

Standalone Cloudflare Worker that hosts the EmDash plugin marketplace — discovery, publishing, and moderation.

## Production deployment

The live marketplace needs these Cloudflare Worker secrets before GitHub auth can work:

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `SEED_TOKEN`

`AUDIT_ENFORCEMENT` is optional; if unset, the worker defaults to `flag`.

The GitHub Actions deployment workflow expects repository secrets with these names:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `MARKETPLACE_GITHUB_CLIENT_ID`
- `MARKETPLACE_GITHUB_CLIENT_SECRET`
- `MARKETPLACE_SEED_TOKEN`

After deploying, verify discovery before seeding plugins:

```bash
curl -s https://marketplace.emdashcms.com/api/v1/auth/discovery | jq '.github'
```

The response must report `enabled: true` and a non-empty `clientId`. If discovery stays disabled, check that both `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` were pushed successfully.

## Development

```bash
pnpm dev        # starts wrangler dev server on :8787
pnpm test       # runs vitest
```

Requires an AI binding (`wrangler.jsonc` has it configured). Code and image audits run on Workers AI.

## Manual audit testing

The `/api/v1/dev/audit` endpoint (localhost only) runs the code + image audit pipeline without auth or DB writes. Use it to evaluate AI model accuracy against the fixture corpus.

### Using the test script

```bash
# Run a single fixture
tests/fixtures/audit/test-audit.sh tests/fixtures/audit/prompt-injection

# Against a different host
tests/fixtures/audit/test-audit.sh tests/fixtures/audit/data-exfiltration http://localhost:8787
```

The script tars the fixture directory and POSTs it as a multipart bundle. Output is the raw audit JSON.

### Using curl directly

Tarball mode (full bundle with manifest, code, and images):

```bash
tar -czf /tmp/bundle.tar.gz -C tests/fixtures/audit/crypto-miner .
curl -s -X POST http://localhost:8787/api/v1/dev/audit -F "bundle=@/tmp/bundle.tar.gz" | jq
```

JSON mode (code only, no manifest required):

```bash
curl -s -X POST http://localhost:8787/api/v1/dev/audit \
  -H "Content-Type: application/json" \
  -d '{"backendCode": "const x = eval(\"1+1\");"}' | jq
```

### Running all fixtures

```bash
for d in tests/fixtures/audit/*/; do
  echo "=== $(basename "$d") ==="
  tests/fixtures/audit/test-audit.sh "$d"
  echo
done
```

Compare the `verdict` and `riskScore` in each response against the fixture's `expected.json` to evaluate model accuracy.

## Fixture format

Each fixture in `tests/fixtures/audit/` is a directory containing:

| File                | Required | Purpose                             |
| ------------------- | -------- | ----------------------------------- |
| `manifest.json`     | yes      | Plugin manifest                     |
| `backend.js`        | yes      | Backend code (primary audit target) |
| `admin.js`          | no       | Admin UI code                       |
| `icon.png`          | no       | Plugin icon (triggers image audit)  |
| `screenshots/*.png` | no       | Screenshots (trigger image audit)   |
| `expected.json`     | yes      | Expected verdict, score, categories |

`expected.json` shape:

```json
{
  "verdict": "pass" | "warn" | "fail",
  "minRiskScore": 50,
  "maxRiskScore": 10,
  "categories": ["data-exfiltration", "obfuscation"]
}
```

`minRiskScore` and `maxRiskScore` are optional bounds. `categories` lists the finding categories the model should detect.
