# @emdash-cms/registry-lexicons

Generated TypeScript types and runtime validation schemas for the EmDash plugin registry lexicons.

> EXPERIMENTAL: NSIDs and shapes will change. The registry is still on the `wip/plugin-rfc` branch (RFC 0001). Pin to an exact version while we iterate. Once stable, NSIDs are expected to migrate to either `pm.fair.package.*` (if FAIR adopts the shape) or `com.emdashcms.package.*`.

## What's in here

- **TypeScript types** for every record, query, and shared definition in `lexicons/com/emdashcms/experimental/`.
- **Runtime validation schemas** built on `@atcute/lexicons`, so consumers can validate records, query params, and XRPC outputs without a separate validator.
- **NSID constants** for cases where you need the lexicon ID as a string (e.g. `putRecord`, `listRecords`).
- **Module augmentation** of `@atcute/lexicons/ambient` so `@atcute/client` callers get strong typing on these records and XRPC methods automatically.

## Usage

```ts
import { NSID, PackageProfile, PackageRelease } from "@emdash-cms/registry-lexicons";
import { is, safeParse } from "@atcute/lexicons/validations";

// Type a profile record:
const profile: PackageProfile.Main = {
	$type: NSID.packageProfile,
	id: "at://did:plc:abc123/com.emdashcms.experimental.package.profile/gallery",
	type: "emdash-plugin",
	license: "MIT",
	authors: [{ name: "Alice Example", url: "https://alice.example.com" }],
	security: [{ email: "security@example.com" }],
};

// Validate at runtime:
if (!is(PackageProfile.mainSchema, profile)) {
	throw new Error("invalid profile");
}

// Or get a Result-shaped value:
const result = safeParse(PackageRelease.mainSchema, someUntrustedInput);
if (!result.ok) {
	console.error(result.issues);
}
```

## Building

The package ships compiled JavaScript and `.d.ts` declarations from `dist/`. The build pipeline has three stages:

```sh
pnpm build
```

1. `build:lexicons` — copies the JSON files from the repo root's `lexicons/` directory into the package (so they ship with the published artifact).
2. `codegen` — invokes `@atcute/lex-cli generate` to emit TypeScript types and validation schemas under `src/generated/`.
3. `build:types` — bundles `src/` (including the generated modules) into ESM + `.d.ts` under `dist/`.

The generated TypeScript in `src/generated/` is checked into git so consumers can `pnpm install` without the codegen toolchain. CI verifies the generated output is up to date; PRs that change the source lexicons but don't regenerate will fail.

## Stability

Everything under `com.emdashcms.experimental.*` is unstable by design. The contract for this package while in `0.x`:

- New NSIDs and fields may be added in any release.
- Existing fields may have their constraints tightened or loosened in any release.
- NSIDs may be renamed at the next stable cutover (see RFC 0001's migration plan).

Once the registry is non-experimental, this package will publish a 1.0 with the post-experimental NSIDs and a stability commitment.
