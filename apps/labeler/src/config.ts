const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+(?:[:][A-Za-z0-9._:%-]+)*$/;

export interface LabelerConfig {
	labelerDid: string;
}

export function getLabelerConfig(env: Pick<Env, "LABELER_DID">): LabelerConfig {
	if (!DID.test(env.LABELER_DID)) throw new TypeError("LABELER_DID must be a DID");
	return { labelerDid: env.LABELER_DID };
}
