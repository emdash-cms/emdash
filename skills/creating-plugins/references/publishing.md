# Publishing sandboxed plugins

Use `@emdash-cms/plugin-cli` for registry publishing. The package profile and release records belong to the Atmosphere account named by `publisher` in `emdash-plugin.jsonc`.

## Required package metadata

Before publishing, require:

- a unique plugin `slug`;
- a publisher DID or Atmosphere handle;
- a version in `package.json` or `emdash-plugin.jsonc`;
- a license, at least one author, and at least one security contact;
- declared capabilities and allowed hosts that match the plugin implementation;
- a canonical public GitHub `repo` for delegated releases.

Run validation from the plugin directory:

```sh
pnpm exec emdash-plugin validate
```

## Local publishing

Use local publishing when the maintainer starts the release from their computer:

```sh
pnpm exec emdash-plugin login alice.example.com
pnpm exec emdash-plugin publish
```

`publish` builds and validates the bundle, uploads its files to the publisher's personal data server, and creates the package release record. Use `emdash-plugin bundle` to inspect a tarball without publishing it.

## Automated repository releases

Generate the shared workflow from one plugin package:

```sh
pnpm exec emdash-plugin release setup
```

The command prepares the current signed package profile and writes `.github/workflows/emdash-release.yml` at the Git repository root. It does not push the file. The workflow is shared by all plugin packages in that repository and requires no Actions secret.

The generated workflow publishes tags in `<slug>@<version>` form:

```sh
git tag gallery@1.2.3
git push origin gallery@1.2.3
```

The workflow runs `release prepare` through the exact plugin CLI version that generated it. The command finds exactly one `emdash-plugin.jsonc` whose slug matches the tag, requires the manifest version to match, builds that package, and writes its outputs for the provenance and release Actions. Duplicate slugs, missing packages, and version mismatches stop before attestation.

The first run uses GitHub OpenID Connect to request a repository connection. The service checks that the initiating package's signed profile names the same repository before creating the request. The publisher approves the repository, workflow file, ref scope, and environment in the release dashboard. A manual run requests approval the first time its branch is used; confirmation adds that scope without removing approved tags or branches.

Prepare another package without changing the workflow:

```sh
pnpm exec emdash-plugin profile setup --dir packages/comments
git tag comments@1.0.0
git push origin comments@1.0.0
```

The later package reuses an approved repository scope only when its signed profile names that repository. Package approvals created by older workflows remain package-scoped until an unmatched package or ref is explicitly approved as a repository connection. Release confirmation remains package-specific: `escalation-only` requires approval when declared access increases, while `always` requires approval for every release.

## Verification boundaries

The release service verifies the GitHub repository and owner IDs, workflow, ref, environment, commit, run, runner, package profile, bundle checksum, manifest identity, declared access, and raw Sigstore provenance. It accepts artifacts only after the repository workflow and signed package profile both authorize the run.

Metadata moderation and release verification are separate. Registry moderation covers displayed package metadata and media. Installation independently verifies release records, bundle checksums, and declared access.

Use the public [Automated plugin releases](https://docs.emdashcms.com/plugins/creating-plugins/delegated-releases/) guide for the complete publisher journey and troubleshooting.
