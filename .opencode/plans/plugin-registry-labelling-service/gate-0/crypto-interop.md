# Gate 0: Label crypto interoperability

## Decision

Use P-256 (`secp256r1`) with `@atcute/cbor` 2.3.3 and `@atcute/crypto` 2.4.1. The production secret format is one unpadded base64url-encoded 32-byte P-256 private scalar. Decode it and pass the raw bytes to `P256PrivateKey.importRaw`. Publish the compressed public key as an ATProto P-256 multikey in the issuer DID document's exact `#atproto_label` verification method.

P-256 is selected over k256 because the atcute implementation uses the WebCrypto `P-256`/`SHA-256` implementation available in workerd. Signatures are low-S, 64-byte IEEE-P1363 values. Do not accept DER signatures. A startup check must derive the public multikey from the secret and require it to equal the DID/configured key before issuance starts.

The high-level atcute `P256PrivateKey.sign(data)` and `P256PublicKey.verify(sig, data)` APIs perform SHA-256 as part of WebCrypto ECDSA. They therefore receive canonical CBOR bytes, not an already computed digest. The fixture records the intermediate SHA-256 digest required by the protocol; passing that digest to these APIs would hash twice.

## Signed shape

The retained workerd harness reconstructs a label from this unsigned v1 allowlist only:

`ver`, `src`, `uri`, `cid`, `val`, `neg`, `cts`, `exp`

It requires `ver: 1`; validates `src` as a DID, `uri` as an ATProto generic URI, `cid` with the ATProto CID validator, and `cts`/`exp` as RFC3339 datetimes with valid calendar dates; requires `val` to contain 1 to 128 UTF-8 bytes; and rejects `sig`, `$type`, and every unknown field before DRISL encoding. An input `neg: false` is omitted from the reconstructed object. `sig` is attached only after signing. The signer must never accept an arbitrary object.

## Key decoding and DID resolution

Private scalar decoding is a signer boundary, not a permissive utility. It accepts only the unpadded base64url alphabet, requires canonical re-encoding to exactly the supplied string, requires exactly 32 decoded bytes, interprets them as an unsigned big-endian integer, and requires `1 <= d < n` for the P-256 order `n`. Padded, malformed, non-canonical, wrong-length, zero, and order-or-larger values fail before `P256PrivateKey.importRaw`.

Resolve the issuer DID document and normalize relative `#atproto_label` and fully qualified `${issuerDid}#atproto_label` IDs to the same logical method. Either form is valid alone; any duplicate across relative or fully qualified forms fails independent of order. The DID document ID and method controller must equal the issuer DID. The method must use `type: "Multikey"`, include `publicKeyMultibase`, identify the P-256 codec, and contain an importable 33-byte compressed P-256 point. At startup, derive the signer public multikey from the configured private scalar and require exact equality with the resolved method's `publicKeyMultibase`; a valid but different P-256 key fails. A duplicate method, legacy key type, wrong controller, k256 key, malformed point, missing label key, or document containing only `#atproto` fails. There is no fallback to another verification method.

## Independent source

The independent implementation is Bluesky's `@atproto/crypto` 0.4.5 from <https://github.com/bluesky-social/atproto/tree/main/packages/crypto>, dual licensed MIT or Apache-2.0. It is independent of the Mary-ext atcute implementation and uses Noble Curves rather than WebCrypto for P-256.

The committed fixture is reproducible from test-only private scalar `0x01`:

- `@atcute/cbor` produced the canonical payload bytes.
- `@atproto/crypto` produced the deterministic `atprotoReferenceHex` signature; workerd/atcute verifies it.
- Actual workerd `@atcute/crypto` produced `atcuteWebcryptoHex`; the retained Node test calls `@atproto/crypto.verifySignature` over it.
- Both implementations derived the same compressed public key and P-256 `did:key` multikey.

The vector is test material, not a usable deployment key. Its canonical CBOR bytes, SHA-256 hash, two signatures, raw compressed public key, public multikey, and reproducible test private scalar are in `fixtures/crypto/p256-label-v1.json` for W1.4.

