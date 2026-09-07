# EmDash release verifier

This private Cloudflare Worker verifies untrusted plugin bundles and GitHub provenance for the delegated release service. The release-service Worker calls it through the `RELEASE_VERIFIER` service binding; it does not expose a public verification API.

Publishers should follow [Automated plugin releases](https://docs.emdashcms.com/plugins/creating-plugins/delegated-releases/). This README covers the isolated verifier boundary for contributors and operators.

## Verification boundary

The verifier receives bounded bytes and structured context from the release service. It checks:

- the package checksum against the exact uploaded gzip bytes;
- archive paths, file counts, compressed and decompressed size limits;
- the bundle's package ID and version;
- the generated manifest and declared access;
- the raw Sigstore bundle without parsing and reserialising it first;
- GitHub's public-good trust root;
- the attested repository, workflow, ref, commit, run, runner, and artifact digest; and
- the signed profile repository against the provenance source repository.

It returns a normalised verification report. It does not write release records, upload PDS blobs, evaluate publisher sessions, make approval decisions, or moderate package metadata.

Private and internal GitHub repositories use GitHub's private Sigstore root and are not supported. The verifier fails these attestations instead of accepting a weaker provenance path.

## Local development

Build the workspace packages before the first verifier typecheck:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Run the verifier checks with the following commands:

```sh
pnpm --filter @emdash-cms/release-verifier typecheck
pnpm --filter @emdash-cms/release-verifier test
pnpm --filter @emdash-cms/release-verifier build
```

Run the Worker locally through the Cloudflare Vite plugin with `pnpm --filter @emdash-cms/release-verifier dev`.

## Deployment

Deploy the verifier before the release service:

```sh
pnpm --filter @emdash-cms/release-verifier deploy
```

The production Wrangler configuration sets `workers_dev: false`. Keep the verifier private and bind it to the release service as `RELEASE_VERIFIER`.

See the [release-service operations runbook](../../docs/technical-specs/delegated-release-service-operations.md) for deployment ordering and validation. The [delegated release specification](../../docs/technical-specs/delegated-release-service.md) defines the complete provenance and publication contract.
