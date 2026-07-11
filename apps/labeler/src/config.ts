import { P256PublicKey, parsePublicMultikey } from "@atcute/crypto";

const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+(?:[:][A-Za-z0-9._:%-]+)*$/;
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const DID_WEB_HOST = /^did:web:([^:]+)$/;

export interface LabelerConfig {
	labelerDid: string;
	signingKeyVersion: string;
}

export interface LabelerIdentityConfig extends LabelerConfig {
	serviceUrl: string;
	signingPublicKeyMultibase: string;
}

interface LabelerBindings {
	LABELER_DID: string;
	LABEL_SIGNING_KEY_VERSION: string;
}

interface LabelerIdentityBindings extends LabelerBindings {
	LABELER_SERVICE_URL: string;
	LABEL_SIGNING_PUBLIC_KEY: string;
}

export function getLabelerConfig(env: LabelerBindings): LabelerConfig {
	if (!DID.test(env.LABELER_DID)) throw new TypeError("LABELER_DID must be a DID");
	if (!KEY_VERSION.test(env.LABEL_SIGNING_KEY_VERSION))
		throw new TypeError("LABEL_SIGNING_KEY_VERSION is invalid");
	return { labelerDid: env.LABELER_DID, signingKeyVersion: env.LABEL_SIGNING_KEY_VERSION };
}

export async function getLabelerIdentityConfig(
	env: LabelerIdentityBindings,
): Promise<LabelerIdentityConfig> {
	const config = getLabelerConfig(env);
	await validatePublicMultikey(env.LABEL_SIGNING_PUBLIC_KEY);
	let serviceUrl: URL;
	try {
		serviceUrl = new URL(env.LABELER_SERVICE_URL);
	} catch {
		throw new TypeError("LABELER_SERVICE_URL must be an HTTPS origin");
	}
	if (
		serviceUrl.protocol !== "https:" ||
		serviceUrl.origin !== env.LABELER_SERVICE_URL ||
		serviceUrl.username !== "" ||
		serviceUrl.password !== ""
	)
		throw new TypeError("LABELER_SERVICE_URL must be an HTTPS origin");
	const didHost = DID_WEB_HOST.exec(config.labelerDid)?.[1];
	let didOrigin: URL;
	let decodedDidHost: string;
	try {
		decodedDidHost = decodeURIComponent(didHost ?? "");
		didOrigin = new URL(`https://${decodedDidHost}`);
	} catch {
		throw new TypeError("LABELER_DID must be a host-level did:web identity");
	}
	if (!didHost || didOrigin.origin !== `https://${decodedDidHost}`)
		throw new TypeError("LABELER_DID must be a host-level did:web identity");
	if (didOrigin.host !== serviceUrl.host)
		throw new TypeError("LABELER_DID must match LABELER_SERVICE_URL");
	return {
		...config,
		serviceUrl: serviceUrl.origin,
		signingPublicKeyMultibase: env.LABEL_SIGNING_PUBLIC_KEY,
	};
}

async function validatePublicMultikey(value: string): Promise<void> {
	try {
		const parsed = parsePublicMultikey(value);
		if (
			parsed.type !== "p256" ||
			parsed.publicKeyBytes.length !== 33 ||
			![2, 3].includes(parsed.publicKeyBytes[0]!)
		)
			throw new TypeError();
		const key = await P256PublicKey.importRaw(parsed.publicKeyBytes);
		if ((await key.exportPublicKey("multikey")) !== value) throw new TypeError();
	} catch {
		throw new TypeError("LABEL_SIGNING_PUBLIC_KEY must be a canonical P-256 Multikey");
	}
}
