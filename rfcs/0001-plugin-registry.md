---
rfc: 0001
title: Decentralized Plugin Registry
status: Draft
authors:
  - Matt Kane (@ascorbic)
discussions:
  - https://github.com/emdash-cms/emdash/discussions/296
  - https://github.com/emdash-cms/emdash/discussions/307
created: 2026-04-21
---

# RFC: Decentralized Plugin Registry

# Summary

This RFC proposes a decentralized plugin registry for EmDash that combines the data model from the [FAIR](https://fair.pm/) package management protocol with the identity and real-time distribution graph of the [AT Protocol](https://atproto.com/).

Under this architecture:

- Authors publish metadata records to their own atproto repositories (PDS).
- Plugin bundles (`.tar.gz` archives) are hosted by the author anywhere on the web.
- EmDash aggregators subscribe to the atproto firehose to index these records and provide fast search APIs.
- EmDash CMS installations verify plugin integrity via cryptographic signatures natively provided by atproto.

This v1 registry is exclusively for **sandboxed plugins** — those running in isolated Worker sandboxes with declared capability manifests.

Because the sandbox provides safety assurance, the registry's primary goal is to prove _provenance_: authors retain full ownership of their distribution without relying on a centralized authority. Native plugins (npm-distributed) remain out of scope for v1.

# Example

A plugin author publishes a sandboxed plugin:

```bash
# Authenticate with your Atmosphere account
$ emdash plugin login
# Opens OAuth flow in browser, stores credentials locally

# Scaffold a new plugin project
$ emdash plugin init
# Creates a manifest.json with prompts for name, description, etc.

# Publish a release with an already-hosted artifact
$ emdash plugin publish --url https://github.com/example/gallery/releases/download/v1.0.0/gallery-plugin-1.0.0.tar.gz
# Fetches the bundle to compute the hash, creates a pm.fair.package.profile record
# on first publish, then creates a pm.fair.package.release record carrying EmDash
# extension data (capabilities, allowed hosts) under the com.emdashcms.* namespace.
```

A CMS user installs the plugin from the admin UI: they search the registry, pick a plugin, and install it with a click. The package record is stored in the author's own atproto repository, signed by their keys, and indexed by an aggregator for discovery.

# Background & Motivation

Centralised plugin registries create single points of failure, control and trust. When one organisation controls the registry, they control the supply chain. We've seen this play out repeatedly:

- The WordPress ecosystem's dependency on WordPress.org and the governance disputes that led to FAIR.
- npm's `left-pad` incident, where a single package removal broke thousands of builds.
- RubyGems, PyPI and other registries where a compromised account can push malicious updates to thousands of consumers.

In all of these cases, the root problem is the same: a central registry that conflates identity, hosting, discovery and trust into a single service under a single operator's control.

We want a plugin ecosystem where:

- Authors own their identity and their package metadata. It lives in their own repository, signed by their own keys, and is portable if they move providers.
- Anyone can host artifacts. There is no requirement to upload to a blessed server.
- Anyone can run a directory. Multiple competing directories can index the same package data with different curation, moderation and presentation.
- No single point of failure. If the primary aggregator goes down, plugins can still be resolved directly from the author's Personal Data Server.
- Trust signals (security audits, SBOM verification, vulnerability disclosure, publisher verification) are layered on top of the registry by independent labellers, not baked into the protocol.

Two existing protocols solve overlapping pieces of this problem:

- **[FAIR](https://fair.pm/)** is a Linux-Foundation-backed federated package protocol, originally targeted at the WordPress ecosystem and now also serving TYPO3. FAIR provides identity (W3C DIDs), signing, the aggregator/labeller architecture, mirror semantics, and a trust model with a site-side policy engine. FAIR's protocol is intentionally designed for any digital goods, not exclusively software, and is built around an HTTP repository API that any host (including a static host like GitHub Pages) can serve.
- **atproto** provides DID-anchored identity, signed repository data, real-time event distribution via a global firehose, a labeller architecture (Ozone) that FAIR has explicitly aligned with, and a mature developer ecosystem with reference implementations and tooling across many languages.

The two protocols are fundamentally aligned in philosophy, and increasingly aligned in architecture. FAIR has adopted atproto-style schema evolution rules (FAIR PR #79), utilizes atproto's `did:plc` natively, and is exploring the use of Ozone for labelers (FAIR #49). FAIR's protocol design explicitly cites atproto's aggregator pattern as inspiration.

This RFC therefore proposes that EmDash plugins be published using **FAIR package schemas over an atproto transport**. FAIR's protocol provides the package and release record shape, the trust model, and the mirror semantics; atproto provides the publishing transport, identity substrate, and firehose discovery. EmDash-specific concerns (capability declarations, sandbox bundle format, runtime distinction) live in a `com.emdashcms.*` extension.

Crucially, because EmDash has no installed base of FAIR-published packages, publishers use a single Publisher DID (their atproto identity) and the AT URI of each record as the package identity. This eliminates FAIR's legacy requirement of registering a separate DID for every individual package. See [Relationship to FAIR](#relationship-to-fair) for details.

# Goals

- **Zero-infrastructure publishing.** A plugin author needs only an Atmosphere account (their atproto identity) and a URL where they host their bundle artifact. Any Atmosphere account provider can be used: e.g. Bluesky, Tangled, npmx. No separate FAIR repository server is needed.
- **One identity for everything.** The author's atproto DID is their FAIR Publisher DID, their atproto signing identity, and the trust root for every package they publish. One key, one document, one account.
- **Decentralised discovery.** Aggregators subscribe to the atproto firehose for `pm.fair.package.*` records and build their own index. Anyone can run an aggregator. EmDash sites can talk to any FAIR-compatible aggregator.
- **Near-real-time updates.** Publishing a record propagates through the firehose with seconds-level latency under normal conditions, with occasional minutes-level lag during relay incidents. New releases reach aggregators (and from there, sites) without crawl-cycle delays. Deprecation and yank signals — applied via labellers in FAIR's trust model — propagate through the same channel.
- **Cryptographic integrity.** Every record is signed as part of the author's atproto repository (transitive MST signing). Artifact integrity is verified via multibase checksums on each artifact, signed transitively by the publisher's identity.
- **Portability.** Authors can migrate their atproto account between PDSes without losing their packages. The DID and all package records move with them; aggregators re-resolve and continue indexing.
- **Cross-ecosystem trust signals.** A labeller built for FAIR — security audit, SBOM verification, CRA compliance, publisher verification — works for EmDash plugins without modification, because labels are the same atproto-compatible records FAIR already specifies. EmDash operates its own publisher verification on top of this (see [Publisher Verification](#publisher-verification)).
- **Replace the existing centralised marketplace.** This RFC is not additive: it fully replaces EmDash's current first-party marketplace mechanism in a single rollout. See [For existing marketplace installs](#for-existing-marketplace-installs) for the migration plan.

# Non-Goals

- **Replacing atproto infrastructure.** We do not build or run a PDS, relay, or DID directory. We use existing atproto infrastructure.
- **Supporting non-atproto FAIR transports.** EmDash publishers do not publish to FAIR HTTP repositories. The atproto transport is the only publishing surface EmDash uses. FAIR aggregators that subscribe to the atproto firehose index EmDash records natively (a firehose-aware FAIR aggregator and an atproto AppView are the same thing under different names); aggregators that only support HTTP-polling will not see EmDash plugins, which is fine for v1. We do not specify or build a bridge between the two transports.
- **Forking FAIR.** Where this RFC adopts FAIR's protocol shape (record fields, trust model, labeller architecture, extension mechanism), it does so as-specified, with contributions back where the shape needs to extend (notably the lexicon definitions for an atproto transport and the Publisher-Trust-without-per-package-DID mode). EmDash's design does not require FAIR to accept these contributions; see [Relationship to FAIR](#relationship-to-fair).
- **Mandating a specific artifact host.** Authors choose where to host their bundle artifacts. The aggregator may mirror artifacts it indexes, as FAIR's protocol already permits.
- **Trust and moderation primitives in v1.** Reviews, reports, and the specific labellers EmDash trusts by default are planned but specified in a follow-on RFC. The protocol substrate (FAIR's labeller architecture, atproto-compatible signed labels via Ozone) is established here only by reference.
- **Supporting private/authenticated packages in v1.** Paid and private plugins are a future extension. FAIR has draft support for commercial packages and authentication; we follow that work rather than reinvent it.
- **Inter-plugin dependency resolution in v1.** FAIR's `requires`/`suggests` mechanism handles host-version constraints (`env:emdash`, `env:astro`); per-plugin peer declarations are deferred to a follow-on RFC.
- **Native plugins.** The v1 registry covers sandboxed plugins exclusively. Native plugins (npm-distributed Astro integrations with full platform access) continue to be installed via `npm install` and configured in `astro.config.mjs`. They are not indexed by the aggregator, not surfaced in the admin UI's install flow, and have no records in this registry.

  This RFC does not specify how native plugins are discovered or how they integrate with the trust layer; see [Future support for native plugins](#future-support-for-native-plugins) for what a follow-on RFC would address and why we've deferred it.

# Relationship to FAIR

The registry described in this RFC borrows heavily from the [FAIR](https://fair.pm/) protocol's data model and trust architecture, but implements them over an atproto transport rather than HTTP.

EmDash plugins are structured as FAIR packages with a `com.emdashcms.*` extension that defines EmDash-specific concerns (sandbox capabilities, bundle conventions).

### Shared Concepts

- **Data Model:** The schema for package profiles and releases matches FAIR's definitions (including fields, CRA compliance metadata, and mirror semantics).
- **Identity:** EmDash uses W3C DIDs (specifically `did:plc` and `did:web`), which are supported by both atproto and FAIR.
- **Trust Architecture:** EmDash adopts FAIR's aggregator and labeler architecture (which FAIR is aligning with Bluesky's Ozone).

### Points of Divergence

- **Transport and Discovery:** EmDash does not use FAIR's HTTP repository API. Records are distributed via the atproto firehose and indexed by aggregators.
- **Record Structure:** FAIR embeds all releases inside a single Metadata Document. To optimize for the firehose, EmDash separates these into discrete `package.profile` and `package.release` records co-located in the publisher's repository; clients enumerate releases by listing the release collection on the PDS rather than following a HAL link.
- **Signing:** EmDash relies entirely on atproto's repo-level Merkle Search Tree (MST) signatures. It does not require or use the separate per-artifact `signature` field defined in FAIR Core.
- **Package Identity:** FAIR typically requires a unique DID for every package. EmDash uses a "Publisher-Trust" model where the AT URI (e.g., `at://<publisher-did>/.../<slug>`) serves as the unique package identifier, eliminating the need for per-package DIDs.

### Lexicon Namespaces

Because atproto requires lexicons (schemas), EmDash drafts these definitions under the `pm.fair.*` namespace as a proposed contribution to the FAIR project to formalize an atproto transport.

If FAIR does not adopt these lexicons, EmDash will publish the identical schemas under the `com.emdashcms.package.*` namespace and register them in FAIR's extension registry. The technical implementation remains identical in either case.

A separate question is whether FAIR formalises AT URIs as permitted `id` values for the atproto transport. If FAIR accepts that proposal, EmDash records are consumable by any FAIR client. If FAIR keeps `id` as DID-only, EmDash records cannot be served verbatim through FAIR's HTTP transport without an aggregator-side translation step that mints a derived DID per package. We treat this as a FAIR-side decision; for the EmDash registry's own purposes the AT URI is sufficient identity.

# Future support for native plugins

Native plugins (npm-distributed Astro integrations that run in the host process with full platform access) are an important part of EmDash's ecosystem, but are explicitly out of scope for this v1 registry.

They are deferred because their trust and distribution models differ sharply from sandboxed plugins:

1. **Trust:** Native plugins require full platform privileges. Displaying them alongside sandboxed plugins in an automated "one-click install" UI risks conflating provenance with safety.
2. **Distribution:** Native plugins point to npm tarballs, introducing external concerns (`package.json` ownership, lockfile pinning, and `dist.integrity`) that the current FAIR/atproto registry design was not built to handle.
3. **UX:** The primary value of this registry is automated installation. Because native plugins require running `npm install` and manually editing `astro.config.mjs`, they do not benefit from this automated flow.

The status quo for native plugins remains unchanged: they continue to be distributed via npm, discovered through documentation, and installed manually. Integrating them into the decentralized registry will be addressed in a follow-on RFC once the trust framing and npm-as-artifact-source patterns stabilize.

# Prior Art

## FAIR Package Manager

[FAIR](https://fair.pm/) (Federated And Independent Repositories) is a decentralised package manager originating in the WordPress ecosystem and supported by the Linux Foundation. It uses W3C DIDs (both `did:web` and `did:plc`) as package identifiers and defines an HTTP-level repository API that can be served from a dedicated server or a static host such as GitHub.

FAIR validates the general approach of decentralised package identity. EmDash differs principally in how metadata moves through the network:

|                       | FAIR                                                                                           | This proposal                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Identity model        | One DID per package; publisher keys registered on the package DID document                     | One DID per author, multiple packages per account                                            |
| Metadata transport    | HTTP repository API, servable from any static host                                             | atproto records in the author's repo, distributed via the firehose                           |
| Author infrastructure | Any host that can serve the repository API; CLI tooling automates setup                        | An Atmosphere account (hosted or self-hosted PDS)                                            |
| Discovery             | Aggregators (e.g. AspireCloud) index known repositories                                        | Aggregator subscribes to the relay firehose                                                  |
| Signing               | Publisher signing keys registered as verification methods on the DID document                  | Repo-level signing (records are signed as part of the MST)                                   |
| Ratings, reviews, etc | Not in the base protocol; addressed via the labeller layer                                     | Deferred to follow-on RFCs, via labeller or new rating/review lexicons                       |
| Artifact hosting      | Served from the repository host                                                                | Author hosts the artifact anywhere; URL + multibase checksum on each release artifact        |
| Trust model           | Light base protocol; code scanning and gating live in labellers with a site-side policy engine | Same pattern: permissive protocol, labeller-attached trust signals, site-decided enforcement |

## npm, crates.io, PyPI

Traditional centralised registries. Authors publish to a single server that handles storage, discovery, identity and trust. The model works well at scale but concentrates control and creates supply chain risk. Our design separates these concerns across independent infrastructure.

## Community Origins

This RFC synthesizes and formalizes two major architectural proposals from the EmDash community:

- **[#307](https://github.com/emdash-cms/emdash/discussions/307)** (@erlend-sh) introduced FAIR as a model for decentralized package management, noting the shared use of DIDs as a bridge to the atproto stack.
- **[#296](https://github.com/emdash-cms/emdash/discussions/296#discussioncomment-16534494)** (@BenjaminPrice) laid out the foundational trust model for a decentralized marketplace. This RFC adopts its core tenets: _the sandbox proves safety while signing proves provenance_, author-hosted artifacts are verified by integrity hashes, and zero-friction reviews are anchored to auto-generated site identities.

# Detailed Design

## AT Protocol Primer

This proposal builds on the [AT Protocol](https://atproto.com/guides/overview) ("atproto"), the decentralised social publishing protocol originally developed at Twitter. It is now primarily used to power the social network Bluesky, which also leads protocol development. It is also used for third-party services such as [Tangled](https://tangled.org/) (Git hosting), [Leaflet](https://leaflet.pub) (blogging) and [Streamplace](https://stream.place/) (live streaming). Here are the key concepts used throughout this document:

- **[Atmosphere account](https://atmosphereaccount.com/)** — A portable digital identity on the atproto network. One account works across all Atmosphere apps (Bluesky, Tangled, Leaflet, etc.) and is hosted by a provider the user chooses — an app like Bluesky, an independent host, or self-hosted infrastructure. The account can move between providers without losing data or identity. When this document refers to an "Atmosphere account", it means any account on an atproto-compatible host.

- **[DID](https://atproto.com/specs/did)** (Decentralized Identifier) — A permanent, globally unique identifier for an account (e.g. `did:plc:ewvi7nxzyoun6zhxrhs64oiz`). Defined as a W3C standard. DIDs resolve to documents containing the account's cryptographic keys and hosting location. Think of them like a portable UUID that also tells you where to find the account's data. FAIR also uses DIDs as package identifiers.

- **[Handle](https://atproto.com/specs/handle)** — A human-readable domain name mapped to a DID (e.g. `cloudflare.social` or `jay.bsky.team`). Domain ownership is verified via DNS or `.well-known` files. Handles are mutable — you can change yours — but your DID stays the same.

- **[PDS](https://atproto.com/guides/overview#personal-data-server-pds)** (Personal Data Server) — The server that hosts a user's data, and where a user signs up for an account. Bluesky runs PDSs for its users, but anyone can run their own and they are all interoperable. Other services that provide PDSs include [npmx](https://npmx.social), [Blacksky](https://blackskyweb.xyz/) and [Eurosky](https://eurosky.tech/). [Cirrus](https://github.com/ascorbic/cirrus/) lets you self-host a PDS in a Cloudflare Worker. If your PDS disappears, you can migrate to a new one because your identity is rooted in your DID, not in the server.

- **[Repository](https://atproto.com/specs/repository)** — A user's public dataset, stored as a signed Merkle Search Tree (MST) in their PDS. Every record in a repo is covered by the tree's cryptographic signature, so you can verify that any record really was published by the account's owner.

- **[Lexicon](https://atproto.com/specs/lexicon)** — A schema language for describing record types and APIs, similar to JSON Schema. Applications define lexicons to declare the shape of data they read and write. Lexicons are identified by NSIDs (Namespaced Identifiers) in reverse-DNS format, e.g. `site.standard.document` or `app.bsky.feed.post`.

- **[AT URI](https://atproto.com/specs/at-uri-scheme)** — A URI scheme for referencing specific records: `at://<did>/<collection>/<rkey>`. For example, `at://did:plc:abc123/pm.fair.package.profile/gallery-plugin`.

- **[Relay and Firehose](https://atproto.com/specs/sync)** — Relays aggregate data from many PDSes into a single event stream (the "firehose"). Any service can subscribe to the firehose to receive real-time notifications of record creates, updates and deletes across the entire network. Bluesky operates public relay infrastructure, and third-party relays exist as well.

- **[AppView](https://atproto.com/guides/overview)** — In atproto vocabulary: a service that subscribes to the firehose, indexes records it cares about, and serves an API for clients. Think of it like a specialised search engine and API for a particular type of atproto data. Unlike most other atproto services, an AppView is not generic; it is custom-built for a particular service where it implements the business logic of that app. Bluesky runs one AppView, as do third-party services such as [Leaflet](https://leaflet.pub/) or [Streamplace](https://stream.place/). This RFC uses the more general term **aggregator** for the equivalent role in the registry, both because that's FAIR's term for the same role and because it doesn't require atproto familiarity to read. The reference EmDash aggregator is implemented as an atproto AppView.

- **[Labeller](https://atproto.com/specs/label)** — A service that publishes signed labels about records or accounts (e.g. "verified", "spam", "nsfw"). Labels are a lightweight moderation primitive that can be consumed by aggregators and clients.

## Plugin Types

EmDash supports both _sandboxed_ and _native_ plugins. **The v1 registry covers sandboxed plugins exclusively;** native plugins continue to be installed via npm and are out of scope for this RFC. See [Future support for native plugins](#future-support-for-native-plugins) for the rationale.

### Sandboxed plugins

Sandboxed plugins run in isolated sandboxes. The default sandbox is implemented via Cloudflare Dynamic Workers. Their bundle manifest declares exactly what resources they can access, including capabilities such as `read:content` and `email:send`. They can be installed at runtime from the admin UI — no CLI, no build step, no restart required.

```js
export default () =>
	definePlugin({
		id: "notify-on-publish",
		capabilities: ["read:content", "email:send"],
		hooks: {
			"content:afterSave": async (event, ctx) => {
				/* ... */
			},
		},
	});
```

For sandboxed plugins, the registry is the **complete distribution channel**: discovery → download → verify → install, all automated.

## Architecture Overview

```mermaid
graph TD
    subgraph Authors
        A1["Plugin Author A<br/>(PDS: any)"]
        A2["Plugin Author B<br/>(PDS: any)"]
        A3["Plugin Author C<br/>(PDS: any)"]
    end

    R["Relay<br/>(firehose)"]
    T["Tap<br/>(filtered sync layer)"]

    A1 --> R
    A2 --> R
    A3 --> R
    R --> T

    subgraph Consumers
        AV["Aggregator<br/>(default)<br/>API Worker"]
        MIR["Aggregator mirror<br/>(object store + CDN Worker)"]
        H1["Host A<br/>Own directory"]
        H2["Host B<br/>Own Aggregator"]
    end

    T --> AV
    R --> H2
    AV <--> MIR

    subgraph "Author-declared artifact sources"
        GH["GitHub Releases"]
        S3["R2 / S3 / CDN"]
        OWN["Own server"]
    end

    A1 -.->|"hosts bundle"| GH
    A2 -.->|"hosts bundle"| S3
    A3 -.->|"hosts bundle"| OWN

    MIR -.->|"mirrors bundles<br/>(fetched, verified, cached)"| GH
    MIR -.->|"mirrors bundles"| S3
    MIR -.->|"mirrors bundles"| OWN

    H1 -.->|"reads"| AV
```

**Authors** publish `package` and `release` records to their own PDS via standard atproto APIs. EmDash will provide a CLI command to do this, so plugin authors don't need to use the APIs directly. Bundle tarballs are hosted by the author wherever they choose.

**The relay** broadcasts all record operations via the firehose. This is existing atproto infrastructure — we do not run it.

**Aggregators** subscribe to the firehose, filter for our lexicon namespace, and build a searchable index. We run the default aggregator and publish an open source reference implementation; anyone else can run their own. The reference aggregator is implemented as an atproto AppView (see the [Primer](#at-protocol-primer)); the term "aggregator" is FAIR's, and the two communities mean the same thing by it once a FAIR aggregator gains firehose support. Once existing FAIR aggregators (e.g. AspireCloud) gain firehose support they will index EmDash records natively without any intermediary.

**EmDash clients** are built into the dashboard. They query an aggregator for discovery and can also resolve packages directly from an author's PDS, so the system degrades gracefully — if the aggregator is down, known packages can still be installed.

## Lexicons

The lexicons defined here mirror [FAIR's Metadata, Release, and Repository Documents](https://github.com/fairpm/fair-protocol/blob/main/specification.md) — same value types, same constraints, same semantics — translated from JSON-LD HTTP documents into atproto records. Field names are normalized to atproto's `lowerCamelCase` style guide rather than copied verbatim from FAIR's kebab-case / snake_case spec; an aggregator translating between transports applies a fixed name mapping at the boundary. See the [Field naming](#field-naming) callout below for details.

> **Namespace status.** This draft uses `pm.fair.*` for FAIR's core records, on the assumption that FAIR will adopt these definitions as part of formalising an atproto transport. If FAIR doesn't bless the `pm.fair.*` lexicons, EmDash publishes the package and release shapes under `com.emdashcms.package.*` and registers them in FAIR's extension registry as the canonical EmDash package types. Under that fallback the EmDash-specific data (capabilities, allowed hosts) moves to top-level fields on `com.emdashcms.package.release` rather than being nested in an `extensions` envelope — there is no point wrapping EmDash data in an extension when EmDash already owns the entire record schema. The field shape and semantics are otherwise identical. See [Relationship to FAIR](#relationship-to-fair).

The namespace split has two layers:

- **`pm.fair.*`** (or `com.emdashcms.package.*` under the fallback) — package identity, release artifacts, signing, mirrors, integrity. Tracks FAIR's spec semantics; field names follow atproto style (see the [Field naming](#field-naming) callout).
- **`com.emdashcms.*`** — EmDash-specific extension data: capability declarations, allowed hosts, compatibility constraints, bundle conventions, EmDash-defined artifact types. Attached to FAIR records via FAIR's extension mechanism.

### Structural translation: HTTP document → atproto records

FAIR's spec describes a Metadata Document with `releases` embedded inline as a list. atproto records are independent and addressed by AT URI. Embedding hundreds of releases inside a single record would mean every new release rewrites and re-emits the whole package record through the firehose. We diverge from FAIR's HTTP shape on this one axis, while preserving the field semantics:

- **`pm.fair.package.profile`** is the atproto-record form of FAIR's Metadata Document. It carries every required and optional Metadata Document property except `releases`. Releases are independent records in the same repository under the `pm.fair.package.release` collection; clients enumerate them by listing that collection on the publisher's PDS (or by querying an aggregator).
- **`pm.fair.package.release`** is the atproto-record form of FAIR's standalone Release Document. Each release is an independent record, addressed by AT URI, with its `version` as the record key.

This structural separation optimizes for the firehose, but preserves semantic compatibility with FAIR. An aggregator that exposes these atproto records via FAIR's current HTTP API enumerates releases on the publisher's PDS and inlines the resulting documents at serving time, producing a FAIR-spec-compliant JSON Metadata Document. An aggregator that subscribes to the firehose receives package and release events independently, which is the natural shape for atproto-native consumption.

This is the only structural divergence from FAIR's spec. Field types, validation rules, and semantic meanings are FAIR's; the names follow atproto convention.

#### Field naming

Field names in this RFC follow atproto's `lowerCamelCase` [Lexicon Style Guide](https://atproto.com/guides/lexicon-style-guide). FAIR's HTTP transport uses kebab-case (`content-type`) and snake_case (`last_updated`) variants of the same fields. An aggregator translating between the two transports applies a fixed name mapping at the boundary; the underlying values and semantics are identical. Cross-transport ref relationships that FAIR expresses as HAL `_links` (`https://fair.pm/rel/repo`, `https://fair.pm/rel/package`) are expressed here as named ref fields (`repo`, parent collection lookup) and synthesised back into HAL by the aggregator when serving FAIR HTTP. We choose atproto-native style because lossless round-tripping is symmetric — kebab/snake/HAL can be synthesised at the FAIR boundary just as easily as camelCase can be — and because atproto consumers (which is everyone reading these records natively) benefit from style-guide-conformant lexicons.

### `pm.fair.package.profile`

The atproto-record form of FAIR's [Metadata Document](https://github.com/fairpm/fair-protocol/blob/main/specification.md#metadata-document). Stored in the author's repo with the slug as the record key:

```
at://did:plc:abc123/pm.fair.package.profile/gallery-plugin
```

Or, using a handle:

```
at://example.dev/pm.fair.package.profile/gallery-plugin
```

**Schema** (matches FAIR Metadata Document):

| Property      | Type      | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------- | --------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | string    | yes      | Canonical identifier of this package. For HTTP-published packages this is a DID, per FAIR's current spec. For atproto-published packages, this is the package record's AT URI (e.g. `at://did:plc:abc123/pm.fair.package.profile/gallery-plugin`) — the AT URI plays the role FAIR's spec assigns to a per-package DID in the atproto transport. The value is **derived from the record's location**, not authored by the publisher; the CLI fills it in at publish time. Aggregators MUST construct the expected AT URI as `at://{repo-did}/{collection}/{rkey}` from the firehose event's repo, collection, and rkey fields (or the AT URI used to fetch the record over HTTP), MUST compare it against `record.id`, and MUST reject the record at ingest if they disagree. Clients MUST perform the same check against the identifier they used to look up the record (matching FAIR's existing rule). The proposal that FAIR formalises AT URIs as a permitted identifier under the atproto transport is part of the upstream contribution described in [Relationship to FAIR](#relationship-to-fair). |
| `type`        | string    | yes      | Package type, from FAIR's [type registry](https://github.com/fairpm/fair-protocol/blob/main/registry.md#package-types). EmDash plugins use `emdash-plugin`. Custom types use `x-` prefix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `license`     | string    | yes      | SPDX license expression, or `"proprietary"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `authors`     | Author[]  | yes      | At least one author. See [Author object](#author-object).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `security`    | Contact[] | yes      | At least one security contact. See [Contact object](#contact-object). FAIR requires this; clients should refuse to install a package without one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `slug`        | string    | no       | URL-safe slug. Grammar: an ASCII letter (`A-Z` / `a-z`) followed by ASCII letters, digits, `-`, or `_` (matching FAIR's `ALPHA` followed by `ALPHA` / `DIGIT` / `-` / `_`). If present, MUST equal the record key. Aggregators MUST reject records where `slug` is present and disagrees with the rkey. If absent, clients use the rkey as the display slug.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `name`        | string    | no       | Human-readable name. Displayed in listings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `description` | string    | no       | Short description. SHOULD NOT exceed 140 characters.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `keywords`    | string[]  | no       | Search keywords. SHOULD NOT exceed 5 items.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `sections`    | object    | no       | Map of human-readable text sections. FAIR-recognised keys: `description`, `installation`, `faq`, `changelog`, `security`. May contain HTML; clients MUST sanitise before rendering.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `lastUpdated` | string    | no       | RFC 3339 / ISO 8601 datetime for the package's last update (atproto lexicon `format: "datetime"`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

#### Author object

(FAIR Metadata Document `authors` items.)

| Property | Type         | Required |
| -------- | ------------ | -------- |
| `name`   | string       | yes      |
| `url`    | string (uri) | no       |
| `email`  | string       | no       |

Vendors SHOULD specify at least one of `url` or `email` per author.

#### Contact object

(FAIR Metadata Document `security` items.)

| Property | Type         | Required |
| -------- | ------------ | -------- |
| `url`    | string (uri) | no       |
| `email`  | string       | no       |

Vendors SHOULD specify at least one of `url` or `email` per contact. Clients SHOULD refuse to install packages without at least one valid security contact.

**Identity, mutability, and trust**

- The canonical package reference is the package record's AT URI, e.g. `at://did:plc:abc123/pm.fair.package.profile/gallery-plugin`.
- The atproto identity (the publisher's DID) is the trust root. Records are MST-signed by the publisher's signing key; aggregators verify against the publisher's DID document. There is no per-package DID — the AT URI is the package identifier.
- Handles are mutable; DIDs are not. Clients should re-resolve handles each time they display a package, rather than caching the handle string.
- The package record is mutable in atproto terms (updates flow through the firehose). Slug, however, is effectively immutable because it is the record key.
- The registry is permissive about what records an author can publish. Trust signals — verified-publisher labels, etc. — are layered on via labellers, as in FAIR's trust model.

**Runtime plugin identity** is separate from registry identity. EmDash's runtime uses `manifest.json`'s `id` field for storage namespacing and hook registration; the registry uses the AT URI. EmDash persists a mapping at install time so the two stay reconciled.

### `pm.fair.package.release`

The atproto-record form of FAIR's [Release Document](https://github.com/fairpm/fair-protocol/blob/main/specification.md#release-document). The record key is the version string, so a release's AT URI is e.g. `at://did:plc:abc123/pm.fair.package.release/1.2.0`. FAIR specifies version immutability: a release at a given version cannot be modified or replaced once published.

**Schema** (matches FAIR Release Document):

| Property     | Type   | Required                     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------ | ------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`    | string | yes                          | Version, conforming to FAIR's version syntax (semver-compatible). MUST match the record's rkey. atproto [Record Keys](https://atproto.com/specs/record-key) restrict allowed characters; semver characters not permitted in an rkey (notably `+` for build metadata) MUST be percent-encoded in the rkey, with the unencoded form recorded in `version`. The CLI handles this transparently and aggregators MUST verify both forms are consistent. |
| `artifacts`  | object | yes                          | Map of artifact type to artifact object (or list of artifact objects). MUST have at least one entry. See [Artifacts](#artifacts).                                                                                                                                                                                                                                                                                                                  |
| `provides`   | object | no                           | Capabilities the package provides. Map of capability type to string or list of strings.                                                                                                                                                                                                                                                                                                                                                            |
| `requires`   | object | no                           | Dependencies. Map of `env:*` keys (extension-defined environment requirements) or package DIDs to version constraint strings. EmDash uses `env:emdash` and `env:astro`.                                                                                                                                                                                                                                                                            |
| `suggests`   | object | no                           | Optional packages that may be installed alongside. Same shape as `requires`.                                                                                                                                                                                                                                                                                                                                                                       |
| `auth`       | object | no                           | Authentication requirements (FAIR's commercial / private packages). Out of scope for v1 EmDash use, but the field is reserved.                                                                                                                                                                                                                                                                                                                     |
| `sbom`       | Sbom   | no                           | Software bill of materials reference. See [SBOM](#sbom).                                                                                                                                                                                                                                                                                                                                                                                           |
| `repo`       | string | no                           | AT URI or HTTPS URL of the source repository for this release (atproto lexicon `format: "uri"`). Equivalent to FAIR's `https://fair.pm/rel/repo` HAL relation.                                                                                                                                                                                                                                                                                     |
| `extensions` | object | no (yes for `emdash-plugin`) | Open-union container for extension data, keyed by NSID. Each value is an embedded record carrying its own `$type` discriminator. Releases of type `emdash-plugin` MUST include a `com.emdashcms.package.releaseExtension` entry here. See [EmDash extension](#emdash-extension).                                                                                                                                                                   |

The release record references its parent package implicitly: the record's location (`at://<publisher-did>/pm.fair.package.release/<version>`) gives the publisher DID, and clients pair a release with its package by listing the `pm.fair.package.profile` collection in the same repository. Releases do not carry a separate parent-package reference field — the package profile and its releases are co-located in the publisher's repo by construction. (When serving these through FAIR HTTP, an aggregator synthesises the `https://fair.pm/rel/package` HAL relationship pointing at the corresponding profile document.)

#### Artifacts

The `artifacts` map keys are artifact types (FAIR-defined or extension-defined). Values are objects (or lists of objects) with the following common properties. Field names follow atproto's `lowerCamelCase` style guide; the FAIR HTTP transport's kebab-case names (`content-type`, `requires-auth`, `release-asset`) translate to these by mechanical mapping at the aggregator boundary.

| Property       | Type    | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | string  | no       | Unique ID within the artifact type.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `contentType`  | string  | no       | MIME type of the artifact, per [RFC6838](https://datatracker.ietf.org/doc/html/rfc6838). FAIR HTTP equivalent: `content-type`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `requiresAuth` | boolean | no       | Whether the artifact requires authentication to access. FAIR HTTP equivalent: `requires-auth`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `releaseAsset` | boolean | no       | Whether the URL points to a platform release asset rather than a directly-served file (per recently-merged [FAIR PR #83](https://github.com/fairpm/fair-protocol/pull/83)). FAIR HTTP equivalent: `release-asset`.                                                                                                                                                                                                                                                                                                                                                                                            |
| `url`          | string  | no       | URL where the artifact can be downloaded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `signature`    | string  | no       | Optional cryptographic signature of the artifact. Retained for strict FAIR compatibility, but EmDash clients do not require it as integrity is proven via the atproto MST signature over the record's `checksum`.                                                                                                                                                                                                                                                                                                                                                                                             |
| `checksum`     | string  | no       | Checksum of the artifact in [multibase](https://github.com/multiformats/multibase)-encoded [multihash](https://github.com/multiformats/multihash) format (per proposed [FAIR PR #82](https://github.com/fairpm/fair-protocol/pull/82)). EmDash clients MUST support `sha2-256` (multihash code `0x12`) and SHOULD support `sha2-512` (`0x13`) and `blake3` (`0x1e`). The base prefix character is part of the value (we recommend `base32`, prefix `b`, for compactness and case-insensitivity). Clients reject artifacts whose checksum uses an unsupported hash function rather than skipping verification. |

The standard `package` artifact type is the primary installable. EmDash extension artifact types are documented in [EmDash extension](#emdash-extension).

#### SBOM

| Property   | Type         | Required | Description                                                                                |
| ---------- | ------------ | -------- | ------------------------------------------------------------------------------------------ |
| `format`   | string       | no       | `"cyclonedx"` or `"spdx"`.                                                                 |
| `url`      | string (uri) | no       | URL where the SBOM document can be fetched.                                                |
| `checksum` | string       | no       | Multibase checksum of the SBOM document, verifiable via the same trust chain as artifacts. |

Per FAIR PR #78. EmDash plugins SHOULD include `sbom` for CRA-readiness; clients MUST NOT refuse install solely because `sbom` is absent.

### EmDash extension

Registered with FAIR's extension registry as the `emdash-plugin` package type and associated artifact types. Per FAIR's extension model (see `ext-wp.md` and `ext-typo3.md`), this extension defines:

**Package type**: `emdash-plugin` — a sandboxed EmDash plugin.

**Environment requirements** (for use in `requires` / `suggests`):

- `env:emdash` — semver range the EmDash runtime must satisfy.
- `env:astro` — semver range the Astro framework must satisfy.

**Artifact types** for `emdash-plugin`:

| Type         | Description                                                                                                                                                                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package`    | The installable plugin bundle. MUST be a gzipped tar archive (`application/gzip`), MUST be ≤ 50 MB, MUST contain `manifest.json` and `backend.js` at the archive root, MAY contain `admin.js` and `README.md`. The `checksum` property is required for security verification. |
| `icon`       | Square package icon. SHOULD be 128×128 or 256×256. `contentType`: `image/png`, `image/jpeg`, `image/svg`, or `image/gif`. SHOULD specify `width` and `height`. SHOULD NOT require auth. May specify `lang` (RFC4646) for localised icons.                                     |
| `screenshot` | UI screenshot. `contentType` and dimension rules as for `icon`. SHOULD NOT exceed 10 MB. SHOULD NOT require auth. May specify `lang`.                                                                                                                                         |
| `banner`     | Wide listing-page header image. Common sizes 772×250 and 1544×500. `contentType` and rules as for `icon`. MAY be omitted; clients SHOULD ignore banners not matching a usable size.                                                                                           |

(The `icon`, `screenshot`, and `banner` shapes are deliberately identical to FAIR's WordPress and TYPO3 extensions, so directory tooling can render them uniformly across ecosystems.)

**Extension properties on the release:**

atproto records validate against their declared Lexicon schemas. To allow other ecosystems to attach their own structured data without coordinated schema changes, the FAIR release Lexicon declares an `extensions` field as an open object whose values are typed via the `$type` discriminator that atproto already uses for embedded records. Each value is itself a record validated against the Lexicon named by its `$type`. (FAIR's HTTP transport achieves the equivalent via JSON-LD `@context` extensibility.)

EmDash defines a secondary Lexicon, `com.emdashcms.package.releaseExtension`, which is embedded inside the FAIR release record under that NSID key:

```json
{
	"$type": "pm.fair.package.release",
	"version": "1.0.0",
	"extensions": {
		"com.emdashcms.package.releaseExtension": {
			"$type": "com.emdashcms.package.releaseExtension",
			"capabilities": ["read:content", "email:send"],
			"allowedHosts": ["images.example.com"]
		}
	}
}
```

| Property       | Type     | Required | Description                                                                                                                                               |
| -------------- | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capabilities` | string[] | yes      | Declared capabilities (e.g. `"read:content"`, `"email:send"`). At least one. MUST exactly match the `capabilities` field in the bundle's `manifest.json`. |
| `allowedHosts` | string[] | no       | Allowed outbound host patterns. Omission means no outbound host access. MUST exactly match the `allowedHosts` field in the bundle manifest.               |

Capability vocabulary is owned by the EmDash runtime spec and may evolve independently of this RFC. The registry treats capability strings as opaque and only enforces the manifest-consistency rule.

**Path shorthand.** For brevity in the rules below and elsewhere in this document, `release.emdash.<field>` is shorthand for `release.extensions["com.emdashcms.package.releaseExtension"].<field>`.

**Extension validation rules:**

- A release whose package type is `emdash-plugin` MUST include a `package` artifact with `url` and `checksum`.
- A release whose package type is `emdash-plugin` MUST include `release.emdash` extension data with at least one declared capability.
- The `package` artifact's bytes MUST hash to the artifact's `checksum`.
- The bundle manifest's `capabilities` and `allowedHosts` MUST exactly match `release.emdash.capabilities` and `release.emdash.allowedHosts`. Checked at publish time by the CLI and at install time by the client.

**`allowedHosts` syntax:**

- Each entry is a hostname pattern, without scheme, path, or port.
- Exact hostnames like `images.example.com` are allowed.
- A leading `*.` wildcard is allowed for subdomains, e.g. `*.example.com`.
- Omission means no outbound host access.

**Latest release selection:**

- The latest release is the highest semver `version` for a package.
- Per FAIR's version-immutability rule (FAIR PR #77), if two records claim the same version, the record with the earliest creation time wins; later records MUST be ignored by aggregators and rejected by install clients.
- Deletion semantics follow proposed [FAIR PR #80](https://github.com/fairpm/fair-protocol/pull/80): deleted release records are tombstoned, MUST NOT appear in latest-release selection, and SHOULD NOT trigger uninstall on already-installed clients.

Yanked / deprecated states for releases or packages are not first-class fields in this RFC — they are handled via the labeller layer (see [Relationship to FAIR](#relationship-to-fair) and the trust/moderation follow-on RFC). A `security:yanked` or `deprecated` label on a release or package's AT URI signals client UI behaviour without changing the registry's protocol shape.

Inter-plugin dependencies are expressed via FAIR's `requires` map with package DIDs as keys. Reviews, reports and trust-layer records are intentionally out of scope for v1.

### Lexicon evolution

atproto lexicons are immutable contracts once published. EmDash strictly adheres to the official [atproto Lexicon Style Guide](https://atproto.com/guides/lexicon-style-guide#lexicon-evolution) for evolution. Because FAIR has officially adopted identical schema evolution rules (additive, optional fields only; no narrowing or renaming), the registry inherits forward-compatibility for free.

If a genuinely incompatible shape is needed, a new lexicon must be published under a new NSID. The old NSID is retained for historical records. To avoid namespace churn, v1 fields lean towards optional—we only require fields whose absence would render the record meaningless.

For follow-on features that require rapid iteration (e.g., reviews or reports), developers may use an experimental marker in the NSID (e.g. `com.emdashcms.experimental.review`). However, the core registry records (`pm.fair.package.profile`, `pm.fair.package.release`, and `com.emdashcms.package.releaseExtension`) are stable.

## Package Resolution

### Sandboxed plugin install flow

```mermaid
sequenceDiagram
    participant User
    participant Admin as Admin UI
    participant Aggregator
    participant PDS as Author's PDS
    participant Mirror as Aggregator Mirror / CDN

    User->>Admin: Browse / search plugins
    Admin->>Aggregator: GET /v1/packages?q=gallery
    Aggregator-->>Admin: Search results
    User->>Admin: Click "Install"
    Admin->>Aggregator: GET /v1/resolve/example.dev/gallery-plugin
    Aggregator-->>Admin: Package + release record + mirror URLs
    Admin->>PDS: Fetch package + release records by AT URI<br/>(verify MST signature)
    PDS-->>Admin: Signed records (ground truth)
    Admin->>Admin: Verify Aggregator metadata matches PDS records
    Admin->>Mirror: GET bundle archive from first available source<br/>(local mirror → aggregator mirrors → author URL)
    Mirror-->>Admin: gallery-plugin-1.0.0.tar.gz
    Admin->>Admin: Verify checksum against signed record
    Admin->>Admin: Verify bundle manifest matches release.emdash extension
    Admin->>Admin: Install to sandbox
    Admin->>User: Plugin installed (no rebuild needed)
```

The PDS-direct fetch is the trust anchor for installation — the aggregator is a discovery and caching layer, not the authoritative source. See [Install provenance verification](#install-provenance-verification).

### By handle and slug (user-facing)

```
@example.dev/gallery-plugin
```

1. Resolve handle `example.dev` to a DID via the atproto handle resolution mechanism.
2. Form the canonical package identity: `<did>/gallery-plugin`.
3. Construct the AT URI: `at://<did>/pm.fair.package.profile/gallery-plugin`.
4. Fetch the package record from the author's PDS.
5. Fetch the latest release record by highest semver version (excluding any tombstoned via deletion or labelled `security:yanked`).
6. Fetch the `package` artifact (see [Artifact retrieval](#artifact-retrieval)) using its `url`. Verify the artifact's `checksum` against the downloaded bytes. Verify the bundle manifest matches `release.emdash.capabilities` and `release.emdash.allowedHosts`. Install to the sandbox.

### Metadata resolution

Package and release _records_ are looked up in this order:

1. **Local mirror**, if the site is configured with one — works offline and in air-gapped deployments. A mirror holds package and release records as well as cached artifacts, addressed by canonical package identity. Records served from a mirror must still be verified against the author's repo proof before install.
2. **Aggregator API** — fast, cached, has aggregated package and release metadata.
3. **Author's PDS directly** — slower, but works independently of the aggregator.

This means the registry is resilient to aggregator downtime for users who already know the canonical package identity, and installable from fully offline mirrors for operators that require it.

### Artifact retrieval

Record lookup and artifact download are separate concerns. Metadata has one source of truth (the author's signed repo); artifact _bytes_ can come from anywhere that serves content matching the artifact's signed checksum.

The client fetches artifacts in this order:

1. **Local mirror**, if configured.
2. **Aggregator mirrors**, as advertised in the release response envelope (see below).
3. **The `package` artifact's `url`**, as declared in the release record.
4. Fail, surfacing the reason to the user.

Aggregator mirrors are tried _before_ the author-declared URLs because URL rot is exactly the problem mirroring solves. The author's URLs are the canonical declaration but the least operationally reliable source; an aggregator's mirror is typically on a managed CDN.

The client always verifies the downloaded bytes against the artifact's `checksum`, no matter which source served them. The checksum is transitively MST-signed by the publisher, forming the cryptographic trust boundary.

### Artifact mirroring

The default aggregator auto-mirrors releases whose redistribution is unambiguous:

1. On indexing a new release record, the aggregator fetches the `package` artifact from its declared `url`.
2. It validates: the bytes hash to the artifact's `checksum`; the archive parses as a valid gzipped tar; the archive root contains `manifest.json` and `backend.js`; the archive is under the 50 MB cap; the parsed manifest's `capabilities` and `allowedHosts` match the release's `emdash` extension data.
3. It checks the redistribution policy (see [Mirror policy](#mirror-policy)) and either stores the validated bytes in its own content-addressed object store and advertises mirror URLs on subsequent release responses, or indexes the record metadata-only and leaves `mirrors` empty.

This validation exists to keep the mirror honest — the aggregator operator does not want to become a dumping ground for arbitrary binaries published under `pm.fair.package.release` records. It is _not_ a trust signal for clients. The client re-verifies integrity on download regardless, because a mirror operator might be compromised, stale, or lazy.

#### Mirror policy

Auto-mirroring republishes the publisher's bytes from EmDash-operated infrastructure. The default aggregator restricts this to artifacts whose license clearly grants redistribution:

- **Mirror by default:** releases whose package profile `license` is an OSI-approved SPDX expression that permits redistribution (the common case for plugins — MIT, Apache-2.0, BSD, MPL-2.0, and so on).
- **Do not mirror:** releases with `license: "proprietary"`, releases whose `package` artifact has `requiresAuth: true`, and releases whose `license` is a non-OSI or unrecognised SPDX expression. These are indexed metadata-only; clients fall through to the artifact's declared `url` for downloads.

The policy is an aggregator operational choice, not a protocol rule — third-party aggregators may set their own. The cap-on-redistribution stance is deliberately conservative to avoid hosting code under licenses that don't permit it, and to leave space for the future paid/private plugin work (FAIR's `auth` field, currently reserved) without baking in a precedent that EmDash mirrors everything.

**Release response envelope.** When the aggregator returns a release, it wraps the signed record in an envelope with mirror URLs it is currently serving:

```json
{
  "release": { ...release record verbatim... },
  "mirrors": [
    "https://cdn.emdashcms.com/d/did:plc:abc.../gallery-plugin/1.0.0.tgz"
  ]
}
```

- The `release` object is the signed record from the author's repo, passed through verbatim.
- `mirrors` is an aggregator-specific field, not part of the signed record. Different aggregators can legitimately advertise different URLs for the same release.
- The URL shape is opaque. Aggregators choose whatever path scheme suits their infrastructure; clients treat the URLs as-is.
- `mirrors` may be empty (aggregator operator chose not to mirror; artifact was rejected at validation; mirror is temporarily unavailable). An empty `mirrors` array is simply skipped in the retrieval chain — the client proceeds to the artifact's declared `url` as described in [Artifact retrieval](#artifact-retrieval).

**Domain separation.** Following the same pattern Bluesky uses for video and blob hosting (`video.bsky.app`, `cdn.bsky.app` separate from `api.bsky.app`), the default aggregator serves its API and its artifact mirror on separate domains, backed by independent Workers. The API service stays cheap, cookieless and low-latency; the artifact service carries the bandwidth. **This is an operational choice, not a protocol constant** — the CDN domain is advertised in the `mirrors` field, not hardcoded anywhere.

### Install provenance verification

- The aggregator is used for discovery and indexing, not as the final trust anchor for installation.
- Before installing a plugin, the client must fetch the package record and selected release record by AT URI from the author's PDS, or obtain an equivalent verified repo proof.
- If the source records cannot be verified, or if they do not match the metadata returned by the aggregator, installation must fail.

### Outbound network considerations

The sandboxed install flow is architecturally different from the current marketplace mechanism: the admin server fetches artifacts from arbitrary author-chosen URLs rather than from a single trusted marketplace host. This widens the admin's outbound-network surface and is worth stating explicitly:

- The admin server must be able to make outbound HTTPS requests to arbitrary hosts referenced in release records. In air-gapped deployments, configure the local mirror resolution step so the admin never contacts an external artifact host.
- The artifact host is not trusted for integrity — the signed checksum on each artifact is authoritative — but it is trusted for availability, and a fetch against it may be used to fingerprint the site.
- Operators may restrict the set of artifact hosts they will fetch from via admin configuration. A policy surface for this is specified in the follow-on hosted-artifact RFC.

### Deletion semantics

- Aggregators should retain tombstones for deleted package and release records in their internal index.
- Deleted packages must not appear in search results and must not be installable.
- If a package identified by `did/slug` has been deleted, direct package lookups should return a deleted response rather than silently pretending the package never existed.
- Deleted releases must be excluded from release lists, excluded from latest-release selection, and must not be installable.
- Deleting a package or release does not require uninstalling already-installed site-local copies. Removal from a site remains an explicit admin action.
- The default aggregator removes mirrored artifacts for deleted releases from its object store.

An author who wants to pull a release deletes the record; the aggregator stops advertising it, the mirror stops serving it, and existing local installs keep running until an admin updates or uninstalls them. This differs deliberately from npm's yank-but-keep-installable primitive: because EmDash plugins are top-level installs with no transitive dependency chain, there is no `left-pad` failure mode for a pulled release to propagate through. If future RFCs introduce inter-plugin dependencies, a proper yank primitive may be needed at that point.

### Update Discovery and Takedowns

Update discovery is driven by the admin UI. When an admin logs into the dashboard or visits the plugins page, the frontend client performs a throttled query directly against the configured aggregator, passing the list of installed plugins to check for newer versions. The throttle is per-site rather than per-admin, and the default cadence is at most one automatic check every 6 hours. Admins can also trigger an immediate, unthrottled check via a "Check for updates" button in the UI.

- **Normal Updates:** If the aggregator returns a newer version, the CMS surfaces an "Update Available" badge in the admin UI.
- **Takedowns:** If a plugin is found to be malicious, the EmDash-operated takedown labeller (a labeller service publishing signed labels per atproto's [label spec](https://atproto.com/specs/label)) issues a `security:yanked` label against the package's or release's AT URI. The aggregator relays these labels in its response envelope; the admin UI surfaces a critical warning and disables the plugin's execution in the sandbox. Clients independently verify label signatures against the labeller's DID rather than trusting the aggregator's relayed copy — see [Threat model](#threat-model).

#### Label conventions

The v1 registry uses a small, fixed set of labels from the EmDash takedown labeller and any labellers a site operator additionally subscribes to. The protocol value space is atproto's standard label format; the conventional label values consumed by EmDash clients are:

| Label             | Applied to                | Client behaviour                                                                                                                 |
| ----------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `security:yanked` | release or package AT URI | Hide from latest-release selection; surface warning on installed sites; disable in sandbox.                                      |
| `deprecated`      | package AT URI            | Show deprecation badge in directory; allow new installs but encourage alternatives.                                              |
| `verified`        | publisher DID             | Used in conjunction with `com.emdashcms.publisher.verification` records (see [Publisher Verification](#publisher-verification)). |

A follow-on trust/moderation RFC will expand this vocabulary; v1 establishes only the subset above.

## The Publish Flow

A single file, **`manifest.json`**, is the source of truth for both publishing and runtime loading. It lives in the bundle root and is consumed by:

- **The runtime**, which reads the runtime-relevant fields (`id`, `version`, `capabilities`, `allowedHosts`, `hooks`, `routes`, etc.) when loading the plugin into the sandbox.
- **The CLI publish flow**, which reads the package-level fields (`name`, `slug`, `description`, `authors`, `license`, `security`, etc.) to construct the registry's `pm.fair.package.profile` and `pm.fair.package.release` records.

On first publish, the CLI reads the manifest from the built bundle and creates the `pm.fair.package.profile` record in the author's atproto repo. Subsequent publishes create `pm.fair.package.release` records against the existing package. There is no separate "register" step — publishing is the only way a package appears in the registry.

The runtime validates `manifest.json` against its existing schema and ignores the package-level fields it doesn't need; the publish flow reads the same file and uses both the runtime-relevant and package-level fields.

### Publish flow

In v1, publishing is URL-based:

```bash
$ emdash plugin publish --url https://github.com/example/gallery/releases/download/v1.0.0/gallery-plugin-1.0.0.tar.gz
```

1. Fetches the bundle archive from the URL, validates it is under the 50 MB cap, and computes its multibase checksum.
2. Reads `manifest.json` from the bundle. Extracts the runtime-relevant fields (`capabilities`, `allowedHosts`) for the release's `emdash` extension, and the package-level fields (`name`, `slug`, `description`, `authors`, `license`, `security`, etc.) for the package profile.
3. On first publish for a `slug`, creates the `pm.fair.package.profile` record. Always creates the `pm.fair.package.release` record with a `package` artifact carrying the URL and checksum, and the `emdash` extension carrying `capabilities` and `allowedHosts` from the manifest.

This requires the author to host the bundle somewhere (commonly a GitHub release) before running `publish`. A `--file <path>` flag that publishes a local tarball — uploading it to a default hosted artifact location and recording the resulting URL — is intended follow-on work that pairs with the hosted-artifact RFC. v1 does not include it; first-publish DX in v1 is "build → upload → publish", roughly three commands rather than `npm publish`'s one.

### Multi-Author Packages

A package is always published under a single Publisher DID. For teams and organizations, collaborative publishing is handled via a shared organizational DID — the team creates one atproto account for the org, and individual members publish through it. v1 supports two paths to this:

1. **Interactive:** team members `emdash plugin login` to the org account via OAuth on their own machines, with the granular scopes described in [Authentication](#authentication). Suitable for small teams where one or two people handle releases.
2. **CI/CD:** the org generates an app password for the publish use case and stores it in the CI secrets store. The CI job sets `EMDASH_PLUGIN_IDENTIFIER` and `EMDASH_PLUGIN_APP_PASSWORD` and runs `emdash plugin publish` non-interactively. See [Authentication](#authentication) for why credentials go through env vars and not flags, and why CI uses app passwords rather than OAuth.

As atproto's auth-scopes work matures — granular scopes are already deployed for interactive OAuth on bsky.social and rolling out to the self-hosted PDS distribution; permission sets and machine-credential flows are in progress — individual team members will be able to publish to the organization's repository using their personal keys with scoped tokens, and CI will move off app passwords. The plugin records themselves don't change with the auth path.

Directory-based packaging, upload flows, hosted artifact publishing, and dedicated GitHub Actions are planned follow-on work and intentionally omitted from the initial spec.

## Components

### What we build and host

**Registry Aggregator (default instance)**

The core indexing service. Subscribes to a relay firehose, filters for `pm.fair.package.*` records (or the `com.emdashcms.package.*` fallback), indexes into a database, auto-mirrors release artifacts (subject to [Mirror policy](#mirror-policy)), and serves a public read API. The reference deployment splits the API service and the artifact mirror across two Cloudflare Workers on separate domains, following the same pattern Bluesky uses for `api.bsky.app` vs. `video.bsky.app` / `cdn.bsky.app`. The API stays low-bandwidth and cookieless; the artifact mirror carries the egress. The aggregator software is open source and can be self-hosted by anyone. We expect EmDash hosting platforms may run their own aggregator instances, both for resilience and to have more control over mirroring policies.

API surface:

| Endpoint                                      | Description                                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `GET /v1/packages`                            | List/search packages. Supports `?q=` for search and pagination.                          |
| `GET /v1/packages/:did/:slug`                 | Get a specific package by canonical package identity.                                    |
| `GET /v1/packages/:did/:slug/releases`        | List releases for the package identified by `did/slug`.                                  |
| `GET /v1/packages/:did/:slug/releases/latest` | Get the latest release for the package, wrapped in an envelope with current mirror URLs. |
| `GET /v1/resolve/:handle/:slug`               | Resolve `handle/slug` to its canonical `did/slug` identity and return the package.       |

All release-returning endpoints return the envelope described in [Artifact mirroring](#artifact-mirroring): the signed release record plus a `mirrors` array of URLs the aggregator is currently serving the artifact from. The specific mirror URL scheme is an implementation detail of each aggregator and is not part of the protocol.

**Aggregator selection.** EmDash sites choose which aggregator they use via a three-layer precedence chain:

1. **Default**, baked into EmDash. Points at the official aggregator we operate. Works out of the box, no configuration needed.
2. **`astro.config.mjs`**, via a `plugins.registryaggregator` (or similar) option on the `emdash()` integration. Suitable for enterprise/air-gapped deployments where the aggregator choice is part of the site's build configuration.
3. **Admin UI setting**, for runtime override without a redeploy. Stored per-site; takes precedence over the config value.

Precedence is admin-UI > astro.config > default. The config and admin settings accept a base URL; EmDash constructs API paths relative to it.

**Aggregator ingestion defences.** To keep firehose-indexed aggregators from being DoS'd by record-spam, the default aggregator applies ingestion-time validation and rate limiting. Specific numbers (per-DID record rate, per-package release rate, etc.) are operational parameters of the reference aggregator, tuned post-launch against observed traffic, and are documented in the aggregator's deployment notes rather than this protocol spec. The shape of the protections is:

- **Per-DID rate limit** on new records, with steady-state and burst allowances. Over-limit records are dropped (not indexed); the author can retry later.
- **Per-record size cap** of 100 KB. Records larger than this are rejected at ingest. This matches atproto's practical MST-entry limit; within it, individual field caps (e.g. `description` ≤ 140 chars, `sections` entries bounded) still apply.
- **Per-package release backpressure** — once a package accumulates a large number of releases, further releases from the same package are rate-limited more aggressively. Not a hard cap; a signal to catch accidental runaway publishing.
- **Structural validation** against the lexicon schemas before any storage work. Malformed records never reach the database.
- **Artifact reachability check** for sandboxed releases. The aggregator attempts to fetch the artifact at index time (the same fetch it would do to mirror it); if unreachable or oversized, the release is indexed as metadata-only and flagged, and the mirror is not populated.
- **Duplicate-version detection.** A second release record at an existing version under the same package is ignored at ingest time.

These are aggregator-implementation concerns, not protocol rules — third-party aggregators may apply stricter or looser policies. Deeper trust-layer protections (author reputation, labeller signals) are planned in the follow-on trust RFC.

#### Upstream sync

The default aggregator sources its events from a public relay; the specific source is an operational setting rather than a protocol constant. Practical options:

- **Direct relay subscription.** Bluesky's Sync 1.1 relay at `relay1.us-east.bsky.network` is the canonical public firehose. The aggregator subscribes via `com.atproto.sync.subscribeRepos` and filters for `pm.fair.package.*` records (or the `com.emdashcms.package.*` fallback).
- **Tap as a sync layer.** [Tap](https://docs.bsky.app/blog/introducing-tap) is a single-tenant Go service that subscribes to a relay, verifies MST integrity and signatures, and emits filtered events for a configured set of collections. Its "collection signal" mode is designed for exactly this case — track only repositories that contain at least one of the registry record types. This is the recommended upstream for the reference aggregator: we get cryptographic verification and filtering out of the box without reimplementing them in the aggregator. Two caveats: Tap is Go and runs as a long-lived process, so the reference deployment splits the aggregator (Cloudflare Workers + D1) from the Tap instance (a small VM or container). And Tap is Bluesky-operated infrastructure on a relatively young codebase — if Tap pivots or stops being maintained, the aggregator falls back to direct relay subscription and reimplements the verification step itself.
- **Jetstream.** `jetstream2.us-east.bsky.network` exposes a simplified JSON firehose that's useful for prototyping and for implementations that don't want to handle CAR/CBOR decoding directly.

The choice between these is operational. The protocol is identical regardless of how events are sourced — if any given upstream becomes unavailable or starts filtering records we depend on, the aggregator can be pointed at an alternative without client-side changes.

**Web directory (default instance)**

A browsable website for searching and viewing plugins. Reads from the aggregator API. Displays package details, release history, author info and install instructions.

**Lexicons**

The lexicon definitions, published as JSON in a public repository. These are the protocol's source of truth.

### What we build and distribute (not hosted)

**CLI tool (`emdash plugin`)**

A subcommand of the EmDash CLI for publishing and managing plugins. Writes to the author's PDS using either atproto OAuth (interactive) or app passwords (CI/CD); reads come from the aggregator. See [Authentication](#authentication).

#### Authentication

Interactive publishing (a developer running `emdash plugin publish` on their own machine) uses atproto OAuth with granular scopes. The CLI requests the minimum permissions it needs:

- `repo:pm.fair.package.profile` — create and update package profile records (or `com.emdashcms.package.profile` under the namespace fallback).
- `repo:pm.fair.package.release` — create release records (action restricted to `create`; releases are version-immutable so update/delete are not requested).

The CLI's client metadata document declares these scopes, the user reviews them in the PDS auth flow, and the issued tokens are scoped accordingly. A leaked CLI token grants only the ability to publish/edit plugin records under the user's account — not their posts, blobs, identity, or account settings. As permission sets become broadly deployed, the CLI will switch to requesting `include:com.emdashcms.publishing` (a Lexicon-published bundle covering both repo permissions in one user-facing description), but the underlying granular scopes remain the contract.

Granular scopes are deployed on bsky.social and rolling out to the self-hosted PDS distribution as of late 2025; PDSes that have not yet shipped granular-scope support fall back to atproto's "transitional" coarse scopes for the same operations. The CLI accepts both in v1.

**Non-interactive publishing (CI/CD)** uses app passwords. Bluesky's own OAuth client guide states plainly: "OAuth is not currently recommended as an auth solution for 'headless' clients, such as command-line tools or bots." OAuth confidential clients exist but require a server component with `private_key_jwt` — a CLI invoked from a CI runner doesn't fit that shape. App passwords are formally deprecated in atproto but kept supported precisely because the headless story isn't done.

The CLI accepts app-password credentials **only via environment variables**: `EMDASH_PLUGIN_IDENTIFIER` (handle or DID) and `EMDASH_PLUGIN_APP_PASSWORD`. There is deliberately no `--app-password` flag — flags appear in shell history, in CI build logs, and in `ps` output, and are too easy to leak. Env vars are the only credential channel for non-interactive publishing.

The recommended pattern is:

- Create a **dedicated organisational atproto account** for plugin publishing rather than using an individual contributor's account. This account holds the publishing rights for all the org's plugins.
- Generate an app password specifically for CI; rotate it on a regular cadence; revoke it immediately if a CI runner is suspected of compromise.
- Store the app password in the CI secrets store and inject it as an env var at job time, never in the repo or in command lines.

Interactive `emdash plugin login` requires OAuth — we don't accept app passwords there, because there's no UX win and the security floor is meaningfully lower. The split is deliberate: scoped OAuth for humans, env-var-only app passwords for CI until atproto provides a real headless-client story.

App passwords today are full-account credentials. Two upcoming developments would change this:

- **Scoped app passwords.** Bluesky has discussed extending the granular-permission system to app passwords so a CI credential could be limited to `repo:pm.fair.package.*` rather than full account access. If/when this ships, the CLI uses scoped app passwords by default in CI.
- **A first-class atproto headless-client auth profile.** OAuth's standard flows assume a browser; an atproto-native machine-credential flow (whether device-code, client-credentials, or something new) would let CI use OAuth properly. There's no concrete spec for this yet.

The CLI is structured so the credential type is an implementation detail — when either of the above ships, the CI publish path migrates without any change to the plugin records themselves or the user-facing commands.

Commands:

| Command                                      | Description                                                          |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `emdash plugin login`                        | Authenticate via atproto OAuth.                                      |
| `emdash plugin init`                         | Scaffold a starter project with a `manifest.json` (like `npm init`). |
| `emdash plugin publish`                      | Publish a release. See [The Publish Flow](#the-publish-flow).        |
| `emdash plugin search <query>`               | Search the aggregator index.                                         |
| `emdash plugin info <did/slug\|handle/slug>` | Display package details and latest release.                          |

**Client library (npm package)**

A TypeScript library wrapping the lexicon operations for third-party integrations:

```ts
import { RegistryClient } from "@emdash/plugin-registry";

const client = new RegistryClient({
	appView: "https://registry.emdashcms.com",
});

// Discovery (reads from aggregator)
const results = await client.search("gallery");
const pkg = await client.getPackage("example.dev", "gallery-plugin");

// Release responses are enveloped: the signed record plus aggregator-advertised mirror URLs.
const { release, mirrors } = await client.getLatestRelease("example.dev", "gallery-plugin");
// mirrors[] is the ordered list of aggregator mirror URLs; the client tries these before the
// artifact's declared url, and verifies the downloaded bytes against the artifact's
// checksum at each step.

// Publishing a sandboxed plugin (writes to PDS via OAuth agent).
// Matches FAIR's Metadata Document shape exactly.
await client.createPackage(agent, {
	// `id` is derived from the resulting record's AT URI at publish time and is not
	// supplied by the author.
	type: "emdash-plugin",
	slug: "gallery-plugin",
	name: "Gallery Plugin",
	description: "A beautiful image gallery.",
	license: "MIT",
	authors: [{ name: "example", url: "https://example.dev" }],
	security: [{ url: "https://example.dev/.well-known/security.txt" }],
});

// Releases follow FAIR's Release Document shape, with EmDash extension data.
await client.createRelease(agent, {
	version: "1.0.0",
	artifacts: {
		package: {
			url: "https://github.com/example/gallery/releases/download/v1.0.0/gallery-plugin-1.0.0.tar.gz",
			contentType: "application/gzip",
			checksum: "uEi...", // multibase-encoded sha-256
		},
		icon: {
			url: "https://example.dev/gallery/icon.png",
			contentType: "image/png",
		},
	},
	requires: {
		"env:emdash": ">=2.0.0 <3",
	},
	extensions: {
		"com.emdashcms.package.releaseExtension": {
			$type: "com.emdashcms.package.releaseExtension",
			capabilities: ["read:content", "read:media"],
			allowedHosts: ["images.example.com"],
		},
	},
});
```

GitHub Actions, hosted upload services, artifact caches and labellers are planned follow-on work. They are deliberately omitted from the v1 protocol and implementation plan so the initial system can focus on publishing, discovery and installation.

### What we do NOT build

- **A PDS.** Authors use any existing PDS — Bluesky's hosted service, a self-hosted instance, or any other compliant PDS. We may in future host a PDS to allow easy signup for authors, but this is not a v1 deliverable and is not required for the system to function.
- **A relay.** We subscribe to existing relay infrastructure.
- **A sync / firehose-filtering layer.** The reference deployment plans to use [Tap](https://docs.bsky.app/blog/introducing-tap) to subscribe to a relay, verify MST integrity and signatures, and deliver filtered registry-record events to the aggregator; alternatives (direct relay subscription, Jetstream) are equally viable. See [Upstream sync](#upstream-sync) for the trade-offs.
- **A custom signing system.** atproto's repo-level MST signing covers every record in the author's repo as a side-effect of normal publishing, so releases don't need a separate per-artifact signing step.
- **A DID directory.** We use the existing [PLC directory](https://plc.directory/) and [did:web](https://atproto.com/specs/did) resolution.

## Reference Implementations

We provide reference implementations for every component in the initial system. The goal is that every required layer of the stack can be run independently.

| Component                 | What it is                                                                     | We host a default?            | Others can run their own?                               |
| ------------------------- | ------------------------------------------------------------------------------ | ----------------------------- | ------------------------------------------------------- |
| **Lexicons**              | JSON schema definitions for the registry record types and the EmDash extension | n/a (published in a Git repo) | n/a                                                     |
| **Aggregator**            | Firehose consumer + index + read API                                           | ✅ Yes                        | ✅ Yes — subscribe to the relay, index the same records |
| **Package mirror**        | Optional artifact mirror for releases                                          | ✅ Yes                        | ✅ Yes — the protocol allows any mirror strategy        |
| **Web directory**         | Browsable plugin directory website                                             | ✅ Yes                        | ✅ Yes — reads from any aggregator API                  |
| **CLI (`emdash plugin`)** | Publish, search and manage plugins                                             | n/a (distributed via npm)     | n/a                                                     |
| **Client library**        | TypeScript SDK for third-party integrations                                    | n/a (published to npm)        | n/a                                                     |

The reference aggregator is designed to run on Cloudflare Workers + D1, but the reference implementations are not Cloudflare-specific in their interfaces, only in their deployment target. Any host could reimplement the same APIs against their own infrastructure.

The web directory reference implementation is an Astro site that reads from the aggregator API. It can be deployed anywhere Astro runs.

## Third-Party Integration

### Hosting a directory

A third party that wants to offer their own plugin directory has two core options in v1:

```mermaid
graph LR
    subgraph "Option A: Frontend only"
        FA["Custom UI"] -->|reads| AV["Our Aggregator API"]
    end

    subgraph "Option B: Full Aggregator"
        FD["Their Aggregator"] -->|subscribes| RELAY["Relay firehose"]
    end
```

**Option A: Frontend only.** Build a UI that queries the public aggregator API. Zero backend infrastructure. Could be a static site.

**Option B: Full Aggregator.** Subscribe to the relay firehose, build their own index, serve their own API. Complete independence from our infrastructure.

In both cases, the package data is the same. It all comes from authors' atproto repos.

## Security Model

### Identity and provenance

Every package record is part of an atproto [repository](https://atproto.com/specs/repository), which is a Merkle Search Tree signed by the account's signing key. This means:

- The aggregator can verify that a package record was published by the DID that claims to own it.
- Records cannot be forged by third parties.
- If the aggregator is compromised, clients can independently verify records by fetching from the author's PDS and checking the repo signature.

For installation, the aggregator is a discovery layer. The install flow must verify package and release records against the author's repo before trusting their metadata.

### Artifact integrity

Every release artifact carries a multibase `checksum`, which is transitively authenticated by the author's signing key via the atproto repo's MST signature.

A client verifies:

1. The release record belongs to the expected DID (via repo signature).
2. The artifact served at the artifact's `url` hashes to the artifact's `checksum`.
3. The bundle manifest's `capabilities` and `allowedHosts` exactly match `release.emdash.capabilities` and `release.emdash.allowedHosts`.

The bundle is downloaded, hashed, and compared against the record before any install side effects occur. A failure at any step aborts the install with a specific error message.

### Key rotation and revocation

atproto handles key rotation at the DID level. If an author's key is compromised, they rotate it via the [PLC directory](https://plc.directory/) (or did:web update). Existing records remain valid (they were signed by the old key at the time), but new records must use the new key. This is handled transparently by the PDS.

### Capability declarations and trust

Capability declarations on each release are the trust signal the admin UI surfaces. Because capabilities live on each release (not the package), they are always authoritative for the version being installed: the admin UI can show "This plugin requests read:content, email:send, and outbound access to images.example.com" and the user can make an informed decision knowing the sandbox enforces those boundaries at runtime.

Releases with no `emdash` extension data are not installable by EmDash. A FAIR-shaped record without EmDash extension fields might still be valid in some other ecosystem, but the EmDash admin UI treats it as non-installable.

### Publisher Verification

To establish trust and prevent name squatting, the registry defines a `com.emdashcms.publisher.verification` lexicon, modeled on Bluesky's `app.bsky.graph.verification` shape but in EmDash's own namespace so the semantics are scoped to plugin publishing. The official EmDash identity (`did:web:emdashcms.com`) publishes these records to its own repository, pointing to the DIDs of vetted publishers. The EmDash aggregator reads these records and includes this status in the package envelope, allowing the CMS Admin UI to render a "Verified Publisher" badge. The mechanics inherit directly from Bluesky's "Trusted Verifier" pattern (a publisher record signed by a trusted issuer), providing cryptographically verifiable curation, but the namespace separation ensures EmDash's verification semantics can evolve independently and aren't tied to changes Bluesky makes to its social-graph verification.

The "Verified Publisher" badge is scoped to **sandboxed plugins published in the EmDash registry**. Verification is not a statement about a publisher's npm packages, native plugins, or any other distribution channel. The admin UI surfaces this scope in the verification badge's tooltip / details so users understand what is and isn't being verified. Native plugins are not surfaced in the registry-facing admin UI, so there is no path for the badge to be misread as covering them.

### Threat model

| Threat                                  | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compromised author account              | Key rotation via DID. Existing records remain attributable to the compromised identity, and clients can verify provenance directly from the repo history.                                                                                                                                                                                                                                                                                                                                             |
| Stolen CI app password                  | An attacker who exfiltrates an org's CI app password can publish arbitrary releases under that org's identity, including under a verified-publisher badge. Mitigations: dedicated org accounts (no individual exposure), regular rotation, env-var-only credentials (not on command lines), and the takedown-labeller path for rapid response once detected. The follow-on hosted-publishing RFC introduces signed publish receipts to make unauthorised publishes detectable on the aggregator side. |
| Malicious package                       | Out of scope for the v1 protocol. Initial mitigation is integrity verification, capability-consent UX, and directory-level curation. Dedicated reporting and labelling are planned in later RFCs.                                                                                                                                                                                                                                                                                                     |
| Aggregator compromise                   | Installs verify package and release records against the author's repo before trusting metadata. Integrity hashes are checked client-side.                                                                                                                                                                                                                                                                                                                                                             |
| Falsified labels in aggregator envelope | The aggregator relays labels but is not the source of truth for them. Clients verify label signatures against the issuing labeller's DID rather than trusting the aggregator's relayed copy. A compromised aggregator can withhold labels (failing open) but cannot forge `security:yanked` or `verified` claims that wouldn't validate against a labeller's signing key.                                                                                                                             |
| Permission set Lexicon hijacking        | The CLI's planned `include:com.emdashcms.publishing` permission set is published under EmDash's own NSID, so an attacker would need to compromise EmDash's publishing identity to alter it. Operators of high-assurance PDSes can additionally configure Lexicon override repositories (per the [auth-scopes proposal](https://github.com/bluesky-social/proposals/tree/main/0011-auth-scopes)) to pin known-good versions of the permission set.                                                     |
| Artifact host compromise                | Per-artifact multibase checksums, MST-signed by the publisher, detect tampered bundle archives.                                                                                                                                                                                                                                                                                                                                                                                                       |
| PDS goes down                           | Author migrates to another PDS. DID stays the same.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Relay goes down                         | Multiple relays exist in the atproto network. The aggregator can subscribe to alternatives.                                                                                                                                                                                                                                                                                                                                                                                                           |

# Testing Strategy

## Protocol-level testing

- **Lexicon validation:** Automated tests that verify record creation and validation against the lexicon schemas for both the `pm.fair.*` shape and the `com.emdashcms.package.*` fallback shape.
- **Round-trip tests:** Create package and release records on a test PDS, verify they appear in the aggregator index, verify the EmDash client can resolve and install from them.
- **Integrity verification:** Test that the EmDash client correctly rejects artifacts whose multibase checksum does not match the release record's artifact entry.
- **Provenance verification:** Test that install fetches package and release records from the author's repo (or equivalent verified proof) and rejects aggregator metadata that does not match source records.
- **Manifest consistency:** Test that the EmDash client refuses to install a release whose bundle `manifest.json` declares `capabilities` or `allowedHosts` that don't exactly match the release's `emdash` extension data.
- **Metadata fallback:** Test that the EmDash client falls back to PDS-direct record lookup when the aggregator is unreachable.
- **Artifact source fallback:** Test that the client walks the local mirror → aggregator mirror → artifact's declared `url` chain correctly when earlier sources are unavailable, and that the checksum is re-verified at each source.
- **Aggregator mirror validation:** Test that the aggregator rejects artifacts that exceed the 50 MB cap, fail to parse as valid `.tar.gz`, are missing required root entries, or whose parsed manifest capabilities/allowedHosts disagree with the release record's `emdash` extension.
- **Missing extension handling:** Test that the EmDash install client refuses to install a release with no `emdash` extension data, and that a generic directory can still render the release's metadata.
- **Deletion handling:** Delete package and release records on a test PDS, verify the aggregator retains tombstones (per FAIR's deletion semantics), removes the mirrored artifact from its object store, and removes them from search and install flows. Verify deletion does not trigger automatic uninstall on already-installed clients.
- **Labeller-driven yank:** Apply a `security:yanked` label (via a configured labeller) to a release's AT URI; verify the EmDash admin UI surfaces this on already-installed sites and excludes the release from latest-release selection.

## Integration testing

- **End-to-end publish flow:** CLI login → init → publish → verify record exists → verify aggregator indexes it → verify EmDash can install it.
- **Third-party directory:** Verify a frontend-only directory can read and display packages from the aggregator API.

## Adversarial testing

- **Tampered artifacts:** Serve a bundle archive whose bytes do not match the artifact's multibase checksum; verify the client rejects it, no matter which source (author URL, aggregator mirror, local mirror) served it.
- **Mirror as arbitrary-file dump:** Publish a release record whose artifact `checksum` points at an unrelated binary; verify the aggregator refuses to mirror it.
- **Duplicate-version override:** Publish a second release record with the same `version` as an existing release; verify the aggregator ignores the later record, install clients refuse it, and the earlier record remains canonical.
- **Ingestion spam:** Publish records faster than the aggregator's per-DID rate limit; verify excess records are dropped at ingest and the aggregator stays responsive.
- **Capability inflation:** Publish a release whose `release.emdash.capabilities` list claims fewer permissions than the bundle's `manifest.json` actually requests. Verify the EmDash client rejects the install at manifest-consistency check time.
- **Forged records:** Attempt to create records claiming to be from a different DID; verify the aggregator and client reject them (via MST signature failure).

# Drawbacks

- **Dependency on atproto infrastructure.** The system relies on the atproto relay network and PDS ecosystem being available and functioning. If atproto as a whole experiences issues, the registry is affected. However, the fallback-to-PDS design means the system degrades gracefully rather than failing entirely.

- **Atmosphere account required for authors.** Authors must have an Atmosphere account (practically, a Bluesky account) to publish. This is a lower barrier than running a server, but it's still a dependency on a specific ecosystem. If atproto adoption stagnates, this could limit the author pool.

- **Artifact hosting is author-declared, partially mirrored.** The canonical URL list in a release record is the author's choice, which may rot over time. The default aggregator auto-mirrors releases under OSI-approved redistributable licenses so installs remain possible after author URLs die (see [Mirror policy](#mirror-policy)); proprietary or unauth-required artifacts are indexed metadata-only, so URL rot for those bundles breaks installs. Third-party aggregators are not obligated to mirror anything. Fully hosted publishing flows (upload services, CI-driven mirror pinning) are planned follow-on work.

- **Lexicon immutability.** Atproto lexicons are immutable contracts once published. v1 field choices are effectively permanent for the NSIDs in this RFC. We address this by adopting atproto's native evolution rules (see [Lexicon evolution](#lexicon-evolution)) and leaning towards optional fields in v1, but the initial schema design still needs to be close to right.

- **New concept for most plugin authors.** Most CMS plugin developers are not familiar with atproto, DIDs, or decentralised protocols. The tooling must abstract this so the publish experience approaches the simplicity of `npm publish`. The first-publish flow in v1 doesn't reach that bar yet — see the next bullet.

- **First-publish DX is rougher than `npm publish`.** v1 requires authors to host their bundle (typically as a GitHub release) before running `emdash plugin publish --url`. A `--file` flag that uploads a local tarball is deferred to the hosted-artifact RFC. Until that lands, the publish loop is "build → upload → publish" rather than a single command.

- **CI/CD auth uses unscoped app passwords.** Interactive OAuth uses granular scopes (the CLI requests only `repo:pm.fair.package.*`), so a leaked CLI token grants only plugin-publishing access. CI is different — atproto explicitly does not recommend OAuth for headless clients today, and confidential-client OAuth doesn't fit the CI-runner shape. v1 ships with app-password support for CI publishing because the alternative — no CI publishing — would push every release through manual local commands, which is worse. App passwords are full-account credentials with no scoping; the mitigation is operational (dedicated org accounts, rotation, env-var-only credentials) and the path migrates to scoped app passwords or a real headless-OAuth profile as soon as either ships upstream. See [Authentication](#authentication).

- **Sparse day-one search.** At launch the aggregator has no quality signals — no install counts, no ratings, no labellers. Discovery ranking is metadata-only (recency, keyword match, name match) and the directory will feel empty before authors publish. Mitigation: EmDash's own first-party sandboxed plugins publish through the registry first, so the directory ships with real, useful content on day one. Better ranking lands when the follow-on trust/labeller RFCs add install counts, reviews and verification signals.

- **Sandboxed-only scope leaves native plugins discoverable only through documentation.** Until the follow-on native-plugin RFC lands, native plugins remain on npm with no integrated discovery. This is a real UX cost relative to a unified registry; the alternative was specifying ahead of FAIR's still-emerging package-manager-source pattern. See [Future support for native plugins](#future-support-for-native-plugins).

# Alternatives

## Use FAIR directly

Adopt the FAIR protocol as-is, writing an EmDash-specific extension. This would mean each package gets its own DID, authors publish to a FAIR-compatible repository host, and we run or consume an aggregator for discovery.

**Why not:** Higher infrastructure burden on authors. No social layer. Weaker discovery (crawling vs. firehose). The PHP-specific reference implementation provides little reusable code for EmDash.

## Build a traditional centralised registry

Run a server. Authors create accounts. Packages are uploaded to our storage. We handle identity, discovery, trust and hosting.

**Why not:** This is the model we're explicitly trying to avoid. It concentrates control, creates a single point of failure, and makes us the bottleneck for the entire ecosystem.

## Use IPFS / content-addressed storage

Host artifacts on IPFS or a similar content-addressed network. Package metadata could be published as IPNS records or via a smart contract.

**Why not:** IPFS has persistent availability and performance issues for this use case. The tooling maturity is significantly behind atproto. We'd still need to solve identity and discovery separately.

## Use ActivityPub

Publish packages as ActivityPub objects. Directories are ActivityPub servers that follow author accounts.

**Why not:** ActivityPub's data model isn't well suited for structured, queryable records. There's no equivalent of the firehose for efficient indexing. Identity is server-bound, not portable. The protocol is designed for social messaging, not structured data distribution.

## Include native plugins in v1

Specify the registry shape to also handle native (npm-distributed) plugins from day one — synthesise records for them, surface them in the same directory, build the cross-runtime install UX.

**Why not:** Discussed in detail in [Future support for native plugins](#future-support-for-native-plugins). Briefly: the trust model differs sharply, the distribution shape doesn't fit cleanly until FAIR's package-manager-source pattern stabilises, and the registry's value is highest where install is automated. Including native plugins in v1 forces design compromises in three places we'd rather get right separately.

# Adoption Strategy

## For plugin authors

1. **Phase 1 — CLI.** Authors install the EmDash CLI, authenticate with their Atmosphere account (`emdash plugin login`), scaffold a project (`emdash plugin init`), and publish their sandboxed plugin (`emdash plugin publish --url <hosted-bundle>`). Three commands for first publish; subsequent releases are a single `publish` invocation. This is the minimum viable experience.
2. **Future work.** Automation and web publishing flows can be layered on once the core protocol is stable.

We dogfood the system first by publishing EmDash's own first-party sandboxed plugins through it.

## For EmDash users

EmDash ships with the registry client built in. Users search for and install sandboxed plugins through the admin UI or CLI. The browse-and-install experience should feel as smooth as a centralised registry; the underlying decentralisation surfaces only in publisher attribution (handles like `@example.dev`) and in the "Verified by EmDash" badge wording on the publisher-verification UI. Native plugins continue to be installed via `npm install` and configured in `astro.config.mjs`; their discoverability is handled through documentation rather than the registry.

## For hosting providers and third parties

We provide the client library on npm. A host can integrate plugin browsing and installation into their platform with minimal effort. We document the aggregator API and provide examples of building custom directories. All reference implementations are open source and designed to be self-hosted.

## For existing marketplace installs

The current centralised marketplace uses a `_plugin_state` table with `source='marketplace'` and a `marketplace_version` field. As part of Phase 1, this is replaced wholesale rather than run in parallel.

The current marketplace contains only first-party EmDash plugins; no third-party authors have published to it. This makes the cutover straightforward — there is no third-party coordination burden, and we control every plugin that needs to be republished. Concretely:

- All existing first-party plugins are republished through the new registry as part of the same release that ships the registry client.
- On upgrade, each existing `source='marketplace'` row is matched to its corresponding new-registry package, and the stored identity is rewritten to the AT URI of the matched package record. The installed bundle is not re-downloaded — the migration is metadata-only.
- There is no parallel-running period. The new registry replaces the old marketplace in a single release.

If a third-party marketplace ecosystem develops in the future before this RFC ships, the migration plan will need to add a deprecation window. That is not the situation we're shipping into.

# Implementation Plan

## Phase 1: Foundation

The work has a clear dependency chain — lexicons block both the CLI and the aggregator; the CLI blocks dogfooding (we need to publish first-party plugins to have anything to index); the aggregator blocks the admin UI install flow. The admin UI is the last critical-path item.

**Critical path:**

1. **Lexicons.** Design and publish the schemas. This blocks everything else and is worth spending disproportionate time on. During development, publish under clearly-experimental NSIDs (e.g. `com.emdashcms.experimental.package`, `com.emdashcms.experimental.release`) to allow iteration without commitment. Move to the stable namespace — `pm.fair.*` if FAIR adopts the lexicons, `com.emdashcms.package.*` otherwise — once the schema is settled, and in any case before the public beta launch.
2. **CLI.** `login`, `init`, `publish --url`, `search`. Authenticates via OAuth (interactive) and app passwords (CI). Validates manifests against the lexicon schemas locally before submitting.
3. **First-party plugin republishing.** Use the CLI to publish all existing first-party EmDash plugins through the new flow. This catches schema and CLI bugs before the aggregator is ready and gives us real data for the aggregator to index.
4. **Aggregator.** Firehose subscription (via Tap or direct), record indexing, mirror policy, public read API. Verified against the first-party plugin records published in step 3.
5. **Admin UI install flow.** Search, provenance verification (PDS-direct fetch), integrity verification, capability consent, install.

**Parallel work** (can land any time before Phase 1 ships):

- **Publisher verification lexicon** (`com.emdashcms.publisher.verification`). Define the schema, publish it, set up the EmDash signing identity. Used by step 5's admin UI to render the verified-publisher badge for first-party plugins on day one. If this slips, the badge is hidden in v1 and added in a point release without further protocol changes.
- **Takedown labeller.** Stand up the EmDash-operated labeller and the aggregator's label-relay path. Required for the takedown story but not the install story.

Milestone: "I can publish a sandboxed plugin from the CLI and someone else can install it from the admin UI, with provenance verified against the publisher's PDS."

### Success criteria for v1

- Every existing first-party EmDash sandboxed plugin is published through the new registry and installs cleanly via the admin UI on a fresh EmDash site.
- The marketplace migration runs successfully on existing installs and rewrites stored identities to AT URIs without re-downloading bundles.
- An external developer can publish a plugin from a third-party PDS (we test against at least Bluesky's hosted service and one alternative PDS) and have it indexed by the aggregator and installable from EmDash.
- Median firehose-to-aggregator indexing latency is under 10 seconds for new releases under normal relay conditions.
- The default aggregator and CDN sustain 1k installs/min for a popular release without degraded latency.

### Day-one plugin set

The v1 release republishes EmDash's existing first-party sandboxed plugins through the new registry. The exact list is determined by what's shipping in the release that includes the registry, but the migration test plan covers each one end-to-end: republish through the new flow, verify the aggregator indexes the record, verify a fresh install on a clean site works, verify the marketplace migration rewrites the existing-install identity to the new AT URI.

## Planned follow-on RFCs

- Automation layers, including GitHub Actions and web publishing flows.
- Hosted artifact workflows, including upload services and cache layers.
- Site identity, via a `did:web` derived from each site's domain, as the mechanism for signed install records and authenticated reviews without requiring the site operator to hold an Atmosphere account.
- Trust and moderation primitives, including labels, reviews, reports and SBOM consumption. The labeller architecture (atproto-compatible signed labels, possibly via Ozone, with site-configurable `require`/`warn`/`info`/`ignore` behaviour) is the intended starting point.
- Dependency and compatibility metadata.
- **Native plugin support.** See [Future support for native plugins](#future-support-for-native-plugins) for what this RFC would address.

# Unresolved Questions

## Lexicon namespace

This draft proposes `pm.fair.*` for FAIR's core records, with `com.emdashcms.package.*` as the fallback if FAIR doesn't bless the lexicons. The decision is FAIR's to make and depends on engagement with the FAIR project; it does not block our implementation but it does affect downstream tooling and ecosystem positioning.

A separable but related question is whether FAIR formalises AT URIs as permitted `id` values under the atproto transport. See [Relationship to FAIR](#relationship-to-fair) for what changes if FAIR rejects that proposal.

## Other open questions

- **Deprecation / un-deprecation policy.** The lexicon allows authors to remove the `deprecated` field from a package record (it's just a field edit). The reference CLI refuses to do this to prevent quiet re-activation, but a non-reference client could. Worth deciding whether this should be a protocol-level constraint (e.g. "once set, `deprecated` must remain set"), a label-driven mitigation, or simply a documented risk.
