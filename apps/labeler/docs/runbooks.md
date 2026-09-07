# Plugin registry labeler operations

This runbook covers deployment setup, routine operator actions, recovery, and signing-key
rotation for the EmDash plugin registry labeler and aggregator. It is written for an operator
who can deploy both Workers, manage their Cloudflare resources, and access deployment secrets.

The labeler assesses only publisher-controlled listing metadata and media displayed in the
registry. Do not give it plugin archives, source code, manifests, dependency data, software
bills of materials, or provenance evidence. A manual decision applies to the exact profile or
release URI and content identifier (CID) shown by the assessment API. It does not assess plugin
code.

The reference aggregator normally runs in `projection` mode. An exact-CID `listing-passed`
label from every required source is necessary for a profile or release to appear. The only
emergency fallback is an explicit `allowlist`; never use `open` on the deployed service.

## Deployment prerequisites

Complete the repository configuration and the external Cloudflare configuration before the
first deployment.

### Repository configuration

Confirm the non-secret values in `apps/labeler/wrangler.jsonc`:

- Confirm that `LABELER_DID` and `LABELER_SERVICE_URL` describe the same host. The current
  configuration uses `did:web:labels.emdashcms.com` and `https://labels.emdashcms.com`.
- Confirm the policy, parser, and model versions. Prompt identities are computed from the
  embedded prompts. These values are written into assessment records and published in the
  policy document.

Confirm the deployed policy in `apps/aggregator/wrangler.jsonc`:

- `LISTING_POLICY_MODE` is `projection` for normal operation or `allowlist` during an explicit
  rollback. It must not be `open`.
- `LISTING_MODERATION_POLICY.requiredPositiveSources` contains the deployed labeler DID.
- The same DID appears in the accepted-state and redaction source lists when the reference
  labeler is authoritative for those states.
- `LISTING_ALLOWLIST` is a JSON array of exact package-profile AT URIs. Keep it empty in
  `projection` mode.

The private signing value is a canonical, unpadded base64url encoding of one valid 32-byte
P-256 scalar. The public value is its canonical compressed P-256 Multikey. Generate and hold
the pair using the approved key-custody process. The test key in the repository is not suitable
for deployment.

### External Cloudflare configuration

The following configuration is outside this repository. Provision and verify it through the
Cloudflare API, Wrangler, or the approved infrastructure system:

- The `emdash-aggregator` and `emdash-labeler` Workers and their routes.
- The `labels.emdashcms.com` custom domain declared by the labeler. The aggregator route is
  configured outside `apps/aggregator/wrangler.jsonc`; commands below assume
  `https://api.emdashcms.com`.
- Both D1 databases and all committed migrations.
- The R2 buckets `emdash-labeler-media-quarantine`, `emdash-labeler-eval-datasets`, and
  `emdash-labeler-eval-artifacts`.
- The discovery queues and dead-letter queues declared by both Workers.
- The labeler Workflow, Durable Objects, Workers AI, Images binding, cron triggers, and the
  aggregator service binding.
- A Cloudflare Access application covering `https://labels.emdashcms.com/_admin*`. Its token
  audience must match `OPERATOR_ACCESS_CONFIG.audience`.
- Access policies that admit only the configured reviewer and administrator principals.

The Worker does not accept `Cf-Access-Authenticated-User-Email` as authentication. Access must
produce a signed `Cf-Access-Jwt-Assertion`; the Worker verifies its signature, issuer, audience,
expiry, subject, and role mapping. There is no Access client secret stored in the Worker. If
automation uses an Access service token, keep its client ID and secret in the external Access
client's secret store and map the token's `common_name` to the minimum required operator role.

### Deployment secrets

Set secrets through Wrangler's interactive prompt or the approved secret-injection system.
Do not put a secret value in a command argument, shell history, repository file, or log.

Set the aggregator admin token:

```sh
pnpm --dir apps/aggregator exec wrangler secret put ADMIN_TOKEN
```

Set one high-entropy reconciliation token on both Workers. The values must be identical:

```sh
pnpm --dir apps/aggregator exec wrangler secret put RECONCILIATION_TOKEN
pnpm --dir apps/labeler exec wrangler secret put RECONCILIATION_TOKEN
```

Set the labeler's private P-256 scalar:

```sh
pnpm --dir apps/labeler exec wrangler secret put LABEL_SIGNING_PRIVATE_KEY
```

Set the matching compressed P-256 public Multikey:

```sh
pnpm --dir apps/labeler exec wrangler secret put LABEL_SIGNING_PUBLIC_KEY
```

Set `OPERATOR_ACCESS_CONFIG` as JSON containing the Access application audience and the
reviewer and administrator principal mappings:

```sh
pnpm --dir apps/labeler exec wrangler secret put OPERATOR_ACCESS_CONFIG
```

List the configured secret names without retrieving their values:

```sh
pnpm --dir apps/aggregator exec wrangler secret list
pnpm --dir apps/labeler exec wrangler secret list
```

The aggregator fails its admin and reconciliation routes closed if either token is absent. The
labeler health check reports `signing.ready: false` if the private scalar is absent, invalid, or
does not match `LABEL_SIGNING_PUBLIC_KEY`.

### Protected evaluation dataset

The live evaluation runner loads the public fixture bytes and image assets from the
`emdash-labeler-eval-datasets` R2 bucket. It loads the private holdout from the exact key
`protected/holdout.json`. The holdout contains its private PNG assets as committed base64 data
and must stay outside the repository.

