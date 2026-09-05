# @emdash-cms/registry-verification

Runtime-neutral verification primitives for EmDash plugin registry records, artifacts, bundles, and provenance.

The delegated release service uses this package in both its orchestration Worker and the isolated release verifier. EmDash also repeats the relevant checks before installation, so a release does not depend on the release service remaining available.

## Public entry points

Import the narrowest entry point for the runtime doing the verification.

| Import                                       | Purpose                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `@emdash-cms/registry-verification`          | Complete API, including the default GitHub provenance verifier.                            |
| `@emdash-cms/registry-verification/bundle`   | Validate bounded plugin gzip archives and their generated manifests.                       |
| `@emdash-cms/registry-verification/artifact` | Fetch package or image artifacts from HTTPS URLs or publisher-PDS blobs.                   |
| `@emdash-cms/registry-verification/checksum` | Compute, decode, and compare supported multihashes and blob CIDs.                          |
| `@emdash-cms/registry-verification/fetch`    | Fetch a bounded HTTPS resource with redirect, timeout, size, and network-address controls. |
| `@emdash-cms/registry-verification/records`  | Inspect profile and release records with a caller-supplied provenance verifier.            |

## Release verification

`verifyPackageReleaseRecords()` verifies the complete package relationship:

- profile and release lexicon shapes;
- package, version, record-key, and profile-identity consistency;
- the canonical repository in `PackageProfileExtension`;
- the package checksum and artifact source;
- bundle limits, generated manifest, and declared access;
- the provenance predicate, artifact digest, source repository, workflow, commit, run, and GitHub trust root; and
- the publisher's provenance and confirmation policy.

`inspectPackageReleaseRecords()` performs the signed-record checks without evaluating provenance evidence. Use it only when another component supplies the provenance decision separately.

The verification package does not decide whether metadata may appear in discovery. Labellers assess publisher-controlled profile and release metadata, while artifact and provenance verification checks the downloadable plugin bytes and their origin.

## Bounded fetches

`fetchVerifiedResource()` validates HTTPS URLs, resolves and rejects private or local network addresses, handles redirects explicitly, caps response bytes, and enforces header and total timeouts. Callers can list an expected non-success status in `allowedStatuses` when they need to inspect a bounded response such as an AT Protocol `404`.

## Development

Build and test the package with the following commands:

```sh
pnpm --filter @emdash-cms/registry-verification typecheck
pnpm --filter @emdash-cms/registry-verification test
pnpm --filter @emdash-cms/registry-verification check
```

The test command validates source behavior, packed output, and the workerd-compatible entry points.

See [Automated plugin releases](https://docs.emdashcms.com/plugins/creating-plugins/delegated-releases/) for the publisher flow and the [delegated release specification](../../docs/technical-specs/delegated-release-service.md) for the complete trust contract.
