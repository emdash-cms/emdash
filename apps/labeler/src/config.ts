const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+(?:[:][A-Za-z0-9._:%-]+)*$/;
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export interface LabelerConfig {
	labelerDid: string;
	signingKeyVersion: string;
}

export function getLabelerConfig(
	env: Pick<Env, "LABELER_DID" | "LABEL_SIGNING_KEY_VERSION">,
): LabelerConfig {
	if (!DID.test(env.LABELER_DID)) throw new TypeError("LABELER_DID must be a DID");
	if (!KEY_VERSION.test(env.LABEL_SIGNING_KEY_VERSION))
		throw new TypeError("LABEL_SIGNING_KEY_VERSION is invalid");
	return { labelerDid: env.LABELER_DID, signingKeyVersion: env.LABEL_SIGNING_KEY_VERSION };
}