Before upload, confirm that the protected file's SHA-256 digest equals
`holdout.commitment` in `apps/labeler/evals/datasets/v1/manifest.json`:

```sh
shasum -a 256 /secure/path/emdash-labeler-holdout.json
```

Upload the public fixture and committed assets from the repository:

```sh
pnpm --dir apps/labeler exec wrangler r2 object put emdash-labeler-eval-datasets/v1/public.json --remote --file evals/datasets/v1/public.json --content-type application/json
pnpm --dir apps/labeler exec wrangler r2 object put emdash-labeler-eval-datasets/v1/assets/clean-plugin-card.png --remote --file evals/datasets/v1/assets/clean-plugin-card.png --content-type image/png
pnpm --dir apps/labeler exec wrangler r2 object put emdash-labeler-eval-datasets/v1/assets/impersonation-badge.png --remote --file evals/datasets/v1/assets/impersonation-badge.png --content-type image/png
pnpm --dir apps/labeler exec wrangler r2 object put emdash-labeler-eval-datasets/v1/assets/phishing-login.png --remote --file evals/datasets/v1/assets/phishing-login.png --content-type image/png
pnpm --dir apps/labeler exec wrangler r2 object put emdash-labeler-eval-datasets/v1/assets/phishing-prompt-injection.png --remote --file evals/datasets/v1/assets/phishing-prompt-injection.png --content-type image/png
pnpm --dir apps/labeler exec wrangler r2 object put emdash-labeler-eval-datasets/v1/assets/legacy-brand-logo.png --remote --file evals/datasets/v1/assets/legacy-brand-logo.png --content-type image/png
pnpm --dir apps/labeler exec wrangler r2 object put emdash-labeler-eval-datasets/v1/assets/legacy-clean-icon.png --remote --file evals/datasets/v1/assets/legacy-clean-icon.png --content-type image/png
```

Upload the protected holdout from its controlled location:

```sh
pnpm --dir apps/labeler exec wrangler r2 object put emdash-labeler-eval-datasets/protected/holdout.json --remote --file /secure/path/emdash-labeler-holdout.json --content-type application/json
```

The live runner verifies every public file hash, the aggregate public hash, the holdout
commitment, and the promotion aggregate hash before it calls Workers AI. A missing or changed
object makes the run fail. Promotion also requires `promotionEnabled: true` in the committed
manifest. Keep it `false` for a corpus that has been consumed during selection or has failed its
promotion run. See [Listing moderation model evaluation](model-evaluation.md) for the current
evidence and decision.

### Evaluate downloaded images locally

The manual image evaluator reads GIF, JPEG, PNG, and WebP files from local paths without copying
them into the repository or R2. It sends each image to Cloudflare Images and Workers AI through
remote Wrangler bindings. Run it only for images that may be sent to Cloudflare, and expect the
calls to incur Workers AI usage.

Start the localhost proxy in one terminal:

```sh
pnpm --dir apps/labeler eval:image:server
```

Pass one or more image files or directories from another terminal:

```sh
pnpm --dir apps/labeler eval:image:local -- /secure/path/downloaded-images
```

The command searches directories recursively and writes one JSON object per file to standard
output. The JSON contains the local path, pass/review outcome, findings, model identity, latency,
and usage. Image bytes are not included in the output or stored by the evaluator. Stop the proxy
when evaluation finishes.

## Deploy both Workers

Deploy a reviewed commit whose CI checks have passed. The aggregator must exist before the
labeler deployment resolves its service binding.

Apply the forward-only migrations:

```sh
pnpm --dir apps/aggregator db:migrate
pnpm --dir apps/labeler db:migrate
```

Deploy the aggregator first, followed by the labeler:

```sh
pnpm --dir apps/aggregator deploy
pnpm --dir apps/labeler deploy
```

On a new Cloudflare account, provision the resources declared in both Wrangler files before
running the migrations. Resource provisioning and route attachment are external deployment
steps.

Set non-secret origins for the verification commands:

```sh
export EMDASH_LABELER_ORIGIN=https://labels.emdashcms.com
export EMDASH_AGGREGATOR_ORIGIN=https://api.emdashcms.com
```

Load `EMDASH_AGGREGATOR_ADMIN_TOKEN`, `EMDASH_ACCESS_CLIENT_ID`, and
`EMDASH_ACCESS_CLIENT_SECRET` from the approved secret and Access tools. The Access service
token's common name must have the role required for the request. Do not print any of these
values. An interactive Access-aware client may use a human session instead.

Start the aggregator's record-ingest Durable Object:

```sh
curl --fail-with-body --silent --show-error \
  --request POST \
  --header "Authorization: Bearer ${EMDASH_AGGREGATOR_ADMIN_TOKEN}" \
  "${EMDASH_AGGREGATOR_ORIGIN}/_admin/start"
```

Seed existing publisher records. An empty request body selects relay discovery and returns
`202` while queue consumers perform the backfill:

```sh
curl --fail-with-body --silent --show-error \
  --request POST \
  --header "Authorization: Bearer ${EMDASH_AGGREGATOR_ADMIN_TOKEN}" \
  "${EMDASH_AGGREGATOR_ORIGIN}/_admin/backfill"
```

The five-minute cron wakes both discovery loops and schedules label maintenance. A new labeler
may report `503` with `discovery.reason: "awaiting-start"` until the first cron wake and a
successful Jetstream connection.

### Verify identity, policy, and health

Verify the DID document's identity, service endpoint, key ID, and public key:

