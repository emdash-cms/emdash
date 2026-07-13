type VerifierMethod = "fetchArtifact" | "fetchProvenance";

export type ReleaseVerifierResult =
	| { success: true; value: Uint8Array }
	| { success: false; error: { code: string; message: string } };

export interface ReleaseVerifierBinding {
	fetchArtifact(url: string): Promise<unknown>;
	fetchProvenance(url: string): Promise<unknown>;
}

export class VerifierUnavailableError extends Error {
	readonly retryable = true;

	constructor(options?: ErrorOptions) {
		super("Release verifier is unavailable", options);
		this.name = "VerifierUnavailableError";
	}
}

export async function fetchArtifact(
	binding: ReleaseVerifierBinding,
	url: string,
): Promise<ReleaseVerifierResult> {
	return callVerifier(binding, "fetchArtifact", url);
}

export async function fetchProvenance(
	binding: ReleaseVerifierBinding,
	url: string,
): Promise<ReleaseVerifierResult> {
	return callVerifier(binding, "fetchProvenance", url);
}

async function callVerifier(
	binding: ReleaseVerifierBinding,
	method: VerifierMethod,
	url: string,
): Promise<ReleaseVerifierResult> {
	try {
		const result = await binding[method](url);
		if (!isVerificationResult(result)) {
			throw new TypeError("Release verifier returned an invalid response");
		}
		return result;
	} catch (error) {
		if (error instanceof VerifierUnavailableError) throw error;
		throw new VerifierUnavailableError({ cause: error });
	}
}

function isVerificationResult(value: unknown): value is ReleaseVerifierResult {
	if (!isRecord(value) || typeof value["success"] !== "boolean") return false;
	if (value["success"] === true) return value["value"] instanceof Uint8Array;
	return isVerificationError(value["error"]);
}

function isVerificationError(value: unknown): value is { code: string; message: string } {
	return (
		isRecord(value) && typeof value["code"] === "string" && typeof value["message"] === "string"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
