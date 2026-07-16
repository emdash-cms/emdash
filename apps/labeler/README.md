# @emdash-cms/labeler

An ATProto labeler service for the emdash plugin registry, deployed as a single Cloudflare Worker. It ingests package-registry records from the ATProto firehose, runs automated moderation assessments on package releases, and emits signed ATProto labels describing each release's eligibility (passed, blocked, warned, pending, error). Consumers such as the emdash aggregator subscribe to those labels and decide what to surface and serve. A React operator console under `/admin` lets human reviewers and admins inspect assessments and act on them.

## How it fits together

```
registry records ──▶ Jetstream firehose ──▶ discovery queue ──▶ automated assessment
                                                                        │
                                                                        ▼
consumers ◀── subscribeLabels / queryLabels ◀── signed labels ◀── label store
```

The Worker consumes the registry's records from the ATProto firehose (Jetstream), enqueues discovered packages and releases, and runs an assessment pipeline over each release. Assessments produce signed labels. Consumers resolve the labeler's DID, discover its endpoint, subscribe to the label stream, verify each label's signature against the public key published in the DID document, and apply the resulting eligibility decisions.

The concepts behind all of this (DIDs, `did:web`, the DID document, labels, signing, and the XRPC surface) are explained in [docs/atproto.md](docs/atproto.md). The label vocabulary and how labels overlay into an eligibility state are in [docs/moderation-model.md](docs/moderation-model.md). Running the operator console day to day is covered in [docs/operating.md](docs/operating.md).

## Local development

Scripts are run through pnpm, filtered to this package:

```bash
pnpm --filter @emdash-cms/labeler dev           # Worker + console dev server (vite dev)
pnpm --filter @emdash-cms/labeler console:dev    # console SPA on its own vite config
pnpm --filter @emdash-cms/labeler test           # Worker + console test suites
pnpm --filter @emdash-cms/labeler typecheck      # tsgo over Worker and console
pnpm --filter @emdash-cms/labeler db:migrate:local  # apply D1 migrations to the local database
```

The console is not localized (plain English) and there is no dev auth bypass, so operator flows are exercised through real Cloudflare Access in a deployed environment.

## Deploying

The Worker checks that its signing keypair matches the public key published in its DID document the first time it signs a label — not at deploy time. `wrangler deploy` only enforces that the `LABEL_SIGNING_PRIVATE_KEY` secret exists, so a mismatched pair deploys cleanly and then fails on the first signing operation. After setting or rotating the key, exercise a signing path (a console mutation, an assessment, or a `queryLabels` re-sign) to confirm the pair is consistent. Work through the checklist in order.

1. **Create a Cloudflare Access application** covering `/admin/*` on the labeler's domain, with two Access groups (one for admins, one for reviewers) mapped to your identity provider. This produces the application's **AUD tag**.

2. **Set the operator Access config.** Put the AUD tag, your team domain, and the group names into `OPERATOR_ACCESS_CONFIG` in `wrangler.jsonc` (it ships with a `REPLACE_WITH_ACCESS_APP_AUD_TAG` placeholder):

   ```jsonc
   "OPERATOR_ACCESS_CONFIG": "{\"teamDomain\":\"https://your-team.cloudflareaccess.com\",\"audience\":\"<AUD tag>\",\"admins\":[\"emdash-labeler-admins\"],\"reviewers\":[\"emdash-labeler-reviewers\"]}"
   ```

3. **Generate the signing keypair** and install it. The keygen script prints both values in the exact formats the Worker expects; nothing is written to disk.

   ```bash
   pnpm --filter @emdash-cms/labeler keygen
   echo -n '<private key>' | wrangler secret put LABEL_SIGNING_PRIVATE_KEY
   # then set LABEL_SIGNING_PUBLIC_KEY in wrangler.jsonc to the printed public key
   ```

   Bump `LABEL_SIGNING_KEY_VERSION` if you are rotating an existing key.

4. **Run migrations** against the remote D1 database:

   ```bash
   pnpm --filter @emdash-cms/labeler db:migrate
   ```

5. **Deploy.** This builds the console and the Worker, then publishes:

   ```bash
   pnpm --filter @emdash-cms/labeler deploy
   ```

## Configuration reference

| Key                         | Kind   | Description                                                                                                         |
| --------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| `LABELER_DID`               | var    | The labeler's DID, `did:web:labels.emdashcms.com`.                                                                  |
| `LABELER_SERVICE_URL`       | var    | Service endpoint published in the DID document, `https://labels.emdashcms.com`.                                     |
| `LABEL_SIGNING_PUBLIC_KEY`  | var    | P-256 public key as a Multikey; published in the DID document's `#atproto_label` method for signature verification. |
| `LABEL_SIGNING_PRIVATE_KEY` | secret | P-256 private key (unpadded base64url of the raw 32-byte scalar) used to sign labels server-side.                   |
| `LABEL_SIGNING_KEY_VERSION` | var    | Signing key version (`v1`); bump when rotating.                                                                     |
| `OPERATOR_ACCESS_CONFIG`    | var    | JSON: `teamDomain`, `audience` (Access AUD tag), and `admins` / `reviewers` group names.                            |

The private key is declared as a required secret in `wrangler.jsonc`, so `wrangler deploy` refuses to publish if it has not been set on the target Worker.

## Documents

- [docs/atproto.md](docs/atproto.md) — ATProto foundations: DIDs, `did:web`, the DID document, labels, signing, and the XRPC surface.
- [docs/operating.md](docs/operating.md) — operator console guide: sign-in, roles, and the review and emergency workflows.
- [docs/moderation-model.md](docs/moderation-model.md) — label vocabulary and how labels evaluate into an eligibility state.
