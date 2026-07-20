# ATProto foundations

This document explains the ATProto concepts the labeler is built on, and the concrete choices this service makes. Read it if you are consuming the labeler's labels, verifying its signatures, or working on the service itself. For the label vocabulary see [moderation-model.md](moderation-model.md); for the operator console see [operating.md](operating.md).

## Decentralized identity and DIDs

ATProto identifies every account and service by a **DID** (Decentralized Identifier): a stable, method-scoped string that does not change even when the underlying host, handle, or key rotates. A DID resolves to a **DID document**, a JSON object describing how to interact with that identity. Two parts of the document matter here:

- **Verification methods** — public keys bound to the identity. Anything the identity signs can be verified against these keys.
- **Services** — named endpoints. A client that knows a DID can resolve it, read the service list, and find where to talk to it.

The DID string encodes a **method** that says how to resolve it. Two methods are relevant to a labeler:

- **`did:plc`** — the common ATProto method. The identifier is an opaque string (`did:plc:abc123…`) hosted by the PLC directory, a separate service that stores and serves the DID document. Rotating keys or moving hosts means updating the record in the directory.
- **`did:web`** — the identifier _is_ a domain. `did:web:labels.emdashcms.com` resolves by fetching `https://labels.emdashcms.com/.well-known/did.json`. No external directory is involved; whoever controls the domain controls the document.

### Why this labeler uses `did:web`

A labeler already owns and operates a domain and an HTTP server. `did:web` lets it be its own source of truth: the Worker serves its own DID document at `/.well-known/did.json`, so there is no registration step, no external directory to keep in sync, and no third party in the resolution path. The tradeoff — that identity is tied to continued control of the domain — is acceptable for an infrastructure service whose whole purpose is to serve that domain.

## This labeler's identity

The labeler's DID is `did:web:labels.emdashcms.com` (config var `LABELER_DID`), and its service URL is `https://labels.emdashcms.com` (`LABELER_SERVICE_URL`). Resolving the DID means fetching `https://labels.emdashcms.com/.well-known/did.json` — which the Worker serves itself, with content type `application/did+ld+json`.

The document (built by `serviceDidDocument` in `src/identity.ts`) has this shape:

```json
{
	"@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
	"id": "did:web:labels.emdashcms.com",
	"verificationMethod": [
		{
			"id": "did:web:labels.emdashcms.com#atproto_label",
			"type": "Multikey",
			"controller": "did:web:labels.emdashcms.com",
			"publicKeyMultibase": "zDnae..."
		}
	],
	"service": [
		{
			"id": "did:web:labels.emdashcms.com#atproto_labeler",
			"type": "AtprotoLabeler",
			"serviceEndpoint": "https://labels.emdashcms.com"
		}
	]
}
```

Two entries carry the whole contract:

- **`#atproto_label`** — a single `Multikey` verification method holding the P-256 public key (`publicKeyMultibase`, from `LABEL_SIGNING_PUBLIC_KEY`). Consumers use this key to verify the signature on every label the service emits. This is the anchor of trust: a label is only as trustworthy as the DID document that publishes the key it was signed with.
- **`#atproto_labeler`** — a single service entry of type `AtprotoLabeler` whose `serviceEndpoint` is the labeler's base URL. This is how an ATProto client, given only the DID, discovers where to query and subscribe.

## Labels

A **label** in ATProto is a small, signed assertion that attaches a value (a short string like `malware` or `assessment-passed`) to a subject. The subject is either a whole repository (identified by a DID) or a specific record (identified by its AT-URI, optionally pinned to a content hash, the **CID**). Labels can be self-authored (an account labeling its own content) or third-party: a **labeler** is a service that publishes labels about subjects it does not own. Clients choose which labelers they trust and subscribe to them; a label from an untrusted labeler carries no weight.

This service labels three kinds of subject:

- **Publisher** — a DID. The identity that publishes packages.
- **Package** — a record URI (the package profile record).
- **Release** — a specific release, identified by its record URI _and_ CID, so a label applies to one exact version's bytes.

