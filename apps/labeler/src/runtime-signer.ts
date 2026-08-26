import { createListingLabelSigner, type ListingLabelSigner } from "@emdash-cms/registry-moderation";

import { readLabelerRuntimeConfig } from "./runtime-config.js";

export async function createRuntimeListingLabelSigner(env: Env): Promise<ListingLabelSigner> {
	const config = await readLabelerRuntimeConfig(env);
	return createListingLabelSigner({
		issuerDid: config.labelerDid,
		privateKey: config.privateKey,
		resolveDid: async () => ({
			id: config.labelerDid,
			verificationMethod: [
				{
					id: `${config.labelerDid}#atproto_label`,
					type: "Multikey",
					controller: config.labelerDid,
					publicKeyMultibase: config.publicKeyMultibase,
				},
			],
		}),
	});
}
