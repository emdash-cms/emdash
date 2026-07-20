import { createLabelSigner } from "@emdash-cms/registry-moderation";

import type { LabelerIdentityConfig } from "./config.js";
import { serviceDidDocument } from "./identity.js";
import type { VersionedLabelSigner } from "./signing-rotation.js";

export interface LabelSigningSecret {
	get(): Promise<string>;
}

export async function createRuntimeSigner(
	config: LabelerIdentityConfig,
	secret: LabelSigningSecret,
): Promise<VersionedLabelSigner> {
	const signer = await createLabelSigner({
		issuerDid: config.labelerDid,
		privateKey: await secret.get(),
		resolveDid: async () => serviceDidDocument(config),
	});
	return {
		signer,
		keyVersion: config.signingKeyVersion,
		publicKeyMultibase: config.signingPublicKeyMultibase,
	};
}

export function getRuntimeSigningSecret(env: object): LabelSigningSecret {
	const binding: unknown = Reflect.get(env, "LABEL_SIGNING_PRIVATE_KEY");
	if (typeof binding === "string") return { get: async () => binding };
	if (isLabelSigningSecret(binding)) return binding;
	throw new TypeError("LABEL_SIGNING_PRIVATE_KEY is not configured");
}

function isLabelSigningSecret(value: unknown): value is LabelSigningSecret {
	return (
		typeof value === "object" && value !== null && "get" in value && typeof value.get === "function"
	);
}