```sh
curl --fail-with-body --silent --show-error \
  "${EMDASH_LABELER_ORIGIN}/.well-known/did.json" \
  | jq -e '
      .id == "did:web:labels.emdashcms.com" and
      .verificationMethod[0].id == "did:web:labels.emdashcms.com#atproto_label" and
      .verificationMethod[0].type == "Multikey" and
      (.verificationMethod[0].publicKeyMultibase | startswith("z")) and
      .service[0].type == "AtprotoLabeler" and
      .service[0].serviceEndpoint == "https://labels.emdashcms.com"
    '
```

Compare `verificationMethod[0].publicKeyMultibase` with the reviewed
`LABEL_SIGNING_PUBLIC_KEY`; a `z` prefix alone is not sufficient verification.

Verify the published policy remains manual-only and names only profile and release listing
subjects:

```sh
curl --fail-with-body --silent --show-error \
  "${EMDASH_LABELER_ORIGIN}/.well-known/emdash-labeler-policy.json" \
  | jq -e '
      .labelerDid == "did:web:labels.emdashcms.com" and
      .autoPass == "disabled" and
      .subjectCollections == [
        "com.emdashcms.experimental.package.profile",
        "com.emdashcms.experimental.package.release"
      ]
    '
```

Verify the public XRPC policy exposes the same manual positive-label rule and metadata-only
subjects:

```sh
curl --fail-with-body --silent --show-error \
  "${EMDASH_LABELER_ORIGIN}/xrpc/com.emdashcms.experimental.labeler.getPolicy" \
  | jq -e '
      .policyVersion == "listing-metadata-v1" and
      .supportedSubjects == [
        {
          "kind": "profile",
          "collection": "com.emdashcms.experimental.package.profile"
        },
        {
          "kind": "release",
          "collection": "com.emdashcms.experimental.package.release"
        }
      ] and
      ([.labels[] | select(.value == "listing-passed")][0].issuanceModes == [
        "reviewer",
        "admin"
      ])
    '
```

Verify discovery and signing readiness:

```sh
curl --fail-with-body --silent --show-error \
  "${EMDASH_LABELER_ORIGIN}/health" \
  | jq -e '.status == "ok" and .discovery.ready == true and .signing.ready == true'
```

Verify Access authentication and the expected role mapping. A reviewer receives `reviewer`; an
administrator receives `admin` and inherits reviewer actions:

```sh
curl --fail-with-body --silent --show-error \
  --header "CF-Access-Client-Id: ${EMDASH_ACCESS_CLIENT_ID}" \
  --header "CF-Access-Client-Secret: ${EMDASH_ACCESS_CLIENT_SECRET}" \
  "${EMDASH_LABELER_ORIGIN}/_admin/api/session" \
  | jq -e '.authenticated == true and (.identity.roles | length) > 0'
```

Verify aggregator record-ingest status:

```sh
curl --fail-with-body --silent --show-error \
  --header "Authorization: Bearer ${EMDASH_AGGREGATOR_ADMIN_TOKEN}" \
  "${EMDASH_AGGREGATOR_ORIGIN}/_admin/status" \
  | jq -e '.consecutiveFailures == 0'
```

## Use the administration console

Open `https://labels.emdashcms.com/_admin` in a browser and sign in through Cloudflare Access.
The console shows only the controls permitted by the signed-in operator's configured role.

A reviewer can inspect every assessment state, open the recorded model input and findings,
approve or block an exact URI and CID, and start a fresh assessment run. An administrator can
also:

- issue and retract URI-scoped or DID-scoped takedowns;
- view and change the durable issuance state;
- start protected evaluations and inspect their durable results;
- inspect immutable operator activity.

The Overview page reads the public health endpoint and reports discovery and signing readiness.
Every mutation asks for a reason. The console creates a new idempotency key and sends the
same-origin request headers required by the Worker. Repeating an action from the console creates
a new operator request; use the API directly when recovering a response with the original
idempotency key.

## Use the operator APIs

Use these endpoints for automation, incident recovery, or diagnostics when the browser console
is not sufficient. The console uses the same endpoints.

All labeler mutations require:

- A valid Access assertion and a configured role.
- `Content-Type: application/json`.
- `Origin` equal to the labeler request origin.
- `X-EmDash-Request: 1`.
- An `Idempotency-Key` of 8 to 200 ASCII letters, digits, dots, underscores, colons, or hyphens.
- A non-empty `reason` of at most 1,000 characters.

Reuse an idempotency key only to retry the identical action. Assessment decisions, takedowns,
and issuance control bind the actor, action, exact subject, and reason to the key. Live
evaluations bind the actor, role, and reason. Use a new key when a bound value changes. A
conflicting reuse returns `409`.

Authenticated reads are available at:

- `GET /_admin/api/session` for the current principal, actor DID, and roles;
- `GET /_admin/api/issuance` for the durable pause state;
- `GET /_admin/api/evals` and `GET /_admin/api/evals/{runId}` for protected evaluation history;
- `GET /_admin/api/activity` for immutable operator activity.

Evaluation and activity history require the administrator role. Collection responses contain
`items` and, when more rows exist, `nextCursor`. Pass that cursor back as the `cursor` query
parameter.

### Read an assessment

List assessments waiting for review:

```sh
curl --fail-with-body --silent --show-error \
  --header "CF-Access-Client-Id: ${EMDASH_ACCESS_CLIENT_ID}" \
  --header "CF-Access-Client-Secret: ${EMDASH_ACCESS_CLIENT_SECRET}" \
  "${EMDASH_LABELER_ORIGIN}/_admin/api/assessments?state=review&limit=50"
```