## Commands and results

Run from the repository root:

```sh
pnpm --filter @emdash-cms/atproto-test-utils exec vitest run tests/label-crypto-vector.test.ts
pnpm --filter @emdash-cms/aggregator exec vitest run test/label-crypto-interop.test.ts
```

The first command is the retained Node generator/assertion. It reproduces the canonical CBOR bytes, SHA-256 hash, public key forms, and deterministic `@atproto/crypto` reference signature from the test scalar, then independently verifies the retained atcute workerd signature. No fixture boolean stands in for execution.

The second command runs the selected atcute API in workerd. It proves local signing and verification, verifies the independently generated signature, and exercises all signer/key rejection boundaries. Both commands must pass whenever the vector changes.

## Rejections proved

- Unknown fields, including `sig`, `$type`, and a representative arbitrary field, are rejected before encoding.
- Unsupported versions and malformed required/optional field types are rejected before encoding.
- Invalid DID, URI, CID, RFC3339/calendar datetime, empty/oversized UTF-8 value, and explicit false negation handling are covered.
- Private scalar decoding rejects malformed, padded, non-canonical, wrong-length, zero, and out-of-range inputs.
- DID method resolution accepts either relative or fully qualified label-key IDs alone, rejects mixed-form and same-form duplicates, and rejects missing IDs, wrong type/controller/codec, absent multikey data, signer-key mismatch, and fallback to `#atproto`.
- Passing the recorded protocol digest to `sign` produces a double-hashed signature that does not verify against canonical CBOR.
- The correct signature fails under a different P-256 key.
- The correct signature fails for a changed label payload.
- The correct signature fails against malformed non-DRISL payload bytes.
- A bit-flipped signature fails.
- Truncated, oversized, high-S equivalent, and ASN.1 DER signatures fail; only low-S compact 64-byte signatures are accepted.

## Key lifecycle contract

### Routine rotation

1. Pause the issuance boundary before creating any label sequence that would need a signature. Assessment decisions may queue, but no sequence is allocated, stored, or broadcast while paused.
2. Generate a fresh P-256 key through the approved ceremony, store its base64url private scalar as a new Secrets Store version, derive its public multikey, and record a non-secret key-version identifier. Keep the old private key available for rollback until rotation is confirmed.
3. Update the issuer DID document's `#atproto_label` method to the new public multikey and verify the resolved document from outside the deployment.
4. Activate the matching secret version only after the DID update is observable. The startup/runtime guard must refuse issuance if the derived key does not match the resolved/configured public key.
5. Resume issuance. Persist the key-version identifier with every signature. Monitor signing failures, DID mismatch, and downstream verification failures.
6. On query, lazily re-sign labels carrying an old key version with the current key without changing `cts`, then persist the replacement signature/key version. Event-stream backfill may retain old signatures as allowed by the ATProto label specification.
7. Subscribers retry one failed verification after re-resolving the DID. They recover missed labels from their last durably accepted cursor; rotation alone does not reset sequence history.

### Suspected or confirmed compromise

1. Pause issuance immediately at the same pre-sequence boundary. Do not use the compromised key for rollback or historical re-signing.
2. Replace or remove the compromised `#atproto_label` key in the DID document, publish an incident notice through the policy endpoint, establish the last trusted sequence/time where possible, and deploy a fresh key only after its DID publication is observable.
3. Preserve compromised signatures and their key-version mapping for forensics, but never treat them as currently valid merely because they once verified.
4. Reissue the current effective label set with new signed events. Do not rewrite compromised history into an apparently continuous trusted history.
5. Declare a safe replay cursor when one can be established. Otherwise require subscribers to clear derived state for this labeller and replay the retained stream from cursor `0` after trustworthy history/current-state recovery is available.
6. Subscribers re-resolve the DID on signature failure, reject labels that still fail, and alert rather than falling back to `#atproto` or any other DID key.

W3.7 owns implementing this state machine and key-version persistence. W11.4 owns the operator runbook, ceremony/custody details, external DID verification, monitoring, and subscriber communications.
