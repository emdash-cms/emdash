# EmDash delegated release Action

This experimental Action publishes a built EmDash plugin bundle through the delegated release service. It requests a GitHub OpenID Connect (OIDC) token for each service call, so the workflow does not store a release-service secret or an AT Protocol account credential.

## Workflow setup

Generate the complete workflow from the plugin directory:

```sh
emdash-plugin release setup
```

The command creates `.github/workflows/emdash-release.yml` with pinned third-party Actions, bundle creation, GitHub provenance, and this Action. It does not push the workflow. The generated workflow currently supports public repositories because the verifier trusts GitHub's public Sigstore root.

Before the first run, create an invitation for the plugin in the publisher dashboard and add its one-time value to the repository as the `EMDASH_CONNECTION_INVITATION` Actions secret. The generated workflow passes that secret as `connection-invitation`.

Start the workflow within 30 minutes. The Action consumes the invitation, writes an approval link to the job summary, and waits. Open the link, sign in to the release service, and check the repository, workflow file, branch or tag, and environment reported by GitHub. After confirmation, the same Action run requests a fresh OIDC token and submits the release. Later runs from the approved workflow continue without an invitation.

For tag-triggered releases, choose whether the workflow may publish all version tags or only the current tag. The approval never grants authority by itself: the publisher's Atmosphere session must confirm the signed GitHub identity before the service creates a publishing policy.

The Action accepts an existing `bundle-file`, or builds `plugin-directory` with the project's installed `emdash-plugin` command. Pass the raw `bundle-path` output from `actions/attest-build-provenance` as `provenance-file`. The Action uploads both exact files to private service storage after workflow authorization. The service verifies their checksums and provenance before publishing.

`release-file` remains available for custom URL-source integrations. Do not combine it with bundle or provenance inputs.

## Inputs

| Input                   | Required         | Default        | Purpose                                                                                               |
| ----------------------- | ---------------- | -------------- | ----------------------------------------------------------------------------------------------------- |
| `service-url`           | Yes              | —              | HTTPS origin of the delegated release service.                                                        |
| `publisher-did`         | Yes              | —              | DID that owns the package profile and release records.                                                |
| `connection-invitation` | First connection | —              | Single-use invitation created by the publisher for this plugin.                                       |
| `bundle-file`           | No               | —              | Existing plugin tarball inside `GITHUB_WORKSPACE`. The Action builds `plugin-directory` when omitted. |
| `plugin-directory`      | No               | `.`            | Plugin source directory inside `GITHUB_WORKSPACE`.                                                    |
| `provenance-file`       | Conditional      | —              | Raw Sigstore bundle under `RUNNER_TEMP`; required with a bundle or plugin directory.                  |
| `release-file`          | No               | —              | Compatibility input for a URL-source release record inside `GITHUB_WORKSPACE`.                        |
| `idempotency-key`       | No               | Current run ID | Stable key used to replay the same submission.                                                        |
| `poll-interval-seconds` | No               | `5`            | Delay between intent status requests.                                                                 |
| `timeout-minutes`       | No               | `30`           | Maximum time to wait for workflow approval, publication, or release approval.                         |
| `wait-for-approval`     | No               | `false`        | Continue polling when the intent reaches `awaiting_approval`.                                         |

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
