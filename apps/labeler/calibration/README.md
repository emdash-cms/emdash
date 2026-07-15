# Labeler calibration harness (W8.6)

Runs the **real** moderation adapters (`analyzeCode`, `analyzeImages`) and the
real policy resolver over a fixture corpus against live Workers AI models, so
false positives/negatives can be reviewed before a policy or model change ships.
The model + prompt + schema + policy combination is the unit under evaluation —
nothing here re-implements the eval prompt.

This is not part of `pnpm test`. It calls real models and costs tokens.

## Layout

- `fixtures/<name>/` — ported audit fixtures: `manifest.json`, `backend.js`,
  optional `icon.png`, and `expected.json` re-expressed in labeler policy terms.
- `models.ts` — the data-driven model matrix (add/remove models here).
- `rest-ai-binding.ts` — `AiBinding` backed by the Workers AI REST endpoint.
- `fixture-loader.ts` — pure conversion (PNG dims, sha256, legacy→labeler map).
- `run.ts` / `run.calibrate.ts` — the sweep; writes artifacts to `runs/`.
- `report.ts` / `report.calibrate.ts` — markdown report + run-vs-run diff.
- `runs/` — recorded artifacts (gitignored; review outputs, not source).

## Run a sweep

```bash
CLOUDFLARE_API_TOKEN=$(pnpm --filter @emdash-cms/labeler exec wrangler auth token | tail -1) \
CLOUDFLARE_ACCOUNT_ID=<account-id> \
CALIBRATE_LABEL=baseline \
  pnpm --filter @emdash-cms/labeler calibrate
```

The token is read from the environment and never logged or persisted. Artifacts
land in `calibration/runs/<timestamp>-<label>/` — one JSON file per
fixture×lane×model plus `run-manifest.json`. Model/validation errors are
recorded as data, not thrown; the sweep always completes.

`@cf/meta/llama-3.2-11b-vision-instruct` needs a one-time license acceptance. If
it errors on the license gate the runner prints the exact `{"prompt":"agree"}`
call to make by hand (the harness never auto-agrees) and continues.

## Generate a report

```bash
CALIBRATE_RUN=calibration/runs/<timestamp>-<label> \
  pnpm --filter @emdash-cms/labeler calibrate:report        # single run

CALIBRATE_RUN=calibration/runs/<ts>-candidate \
CALIBRATE_BASE=calibration/runs/<ts>-baseline \
  pnpm --filter @emdash-cms/labeler calibrate:report        # diff vs baseline
```

The report writes `report.md` (or `report-vs-base.md`) into the run dir: a
per-fixture outcome matrix, agreement with `expected.json`, false-positive /
false-negative tallies, and — with a baseline — newly-blocked / newly-allowed
sections.

## Expectations

`expected.json` is a review prior, not ground truth (the legacy corpus was
baselined on different models). `mapLegacyExpectation` derives it from the
legacy verdict; where the legacy semantics don't translate to the labeler
policy (unmapped category, warning-only downgrade, `warn` verdict) it sets
`"review": true` instead of guessing.