The **`cidRule`** on each label encodes which of these it can target:

- `required` — the label must pin a CID, so it targets one specific release version.
- `forbidden` — the label must not pin a CID, so it applies URI-wide (a whole package or publisher).
- `optional` — either form is valid.

Release-eligibility labels are `required` (they are about one version's bytes); publisher and package actions are `forbidden` (they apply to everything under that subject). The full rules per label are in [moderation-model.md](moderation-model.md).

## Signing

Labels are cryptographically signed so a consumer can trust their provenance without trusting the transport. The signing key is a **P-256** (ECDSA / ES256) keypair:

- The **public key** lives in the DID document's `#atproto_label` method, as a canonical P-256 Multikey (`LABEL_SIGNING_PUBLIC_KEY`). Anyone resolving the DID can read it.
- The **private key** stays on the server as a secret (`LABEL_SIGNING_PRIVATE_KEY`, the unpadded base64url of the raw 32-byte scalar). It signs every label the service emits and is never exposed.

A consumer verifies a label by resolving the labeler's DID, reading the public key from `#atproto_label`, and checking the label's signature against it. The Worker checks that the configured private key derives the public key published in the document when it constructs its signer — which happens lazily, on the first signing operation, not at boot or deploy. A mismatched pair therefore deploys cleanly and fails the first time the Worker tries to sign (a discovery assessment, a `queryLabels` re-sign, or a console mutation), rather than being caught up front.

Key rotation is tracked by `LABEL_SIGNING_KEY_VERSION` (currently `v1`). Generate a fresh keypair with `pnpm --filter @emdash-cms/labeler keygen`, install the new secret and public key, and bump the version.

## XRPC surface

ATProto's HTTP-RPC convention is **XRPC**: each method is a namespaced identifier (an NSID like `com.atproto.label.queryLabels`) called at `/xrpc/<nsid>`. The labeler exposes:

| Path                                         | Purpose                                                                                                                                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/xrpc/com.atproto.label.queryLabels`        | Query the current labels for a set of subjects (a point-in-time read).                                                                              |
| `/xrpc/com.atproto.label.subscribeLabels`    | The streaming label firehose. A WebSocket subscription consumers follow to receive labels as they are issued; accepts a numeric `cursor` to resume. |
| `/xrpc/com.atproto.moderation.createReport`  | **Rejected.** This labeler does not accept user moderation reports; the endpoint returns a `NotSupported` error.                                    |
| `/xrpc/com.emdashcms.experimental.labeler.*` | The experimental assessment API (`getAssessment`, `getCurrentAssessment`, `listAssessments`, `getPolicy`).                                          |

Alongside the XRPC methods, two documents are served under `/.well-known`:

| Path                                      | Purpose                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| `/.well-known/did.json`                   | The DID document (above).                                                     |
| `/.well-known/emdash-labeler-policy.json` | The moderation policy document (label vocabulary and rules), cached for 300s. |

## Jetstream and ingestion

The labeler does not wait for anyone to submit content. It consumes the registry's records directly from the ATProto firehose via **Jetstream** (a JSON-streaming view of the network's commit stream), which is how it discovers new packages and releases to assess. Discovered work is enqueued and processed by the assessment pipeline, which is what ultimately produces the labels.

## How it fits the wider network

A consumer — the emdash aggregator, or any client that trusts this labeler — puts the pieces together like this:

1. Resolve `did:web:labels.emdashcms.com` by fetching `/.well-known/did.json`.
2. Read the `#atproto_labeler` service entry to find the endpoint.
3. Subscribe to labels via `subscribeLabels` (or query current state with `queryLabels`).
4. Verify each label's signature against the P-256 key in `#atproto_label`.
5. Overlay the verified labels into an eligibility decision (see [moderation-model.md](moderation-model.md)) and act on it — showing, gating, or withholding the release.

The trust chain is end to end: control of the domain backs the DID, the DID publishes the key, the key signs the labels, and the labels drive the decision.
