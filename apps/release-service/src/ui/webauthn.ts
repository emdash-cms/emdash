const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decode(value: unknown): ArrayBuffer {
	if (typeof value !== "string" || !BASE64URL_PATTERN.test(value) || value.length % 4 === 1) {
		throw new Error("Invalid passkey options");
	}
	const binary = atob(
		value
			.replaceAll("-", "+")
			.replaceAll("_", "/")
			.padEnd(value.length + ((4 - (value.length % 4)) % 4), "="),
	);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes.buffer;
}

function encode(value: ArrayBuffer): string {
	let binary = "";
	for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function descriptors(value: unknown): PublicKeyCredentialDescriptor[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error("Invalid passkey options");
	return value.map((item) => {
		if (!isRecord(item) || item["type"] !== "public-key") {
			throw new Error("Invalid passkey options");
		}
		const transports = item["transports"];
		if (
			transports !== undefined &&
			(!Array.isArray(transports) || transports.some((transport) => typeof transport !== "string"))
		) {
			throw new Error("Invalid passkey options");
		}
		return {
			type: "public-key",
			id: decode(item["id"]),
			...(transports ? { transports: transports.filter(isTransport) } : {}),
		};
	});
}

function isTransport(value: string): value is AuthenticatorTransport {
	return (
		value === "ble" ||
		value === "hybrid" ||
		value === "internal" ||
		value === "nfc" ||
		value === "usb"
	);
}

function userVerification(value: unknown): UserVerificationRequirement | undefined {
	return value === "discouraged" || value === "preferred" || value === "required"
		? value
		: undefined;
}

export function creationOptions(value: unknown): PublicKeyCredentialCreationOptions {
	if (
		!isRecord(value) ||
		!isRecord(value["rp"]) ||
		!isRecord(value["user"]) ||
		!Array.isArray(value["pubKeyCredParams"])
	) {
		throw new Error("Invalid passkey options");
	}
	const rp = value["rp"];
	const user = value["user"];
	if (
		typeof rp["name"] !== "string" ||
		(rp["id"] !== undefined && typeof rp["id"] !== "string") ||
		typeof user["name"] !== "string" ||
		typeof user["displayName"] !== "string"
	) {
		throw new Error("Invalid passkey options");
	}
	const pubKeyCredParams = value["pubKeyCredParams"].map((item): PublicKeyCredentialParameters => {
		if (!isRecord(item) || item["type"] !== "public-key" || !Number.isSafeInteger(item["alg"])) {
			throw new Error("Invalid passkey options");
		}
		return { type: "public-key", alg: Number(item["alg"]) };
	});
	const selection = isRecord(value["authenticatorSelection"])
		? value["authenticatorSelection"]
		: null;
	const attachment = selection?.["authenticatorAttachment"];
	const residentKey = selection?.["residentKey"];
	return {
		challenge: decode(value["challenge"]),
		rp: { name: rp["name"], ...(typeof rp["id"] === "string" ? { id: rp["id"] } : {}) },
		user: { id: decode(user["id"]), name: user["name"], displayName: user["displayName"] },
		pubKeyCredParams,
		...(Number.isSafeInteger(value["timeout"]) ? { timeout: Number(value["timeout"]) } : {}),
		...(descriptors(value["excludeCredentials"])
			? { excludeCredentials: descriptors(value["excludeCredentials"]) }
			: {}),
		...(selection
			? {
					authenticatorSelection: {
						...(attachment === "cross-platform" || attachment === "platform"
							? { authenticatorAttachment: attachment }
							: {}),
						...(residentKey === "discouraged" ||
						residentKey === "preferred" ||
						residentKey === "required"
							? { residentKey }
							: {}),
						...(typeof selection["requireResidentKey"] === "boolean"
							? { requireResidentKey: selection["requireResidentKey"] }
							: {}),
						...(userVerification(selection["userVerification"])
							? { userVerification: userVerification(selection["userVerification"]) }
							: {}),
					},
				}
			: {}),
		...(value["attestation"] === "direct" ||
		value["attestation"] === "enterprise" ||
		value["attestation"] === "indirect" ||
		value["attestation"] === "none"
			? { attestation: value["attestation"] }
			: {}),
	};
}

export function requestOptions(value: unknown): PublicKeyCredentialRequestOptions {
	if (!isRecord(value)) throw new Error("Invalid passkey options");
	return {
		challenge: decode(value["challenge"]),
		...(typeof value["rpId"] === "string" ? { rpId: value["rpId"] } : {}),
		...(Number.isSafeInteger(value["timeout"]) ? { timeout: Number(value["timeout"]) } : {}),
		...(descriptors(value["allowCredentials"])
			? { allowCredentials: descriptors(value["allowCredentials"]) }
			: {}),
		...(userVerification(value["userVerification"])
			? { userVerification: userVerification(value["userVerification"]) }
			: {}),
	};
}

export function registrationResponse(credential: PublicKeyCredential) {
	if (!(credential.response instanceof AuthenticatorAttestationResponse)) {
		throw new Error("Invalid passkey registration response");
	}
	return {
		id: credential.id,
		rawId: encode(credential.rawId),
		type: "public-key",
		response: {
			clientDataJSON: encode(credential.response.clientDataJSON),
			attestationObject: encode(credential.response.attestationObject),
			transports: credential.response.getTransports(),
		},
		...(credential.authenticatorAttachment
			? { authenticatorAttachment: credential.authenticatorAttachment }
			: {}),
	};
}

export function authenticationResponse(credential: PublicKeyCredential) {
	if (!(credential.response instanceof AuthenticatorAssertionResponse)) {
		throw new Error("Invalid passkey authentication response");
	}
	return {
		id: credential.id,
		rawId: encode(credential.rawId),
		type: "public-key",
		response: {
			clientDataJSON: encode(credential.response.clientDataJSON),
			authenticatorData: encode(credential.response.authenticatorData),
			signature: encode(credential.response.signature),
			...(credential.response.userHandle
				? { userHandle: encode(credential.response.userHandle) }
				: {}),
		},
		...(credential.authenticatorAttachment
			? { authenticatorAttachment: credential.authenticatorAttachment }
			: {}),
	};
}
