# EmDash delegated release Action

This experimental Action submits a URL-source package release record to an EmDash delegated release service. It requests a GitHub OpenID Connect (OIDC) token for each service call, so the workflow does not store a release-service secret.

## Workflow setup

Grant the job permission to request an OIDC token, then pass the publisher DID and generated release record to the Action:

```yaml title=".github/workflows/release.yml"
name: Release plugin

on:
  workflow_dispatch:

permissions:
  contents: read
  id-token: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - name: Build release record
        run: pnpm build:release-record --output release.json

      - name: Publish through EmDash
        id: release
        uses: emdash-cms/emdash/apps/release-action@<exact-commit>
        with:
          service-url: https://release.example.com
          publisher-did: did:web:publisher.example.com
          release-file: release.json
```

Replace the example service URL, publisher DID, build command, and exact commit with values for your publisher. Pin the Action to an exact commit while the delegated release protocol remains experimental.

On its first run, the Action writes an approval link to the job summary and waits. Open the link, sign in to the release service, and check the repository, workflow file, branch or tag, and environment reported by GitHub. After confirmation, the same Action run requests a fresh OIDC token and submits the release. Later runs from the approved workflow continue without this step.

For tag-triggered releases, choose whether the workflow may publish all version tags or only the current tag. The approval never grants authority by itself: the publisher's Atmosphere session must confirm the signed GitHub identity before the service creates a publishing policy.

The source release record must conform to `com.emdashcms.experimental.package.release`. Every package or listing-image artifact must have a checksum-bound HTTPS `url` and must not contain `blob`. The service validates and uploads those bytes to the publisher's PDS, then creates a release record whose artifact descriptors contain blobs and no source URLs. Provenance remains checksum-bound to its HTTPS source.

## Inputs

| Input                   | Required | Default        | Purpose                                                                                                   |
| ----------------------- | -------- | -------------- | --------------------------------------------------------------------------------------------------------- |
| `service-url`           | Yes      | —              | HTTPS origin of the delegated release service.                                                            |
| `publisher-did`         | Yes      | —              | DID that owns the package profile and release records.                                                    |
| `release-file`          | Yes      | —              | JSON file containing the URL-source package release record. The path must stay inside `GITHUB_WORKSPACE`. |
| `idempotency-key`       | No       | Current run ID | Stable key used to replay the same submission.                                                            |
| `poll-interval-seconds` | No       | `5`            | Delay between intent status requests.                                                                     |
| `timeout-minutes`       | No       | `30`           | Maximum time to wait for workflow approval, publication, or release approval.                             |
| `wait-for-approval`     | No       | `false`        | Continue polling when the intent reaches `awaiting_approval`.                                             |

The default idempotency key is stable across attempts of one GitHub run. Set `idempotency-key` when separate runs or jobs must replay the same submission identity.

## Outputs

| Output           | Value                                                   |
| ---------------- | ------------------------------------------------------- |
| `connection-url` | Browser URL when the workflow needs first-run approval. |
| `intent-id`      | Release intent ULID.                                    |
| `state`          | Published, terminal, or `awaiting_approval` state.      |
| `approval-url`   | Approval URL when passkey approval is required.         |
| `release-uri`    | Published AT URI.                                       |
| `release-cid`    | Published record CID.                                   |
| `reason-code`    | Stable failure reason for a terminal intent.            |

With the default `wait-for-approval: false`, an intent awaiting approval returns successfully with `state` and `approval-url` outputs. Terminal states other than `published` fail the step. Network failures, service pauses, and polling timeouts also fail with a stable client error code.
