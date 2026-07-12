import type {
	VerificationError,
	VerificationResult,
} from "@emdash-cms/registry-verification/fetch";
import { VERIFICATION_ERROR_CODES } from "@emdash-cms/registry-verification/fetch";

type VerifierMethod = "fetchArtifact" | "fetchProvenance";
const VERIFICATION_ERROR_CODE_SET = new Set<string>(VERIFICATION_ERROR_CODES);

export interface ReleaseVerifierBinding {
	fetchArtifact(url: string): Promise<unknown>;
	fetchProvenance(url: string): Promise<unknown>;
}

export class VerifierUnavailableError extends Error {
	readonly retryable = true;

	constructor() {
		super("Release verifier is unavailable");
		this.name = "VerifierUnavailableError";
	}
}

export async function fetchArtifact(
	binding: ReleaseVerifierBinding,
	url: string,
): Promise<VerificationResult<Uint8Array>> {
	return callVerifier(binding, "fetchArtifact", url);
}

export async function fetchProvenance(
	binding: ReleaseVerifierBinding,
	url: string,
): Promise<VerificationResult<Uint8Array>> {
	return callVerifier(binding, "fetchProvenance", url);
}

async function callVerifier(
	binding: ReleaseVerifierBinding,
	method: VerifierMethod,
	url: string,
): Promise<VerificationResult<Uint8Array>> {
	try {
		const result = await binding[method](url);
		if (!isVerificationResult(result)) throw new VerifierUnavailableError();
		return result;
	} catch (error) {
		if (error instanceof VerifierUnavailableError) throw error;
		throw new VerifierUnavailableError();
	}
}

function isVerificationResult(value: unknown): value is VerificationResult<Uint8Array> {
	if (!isRecord(value) || typeof value["success"] !== "boolean") return false;
	if (value["success"] === true) return value["value"] instanceof Uint8Array;
	return isVerificationError(value["error"]);
}

function isVerificationError(value: unknown): value is VerificationError {
	return (
		isRecord(value) &&
		typeof value["code"] === "string" &&
		VERIFICATION_ERROR_CODE_SET.has(value["code"]) &&
		typeof value["message"] === "string"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