Valid state filters are `pending`, `running`, `review`, `error`, `passed`, `blocked`,
`superseded`, and `cancelled`. The `review` filter returns assessments that do not have a manual
approval or block decision. When an exact URI and CID has manual decisions, the `passed` and
`blocked` filters use the latest decision instead of the stored assessment state. When two
decisions have the same timestamp, the action with the higher ID is later. Follow `nextCursor`
to read another page.

Read the selected assessment immediately before acting:

```sh
export EMDASH_ASSESSMENT_RUN=assessment-v1-replace-with-run-key

curl --fail-with-body --silent --show-error \
  --header "CF-Access-Client-Id: ${EMDASH_ACCESS_CLIENT_ID}" \
  --header "CF-Access-Client-Secret: ${EMDASH_ACCESS_CLIENT_SECRET}" \
  "${EMDASH_LABELER_ORIGIN}/_admin/api/assessments/${EMDASH_ASSESSMENT_RUN}"
```

Copy `subject_uri` and `subject_cid` from that response. Do not copy the URI or CID from a
publisher page or an earlier review. Approval and blocking also ask the aggregator to confirm
that the pair still identifies the current record. A changed or deleted subject returns `409`
and issues no decision.

### Approve an exact revision

A reviewer or administrator can approve an assessment in `review`, `error`, or `blocked` state.
Set the exact subject values returned by the detail request:

```sh
export EMDASH_SUBJECT_URI='at://did:plc:replace/com.emdashcms.experimental.package.profile/example'
export EMDASH_SUBJECT_CID='bafy-replace-with-exact-cid'
export EMDASH_DECISION_REASON='Reviewed the displayed listing metadata and media.'

curl --fail-with-body --silent --show-error \
  --request POST \
  --header "CF-Access-Client-Id: ${EMDASH_ACCESS_CLIENT_ID}" \
  --header "CF-Access-Client-Secret: ${EMDASH_ACCESS_CLIENT_SECRET}" \
  --header 'Content-Type: application/json' \
  --header "Origin: ${EMDASH_LABELER_ORIGIN}" \
  --header 'X-EmDash-Request: 1' \
  --header 'Idempotency-Key: review-ticket-123-approve' \
  --data "$(jq -cn \
    --arg uri "${EMDASH_SUBJECT_URI}" \
    --arg cid "${EMDASH_SUBJECT_CID}" \
    --arg reason "${EMDASH_DECISION_REASON}" \
    '{uri: $uri, cid: $cid, reason: $reason}')" \
  "${EMDASH_LABELER_ORIGIN}/_admin/api/assessments/${EMDASH_ASSESSMENT_RUN}/approve"
```

The response contains the same subject, one operator action ID, and the issued label sequences.
The decision atomically issues exact-CID `listing-passed` and `listing-overridden` transitions
and negates applicable review, error, or block state for the same CID.

### Block an exact revision

A reviewer or administrator can block an assessment in `review`, `error`, `passed`, or
`blocked` state:

```sh
export EMDASH_DECISION_REASON='The displayed listing metadata impersonates another publisher.'

curl --fail-with-body --silent --show-error \
  --request POST \
  --header "CF-Access-Client-Id: ${EMDASH_ACCESS_CLIENT_ID}" \
  --header "CF-Access-Client-Secret: ${EMDASH_ACCESS_CLIENT_SECRET}" \
  --header 'Content-Type: application/json' \
  --header "Origin: ${EMDASH_LABELER_ORIGIN}" \
  --header 'X-EmDash-Request: 1' \
  --header 'Idempotency-Key: review-ticket-123-block' \
  --data "$(jq -cn \
    --arg uri "${EMDASH_SUBJECT_URI}" \
    --arg cid "${EMDASH_SUBJECT_CID}" \
    --arg reason "${EMDASH_DECISION_REASON}" \
    '{uri: $uri, cid: $cid, reason: $reason}')" \
  "${EMDASH_LABELER_ORIGIN}/_admin/api/assessments/${EMDASH_ASSESSMENT_RUN}/block"
```

The decision issues exact-CID `listing-blocked` and negates applicable `listing-passed` and
`listing-overridden` state for that CID. It does not retract a different approved CID.

### Issue and retract a takedown

Only an administrator can issue `!takedown`. A takedown is URI-scoped or DID-scoped, so its
request contains `uri` and deliberately contains no CID. Use an assessment block when the
intent is to block only one record revision.

Issue the takedown:

```sh
export EMDASH_TAKEDOWN_URI='at://did:plc:replace/com.emdashcms.experimental.package.profile/example'
export EMDASH_TAKEDOWN_REASON='Incident ticket 123: hide this listing URI while it is investigated.'

curl --fail-with-body --silent --show-error \
  --request POST \
  --header "CF-Access-Client-Id: ${EMDASH_ACCESS_CLIENT_ID}" \
  --header "CF-Access-Client-Secret: ${EMDASH_ACCESS_CLIENT_SECRET}" \
  --header 'Content-Type: application/json' \
  --header "Origin: ${EMDASH_LABELER_ORIGIN}" \
  --header 'X-EmDash-Request: 1' \
  --header 'Idempotency-Key: incident-123-takedown' \
  --data "$(jq -cn \
    --arg uri "${EMDASH_TAKEDOWN_URI}" \
    --arg reason "${EMDASH_TAKEDOWN_REASON}" \
    '{uri: $uri, reason: $reason}')" \
  "${EMDASH_LABELER_ORIGIN}/_admin/api/takedown"
```

Retract the same takedown after the incident is resolved. Use the identical URI and a new
idempotency key:

