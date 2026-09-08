# EmDash delegated release Action

This experimental Action publishes a built EmDash plugin bundle through the delegated release service. It requests a GitHub OpenID Connect (OIDC) token for each service call, so the workflow does not store a release-service secret or an AT Protocol account credential.

Follow [Automated plugin releases](https://docs.emdashcms.com/plugins/creating-plugins/delegated-releases/) for the publisher journey. This README is the Action input, output, and custom-workflow reference.

## Workflow setup

Sign in locally and generate the complete workflow from the plugin directory:

```sh
emdash-plugin login <handle-or-did>
emdash-plugin release setup
```

Before writing `.github/workflows/emdash-release.yml`, the command creates a missing package profile or adds delegated-release settings to an existing valid profile. Profile setup binds the package to the canonical GitHub repository, uses the signed-in [Atmosphere account](https://docs.emdashcms.com/plugins/creating-plugins/publishing/#your-atmosphere-account) as the initial approver, and asks whether approval is required for permission increases or every release. Run `emdash-plugin profile setup` to perform this step without changing the workflow file.

The generated workflow uses pinned third-party Actions, builds one bundle, creates GitHub provenance for the exact bundle, and calls this Action. It does not push the workflow. The generated workflow currently supports public repositories because the verifier trusts GitHub's public Sigstore root.

Before the first run, create an invitation for the plugin in the publisher dashboard and add its one-time value to the repository as the `EMDASH_CONNECTION_INVITATION` Actions secret. The generated workflow passes that secret as `connection-invitation`.

Start the workflow within 30 minutes. The Action consumes the invitation, writes an approval link to the job summary, and waits. Open the link, sign in to the release service, and check the repository, workflow file, branch or tag, and environment reported by GitHub. After confirmation, the same Action run requests a fresh OIDC token and submits the release. Later runs from the approved workflow continue without an invitation.

For tag-triggered releases, choose whether the workflow may publish all version tags or only the current tag. The approval never grants authority by itself: the publisher's Atmosphere session must confirm the signed GitHub identity before the service creates a publishing policy.

The Action accepts an existing `bundle-file`, or builds `plugin-directory` with the project's installed `emdash-plugin` command. Pass the raw `bundle-path` output from `actions/attest-build-provenance` as `provenance-file`. Before uploading either file, the Action confirms that the workflow is authorised and that the signed package profile links the same canonical repository. The service verifies the checksums and provenance before publishing.

`release-file` remains available for custom URL-source integrations. Do not combine it with bundle or provenance inputs.

## Custom workflow usage

The generated workflow is the supported starting point. A custom workflow must grant `contents: read`, `id-token: write`, and `attestations: write`. It must attest the same bundle passed to this Action.

The following step uses the bundle and provenance outputs created earlier in the job:

```yaml title=".github/workflows/emdash-release.yml"
- name: Publish plugin
  uses: emdash-cms/emdash/apps/release-action@main
  with:
    service-url: https://releases.emdashcms.com
    publisher-did: did:plc:examplepublisher
    connection-invitation: ${{ secrets.EMDASH_CONNECTION_INVITATION }}
    bundle-file: ${{ steps.bundle.outputs.path }}
    provenance-file: ${{ steps.attest.outputs.bundle-path }}
```

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

## Failure behaviour

| Code or state                                             | Meaning                                                                                                                            | Action                                                              |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `PACKAGE_PROFILE_REQUIRED`                                | The signed package profile is missing, incomplete, non-canonical, or linked to another repository. No artifact upload has started. | Run `emdash-plugin profile setup` locally, then rerun the workflow. |
| `WORKLOAD_NOT_ALLOWED`                                    | The repository, owner, workflow, ref, or environment does not match the active connection policy.                                  | Approve a new workflow connection with the intended scope.          |
| `awaiting_approval`                                       | The release needs a passkey decision. This is a successful Action result unless `wait-for-approval` is `true`.                     | Open `approval-url` or use the release dashboard.                   |
| `POLL_TIMEOUT`                                            | Workflow approval, release approval, or publication exceeded `timeout-minutes`.                                                    | Inspect the intent in the release dashboard before rerunning.       |
| `invalid`, `failed`, `rejected`, `expired`, or `conflict` | The release reached a terminal state.                                                                                              | Read `reason-code` and the release-service activity entry.          |

## Security boundary

GitHub OIDC identifies the workflow but cannot write to the publisher's PDS. The release service retains a separate OAuth grant limited to creating package release records and uploading the required blobs. It cannot write package profiles, update or delete releases, or use a GitHub OIDC token as AT Protocol authority.

The Action masks every OIDC token, requests a fresh token for each service call, constrains bundle paths to `GITHUB_WORKSPACE`, constrains provenance paths to `RUNNER_TEMP`, and sends the exact raw provenance bytes without parsing or reserialising them.
