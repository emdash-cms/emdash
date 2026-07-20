// Generates a P-256 signing keypair for the labeler in the exact formats the
// Worker validates: the private key as unpadded base64url of the raw
// 32-byte scalar (LABEL_SIGNING_PRIVATE_KEY secret) and the public key as a
// canonical P-256 Multikey (LABEL_SIGNING_PUBLIC_KEY var, published in the DID
// document's #atproto_label verification method).
//
// Run:  pnpm --filter @emdash-cms/labeler keygen
//
// The two values are printed to stdout; nothing is written to disk. Set the
// private key with `wrangler secret put LABEL_SIGNING_PRIVATE_KEY` and paste the
// public key into wrangler.jsonc. The Worker verifies the pair the first time it
// signs (not at deploy), so a mismatch surfaces as a failed signing operation
// rather than at boot -- exercise a signing path after setting or rotating it.

import { P256PrivateKeyExportable } from "@atcute/crypto";
import { toBase64Url } from "@atcute/multibase";

const key = await P256PrivateKeyExportable.createKeypair();
const privateKey = toBase64Url(await key.exportPrivateKey("raw"));
const publicKey = await key.exportPublicKey("multikey");

process.stdout.write(
	[
		"P-256 labeler signing keypair",
		"",
		"LABEL_SIGNING_PRIVATE_KEY (secret — never commit):",
		`  ${privateKey}`,
		"",
		"LABEL_SIGNING_PUBLIC_KEY (wrangler.jsonc var):",
		`  ${publicKey}`,
		"",
		"Next:",
		"  1. echo -n '<private key>' | wrangler secret put LABEL_SIGNING_PRIVATE_KEY",
		"  2. set LABEL_SIGNING_PUBLIC_KEY in wrangler.jsonc to the value above",
		"  3. bump LABEL_SIGNING_KEY_VERSION if you are rotating an existing key",
		"",
	].join("\n"),
);