```sh
export EMDASH_TAKEDOWN_REASON='Incident ticket 123 resolved; retract the URI-scoped takedown.'

curl --fail-with-body --silent --show-error \
  --request POST \
  --header "CF-Access-Client-Id: ${EMDASH_ACCESS_CLIENT_ID}" \
  --header "CF-Access-Client-Secret: ${EMDASH_ACCESS_CLIENT_SECRET}" \
  --header 'Content-Type: application/json' \
  --header "Origin: ${EMDASH_LABELER_ORIGIN}" \
  --header 'X-EmDash-Request: 1' \
  --header 'Idempotency-Key: incident-123-retract-takedown' \
  --data "$(jq -cn \
    --arg uri "${EMDASH_TAKEDOWN_URI}" \
    --arg reason "${EMDASH_TAKEDOWN_REASON}" \
    '{uri: $uri, reason: $reason}')" \
  "${EMDASH_LABELER_ORIGIN}/_admin/api/takedown/retract"
```

Retraction is a signed negation of `!takedown`. It does not issue a positive listing label.

### Pause and resume automated issuance

Only an administrator can pause or resume issuance. The pause blocks automated label issuance;
manual approval, blocking, and emergency takedown remain available. Assessments can continue,
and reconciliation can recover an automated outcome after issuance resumes.

Pause issuance:

```sh
curl --fail-with-body --silent --show-error \
  --request POST \
  --header "CF-Access-Client-Id: ${EMDASH_ACCESS_CLIENT_ID}" \
  --header "CF-Access-Client-Secret: ${EMDASH_ACCESS_CLIENT_SECRET}" \
  --header 'Content-Type: application/json' \
  --header "Origin: ${EMDASH_LABELER_ORIGIN}" \
  --header 'X-EmDash-Request: 1' \
  --header 'Idempotency-Key: incident-123-pause-issuance' \
  --data '{"reason":"Incident ticket 123: pause automated label issuance."}' \
  "${EMDASH_LABELER_ORIGIN}/_admin/api/issuance/pause"
```

Resume with a new idempotency key:

```sh
curl --fail-with-body --silent --show-error \
  --request POST \
  --header "CF-Access-Client-Id: ${EMDASH_ACCESS_CLIENT_ID}" \
  --header "CF-Access-Client-Secret: ${EMDASH_ACCESS_CLIENT_SECRET}" \
  --header 'Content-Type: application/json' \
  --header "Origin: ${EMDASH_LABELER_ORIGIN}" \
  --header 'X-EmDash-Request: 1' \
  --header 'Idempotency-Key: incident-123-resume-issuance' \
  --data '{"reason":"Incident ticket 123 resolved; resume automated label issuance."}' \
  "${EMDASH_LABELER_ORIGIN}/_admin/api/issuance/resume"
```

Both responses return `{ "paused": true | false }`. Confirm the durable state with the D1
query in [Status queries](#status-queries), or open the Issuance page in the administration
console. Do not reuse a completed pause key after a later resume, or the idempotent response will
describe the earlier request rather than perform a new transition.

### Run the protected live evaluation

Only an administrator can start a live run. The endpoint uses the native Workers AI binding,
the committed public files, the protected holdout, and three repeats. It returns `202` after it
creates a durable Workflow instance:

```sh
EMDASH_EVAL_START="$(curl --fail-with-body --silent --show-error \
  --request POST \
  --header "CF-Access-Client-Id: ${EMDASH_ACCESS_CLIENT_ID}" \
  --header "CF-Access-Client-Secret: ${EMDASH_ACCESS_CLIENT_SECRET}" \
  --header 'Content-Type: application/json' \
  --header "Origin: ${EMDASH_LABELER_ORIGIN}" \
  --header 'X-EmDash-Request: 1' \
  --header 'Idempotency-Key: eval-listing-metadata-v1-001' \
  --data '{"reason":"Run the protected evaluation for the reviewed model bundle."}' \
  "${EMDASH_LABELER_ORIGIN}/_admin/api/evals/run")"

export EMDASH_EVAL_RUN_ID="$(printf '%s' "${EMDASH_EVAL_START}" | jq -er '.runId')"
export EMDASH_EVAL_INSTANCE_ID="$(printf '%s' "${EMDASH_EVAL_START}" | jq -er '.instanceId')"
printf '%s' "${EMDASH_EVAL_START}" | jq -e '.status == "running"'
```

Retry the identical POST with the same idempotency key if the response is lost. It returns the
same `runId` and `instanceId`. If the D1 claim was bound but Workflow creation did not finish, the
retry creates that deterministic instance. If the instance terminated or errored before D1
recorded a terminal result, the retry records the run as failed instead of restarting completed
model steps. Diagnose the failure and use a new key. A different actor or reason cannot reuse the
original key.

Poll the durable result with the returned run ID:

```sh
curl --fail-with-body --silent --show-error \
  --header "CF-Access-Client-Id: ${EMDASH_ACCESS_CLIENT_ID}" \
  --header "CF-Access-Client-Secret: ${EMDASH_ACCESS_CLIENT_SECRET}" \
  "${EMDASH_LABELER_ORIGIN}/_admin/api/evals/${EMDASH_EVAL_RUN_ID}"
```

A running response contains `runId`, `instanceId`, and `status: "running"`. A successful response
uses `status: "succeeded"`; its `result` contains `artifactKey`, `datasetHash`, `budgetPassed`,
`failures`, `candidateHash`, `promotionComparison`, and `report`. A failed response uses
`status: "failed"` and contains a stable failure code and summary. Diagnose a failed run and use
a new idempotency key to start another evaluation.

The Workflow persists each fixture repeat as a separate durable step. A process restart reuses
completed case results. It also binds the run to the dataset, runner commit, model IDs, prompt
hashes, and selected baseline before inference, so a changed deployment fails rather than mixing
cached cases from different evaluation identities. The complete artifact is written to
`emdash-labeler-eval-artifacts`.

The labeler stores the bounded result, comparison, and report in `eval_runs`; the complete model
artifact remains in `emdash-labeler-eval-artifacts`. Inspect one run without retrieving the full
artifact:

```sh
pnpm --dir apps/labeler exec wrangler d1 execute emdash-labeler --remote --json --command "SELECT id, workflow_instance_id, status, attempt, result_json, comparison_json, report_markdown, failure_code, failure_summary, created_at, completed_at FROM eval_runs WHERE id = REPLACE_WITH_RUN_ID"
```

The comparison and challenge hash do not authorize a promotion. A successful run also does not
enable automatic passing. The published policy remains `autoPass: "disabled"` until a separate
authenticated review and policy change is deployed.

## Recover the aggregator D1 database

This procedure restores the aggregator D1 database, re-ingests current publisher records,
replays the complete signed label history, and rebuilds the public projection. D1 Time Travel
changes deployed data. Rehearse the complete procedure against a D1 backup in disposable
resources, and record the current bookmark before restoring the deployed database.

Keep the registry in explicit `allowlist` mode for the entire recovery. Use an empty allowlist
to hide every listing when there is no approved emergency set. Do not use `open`.

1. Follow [Switch to the emergency allowlist](#switch-to-the-emergency-allowlist).
2. Pause automated issuance and suspend manual decisions for the recovery window.
3. Record a bookmark for the current database so the restore itself can be reversed:

   ```sh
   pnpm --dir apps/aggregator exec wrangler d1 time-travel info emdash-aggregator --json
   ```

4. Resolve a bookmark for the selected pre-incident timestamp:

   ```sh
   pnpm --dir apps/aggregator exec wrangler d1 time-travel info emdash-aggregator --timestamp '<incident-start-rfc3339>' --json
   ```

5. Restore the selected bookmark after a second operator verifies the database name and
   timestamp:

   ```sh
   pnpm --dir apps/aggregator exec wrangler d1 time-travel restore emdash-aggregator --bookmark '<verified-bookmark>'
   ```

6. Reapply any migrations newer than the restore point:

   ```sh
   pnpm --dir apps/aggregator db:migrate
   ```

7. Start record ingest and enqueue a full record backfill. D1 Time Travel does not rewind the
   Records Durable Object or queue state, so the backfill is required to recover current records
   that occurred after the restore point:

   ```sh
   curl --fail-with-body --silent --show-error \
     --request POST \
     --header "Authorization: Bearer ${EMDASH_AGGREGATOR_ADMIN_TOKEN}" \
     "${EMDASH_AGGREGATOR_ORIGIN}/_admin/start"

   curl --fail-with-body --silent --show-error \
     --request POST \
     --header "Authorization: Bearer ${EMDASH_AGGREGATOR_ADMIN_TOKEN}" \
     "${EMDASH_AGGREGATOR_ORIGIN}/_admin/backfill"
   ```

8. Wait for backfill and record queues to drain. Check the status endpoint, Workers logs, and
   dead-letter queues. Investigate every exhausted backfill or record job before proceeding.
9. Confirm that the scheduled label maintenance pass has recreated a trusted, active
   `labellers` row for every accepted source. The five-minute cron runs this pass; use the
   aggregator query in [Status queries](#status-queries) to verify the rows.
10. Reset every accepted label source to cursor zero and wake a full query replay:

```sh
curl --fail-with-body --silent --show-error \
  --request POST \
  --header "Authorization: Bearer ${EMDASH_AGGREGATOR_ADMIN_TOKEN}" \
  "${EMDASH_AGGREGATOR_ORIGIN}/_admin/labels/replay" \
  | jq -e '.sources | index("did:web:labels.emdashcms.com") != null'
```

The endpoint stops each active label-ingest Durable Object, then atomically marks the source
untrusted and replay-pending, advances its replay generation, and removes its durable D1 cursor.
It then wakes the source from cursor zero. Projection-mode reads remain unavailable until it catches
up and the generation-fenced activation succeeds. Existing blocks, takedowns, and both withdrawal
spellings remain enforced in emergency allowlist mode throughout replay. The endpoint is
authenticated with the aggregator `ADMIN_TOKEN` and accepts no request body.

11. Compare the labeler maximum sequence with the aggregator cursor. Repeat the aggregator
    query until its cursor equals the labeler maximum sequence:

    ```sh
    pnpm --dir apps/labeler exec wrangler d1 execute emdash-labeler --remote --json --command "SELECT COALESCE(MAX(sequence), 0) AS max_sequence FROM issued_labels"

    pnpm --dir apps/aggregator exec wrangler d1 execute emdash-aggregator --remote --json --command "SELECT source, cursor, updated_at FROM ingest_state WHERE source = 'labeler:did:web:labels.emdashcms.com'"
    ```

12. Confirm that projection work has converged and the active generation is complete:

    ```sh
    pnpm --dir apps/aggregator exec wrangler d1 execute emdash-aggregator --remote --json --command "SELECT work.dirty_epoch, work.scheduled_epoch, work.acknowledged_epoch, state.active_generation, generation.policy_mode, generation.policy_version, generation.policy_hash, generation.source_epoch, control.source_epoch AS current_source_epoch, generation.completed_at FROM listing_projection_work work JOIN public_projection_state state ON state.id = 1 LEFT JOIN public_projection_generations generation ON generation.generation = state.active_generation JOIN listing_projection_control control ON control.id = 1 WHERE work.id = 1"
    ```

    Recovery has converged when `dirty_epoch`, `scheduled_epoch`, and `acknowledged_epoch` are
    equal; the generation is complete; and `generation.source_epoch` equals
    `current_source_epoch`. While allowlist mode is active, `policy_mode` is `allowlist`.

13. Compare a known allowed package, a known blocked package, a taken-down package, and a package
    outside the allowlist with the pre-incident visibility record. The last three must remain
    unavailable.
14. Return the aggregator to `projection` mode, deploy it, and call `/_admin/labels/replay` once
    more. The old allowlist generation cannot satisfy projection-mode reads; the read path fails
    closed until the new projection generation is active.
15. Repeat the cursor and projection checks. Require `policy_mode: "projection"`, the reviewed
    policy version and hash, a complete generation, and equal source epochs before removing the
    incident restriction or resuming issuance.

If the labeler D1 database itself must be restored, keep the emergency allowlist active. Record
its current bookmark, restore `emdash-labeler`, reapply labeler migrations, and let the scheduled
authoritative reconciliation rediscover current subjects. A labeler restore can remove issued
labels and append-only operator actions created after the restore point. Aggregator replay cannot
recreate a lost manual decision; re-review those exact subjects and issue new decisions through
the operator API. Do not reconstruct operator actions or signed labels with direct SQL.

## Switch to the emergency allowlist

The emergency mode serves only package profiles whose exact AT URIs appear in
`LISTING_ALLOWLIST`. The verification step must also prove that active takedowns and release
withdrawal labels remain enforced.

1. Build a reviewed JSON list of exact profile URIs, for example:

   ```json
   ["at://did:plc:replace/com.emdashcms.experimental.package.profile/example"]
   ```

2. Set `LISTING_POLICY_MODE` to `allowlist` in `apps/aggregator/wrangler.jsonc`.
3. Set `LISTING_ALLOWLIST` to the JSON-encoded list. Use `[]` when the safe response is to hide
   every listing.
4. Deploy only the aggregator:

   ```sh
   pnpm --dir apps/aggregator deploy
   ```

5. Verify browse, search, exact package lookup, release lookup, and artifact requests. A package
   outside the list must return `ListingUnavailable` or be absent. Confirm that taken-down and
   withdrawn releases remain unavailable. If any endpoint exposes one, deploy an empty
   allowlist and stop the rollback procedure.

Do not change `LISTING_POLICY_MODE` to `open`, even temporarily. `open` exposes staged records
without the positive-label gate.

To return to normal enforcement, set the mode to `projection`, restore `LISTING_ALLOWLIST` to
`[]`, deploy the aggregator, and call `POST /_admin/labels/replay`. Wait for a complete active
`projection` generation with matching policy version, policy hash, and source epoch before
declaring the rollback complete.

## Rotate the signing key

Verify the replacement pair before deployment. Keep the old private key under its existing
custody policy until the replay and rollback window closes.

1. Generate a new P-256 key pair through the approved key-custody process. Record the canonical
   compressed public Multikey and place the unpadded base64url private scalar in a temporary
   secret file outside the repository:

   ```text title="/secure/path/labeler-key-rotation.env"
   LABEL_SIGNING_PRIVATE_KEY=<new-private-scalar>
   LABEL_SIGNING_PUBLIC_KEY=<new-public-multikey>
   ```

   Wrangler's `secret bulk` command accepts dotenv and JSON input. This procedure uses dotenv
   so the reviewed key pair stays together during verification and upload.

2. Pause automated issuance with a new incident or change-ticket idempotency key. Confirm
   `issuance_paused` is `1` with the D1 query in [Status queries](#status-queries).
3. Upload both key values in one bulk secret operation. Do not update the public and private
   values separately:

   ```sh
   pnpm --dir apps/labeler exec wrangler secret bulk /secure/path/labeler-key-rotation.env
   ```

4. Deploy the reviewed labeler version.

5. Fetch `/.well-known/did.json` and compare the complete `publicKeyMultibase` with the new
   reviewed value. Fetch `/health` and require `signing.ready: true`. A mismatched pair makes the
   health check fail closed.
6. Call the aggregator `POST /_admin/labels/replay` endpoint. Wait for the label cursor and
   projection checks in the D1 recovery procedure to converge.
7. Confirm that `labeler_signing_keys` contains the old and new public keys with observed
   boundaries:

   ```sh
   pnpm --dir apps/aggregator exec wrangler d1 execute emdash-aggregator --remote --json --command "SELECT did, signing_key, first_seen_at, last_seen_at FROM labeler_signing_keys WHERE did = 'did:web:labels.emdashcms.com' ORDER BY first_seen_at"
   ```

8. Read labels from cursor zero through `com.atproto.label.queryLabels` and confirm the aggregator
   accepts them without signature failures or projection drift. The labeler re-signs retained
   historical label payloads with the current key during query, subscription replay, and public
   assessment responses. The aggregator also retains previously observed public keys so it can
   verify old in-flight events within their observed validity boundary.
9. Resume automated issuance with a new idempotency key. Confirm `issuance_paused` is `0`, issue a
   test decision, and verify that the aggregator ingests its sequence.

Never delete D1 label history as part of rotation. The immutable stored labels and operator
actions remain the audit record even though replay delivery uses the current signing key.

## Status queries

Use the following read-only queries during deployment, incidents, and recovery.

Read labeler issuance state, assessment backlog, unpublished labels, quarantine backlog, live
evaluation status, and durable cursors:

```sh
pnpm --dir apps/labeler exec wrangler d1 execute emdash-labeler --remote --json --command "SELECT key, value, updated_at FROM service_state WHERE key = 'issuance_paused'; SELECT state, COUNT(*) AS count, MIN(updated_at) AS oldest_updated_at FROM assessments GROUP BY state ORDER BY state; SELECT COUNT(*) AS pending_publication, MIN(created_at) AS oldest_pending FROM issued_labels WHERE publication_pending = 1; SELECT COUNT(*) AS reconciliation_required, MIN(observed_at) AS oldest_observed_at FROM discovery_quarantine_events WHERE requires_reconciliation = 1; SELECT quarantine_id, revision, cursor, event_id, reason, observed_at FROM discovery_quarantine_events WHERE requires_reconciliation = 1 ORDER BY observed_at, cursor, quarantine_id LIMIT 100; SELECT ready, COUNT(*) AS count, MIN(expires_at) AS oldest_expiry FROM media_quarantine_objects GROUP BY ready ORDER BY ready; SELECT status, COUNT(*) AS count, MIN(created_at) AS oldest_created_at FROM eval_runs GROUP BY status ORDER BY status; SELECT id, status, dataset_hash, budget_passed, candidate_hash, baseline_run_id, comparison_hash, promotion_challenge_hash, artifact_key, failure_code, created_at, completed_at FROM eval_runs ORDER BY id DESC LIMIT 100; SELECT stream, cursor, last_observed_at, updated_at FROM ingest_state ORDER BY stream"
```

Read aggregator source trust, freshness, replay state, label cursors, collisions, and projection
state:

```sh
pnpm --dir apps/aggregator exec wrangler d1 execute emdash-aggregator --remote --json --command "SELECT did, active, trusted, required_positive, accepted_state, redaction, replay_pending, replay_generation, health_last_success_at, health_failure_started_at, health_failure_count, last_resolved_at, stop_acknowledged FROM labellers ORDER BY did; SELECT source, cursor, updated_at FROM ingest_state WHERE source LIKE 'labeler:%' ORDER BY source; SELECT COUNT(*) AS active_collisions FROM label_state WHERE trusted = 1 AND collision = 1; SELECT work.dirty_epoch, work.scheduled_epoch, work.acknowledged_epoch, state.active_generation, generation.policy_mode, generation.policy_version, generation.policy_hash, generation.source_epoch, control.source_epoch AS current_source_epoch, generation.completed_at FROM listing_projection_work work JOIN public_projection_state state ON state.id = 1 LEFT JOIN public_projection_generations generation ON generation.generation = state.active_generation JOIN listing_projection_control control ON control.id = 1 WHERE work.id = 1"
```

Projection mode requires every configured positive, state, and redaction source to have completed
a successful catch-up within the previous ten minutes. The label ingestor normally refreshes an
idle connection after five minutes. At the ten-minute boundary, reads fail closed from persisted
freshness even if scheduled demotion has not run.

List Workflow instances when assessment runs appear stalled:

```sh
pnpm --dir apps/labeler exec wrangler workflows instances list emdash-labeler-assessment
pnpm --dir apps/labeler exec wrangler workflows instances list emdash-labeler-live-evaluation
```

Stream structured labeler and aggregator logs during a drill or incident:

```sh
pnpm --dir apps/labeler exec wrangler tail emdash-labeler --format json
pnpm --dir apps/aggregator exec wrangler tail emdash-aggregator --format json
```

## Alerts

Cloudflare alert rules and notification destinations are external deployment configuration; the
repository enables Worker observability but does not create those rules. Configure alerts for
the following signals:

- `/health` returns a non-`200` response or reports signing or discovery not ready.
- `discovery_loop_stopped` or repeated `discovery_stream_retry` events, especially with a stale
  `jetstream-enqueued` cursor.
- `label_subscription_failed`, `label_ingestor_crashed`, or invalid-signature errors.
- A configured label source has `trusted = 0`, `replay_pending = 1`, a nonzero
  `health_failure_count`, or no successful catch-up within ten minutes.
- `publication_pending` is nonzero beyond the normal publication retry interval.
- The review, error, pending, or running backlog grows, or its oldest `updated_at` stops moving.
- `discovery_quarantine_events.requires_reconciliation = 1` grows or remains unresolved. Include
  `quarantine_id` and `revision` in the diagnostic output so operators can distinguish a retried
  event from a later update to the same quarantine entry.
- A `media_quarantine_objects` row remains `ready = 0` past `expires_at`, or expired evidence is
  not removed on the next scheduled purge.
- Reconciliation logs report missing outcome labels, stale runs, quarantined items, or repair
  work on consecutive cron ticks.
- `listing_projection_work.dirty_epoch` remains ahead of `acknowledged_epoch`, the active
  generation is incomplete, its policy does not match the deployment, or its source epoch
  differs from `listing_projection_control.source_epoch`.
- Active label collisions are nonzero.
- Aggregator record or backfill messages exhaust retries and reach a dead-letter queue.
- An `eval_runs` row remains `running` after the expected evaluation window or records a failed
  run.
- The live evaluation reports model errors, invalid output, expected-outcome mismatches,
  prohibited-content false negatives, a failed budget, or a changed dataset hash.

Do not include raw metadata, model prompts or responses, Access assertions, email addresses,
media bytes, or signing material in logs or alert payloads.
