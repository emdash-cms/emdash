import { sha256 } from "@oslojs/crypto/sha2";
import { decodeBase64urlIgnorePadding, encodeBase64urlNoPadding } from "@oslojs/encoding";

declare const challengeContextType: unique symbol;
const CONTEXT_TYPE_PATTERN = /^[a-z][a-z0-9._:-]{0,127}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_SERIALIZED_CONTEXT_LENGTH = 16 * 1024;
const CONTEXT_CHALLENGE_VERSION = 1;

export type SerializedChallengeContext<Type extends string = string> = string & {
	readonly [challengeContextType]: Type;
};

export interface ChallengeContextCodec<Type extends string, Context> {
	readonly type: Type;
	readonly version: number;
	readonly parse: (value: unknown) => Context;
}

export interface ChallengeContextBinding<Type extends string, Context> {
	readonly codec: ChallengeContextCodec<Type, Context>;
	readonly value: Context;
}

export type ChallengeContextErrorCode =
	| "malformed_context"
	| "context_type_mismatch"
	| "context_version_mismatch"
	| "context_binding_mismatch";

export class ChallengeContextError extends Error {
	constructor(
		public readonly code: ChallengeContextErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "ChallengeContextError";
	}
}

export function defineChallengeContext<Type extends string, Context>(
	type: Type,
	version: number,
	parse: (value: unknown) => Context,
): ChallengeContextCodec<Type, Context> {
	if (!CONTEXT_TYPE_PATTERN.test(type)) {
		throw new Error("Challenge context type must be a non-empty stable identifier");
	}
	if (!Number.isSafeInteger(version) || version < 1) {
		throw new Error("Challenge context version must be a positive safe integer");
	}
	return { type, version, parse };
}

export function bindChallengeContext<Type extends string, Context>(
	codec: ChallengeContextCodec<Type, Context>,
	value: NoInfer<Context>,
): ChallengeContextBinding<Type, Context> {
	return { codec, value };
}

function canonicalize(value: unknown): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("Challenge context numbers must be finite");
		return value;
	}
	if (Array.isArray(value)) return value.map(canonicalize);
	if (typeof value === "object") {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError("Challenge context must contain only plain objects");
		}
		const result: Record<string, unknown> = Object.create(null);
		const entries = Object.entries(value).toSorted(([left], [right]) =>
			left < right ? -1 : left > right ? 1 : 0,
		);
		for (const [key, item] of entries) {
			if (item === undefined) throw new TypeError("Challenge context cannot contain undefined");
			result[key] = canonicalize(item);
		}
		return result;
	}
	throw new TypeError("Challenge context must be JSON-serializable");
}

function serializeEnvelope(type: string, version: number, context: unknown): string {
	return JSON.stringify({ context: canonicalize(context), type, version });
}

export function encodeChallengeContext<Type extends string, Context>(
	codec: ChallengeContextCodec<Type, Context>,
	context: NoInfer<Context>,
): SerializedChallengeContext<Type> {
	const serialized = serializeEnvelope(codec.type, codec.version, context);
	const encoded = encodeBase64urlNoPadding(new TextEncoder().encode(serialized));
	if (encoded.length > MAX_SERIALIZED_CONTEXT_LENGTH) {
		throw new TypeError("Challenge context exceeds the maximum serialized size");
	}
	// The runtime value remains a string; the brand prevents cross-purpose assignment.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	return encoded as SerializedChallengeContext<Type>;
}

export function createContextBoundChallenge(nonce: string, serializedContext: string): string {
	const contextDigest = encodeBase64urlNoPadding(
		sha256(new TextEncoder().encode(serializedContext)),
	);
	const serialized = JSON.stringify({
		contextDigest,
		nonce,
		version: CONTEXT_CHALLENGE_VERSION,
	});
	return encodeBase64urlNoPadding(new TextEncoder().encode(serialized));
}

export function verifyContextBoundChallenge(challenge: string, serializedContext: string): void {
	let value: unknown;
	try {
		if (!BASE64URL_PATTERN.test(challenge)) throw malformedContext();
		const bytes = decodeBase64urlIgnorePadding(challenge);
		if (encodeBase64urlNoPadding(bytes) !== challenge) throw malformedContext();
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch (error) {
		if (error instanceof ChallengeContextError) throw error;
		throw malformedContext(error);
	}
	if (!isRecord(value)) {
		throw malformedContext();
	}
	const envelope = value;
	if (
		Object.keys(envelope).length !== 3 ||
		typeof envelope.contextDigest !== "string" ||
		typeof envelope.nonce !== "string" ||
		envelope.nonce.length !== 43 ||
		!BASE64URL_PATTERN.test(envelope.nonce) ||
		envelope.version !== CONTEXT_CHALLENGE_VERSION
	) {
		throw malformedContext();
	}
	const canonical = createContextBoundChallenge(envelope.nonce, serializedContext);
	if (canonical !== challenge) {
		throw new ChallengeContextError(
			"context_binding_mismatch",
			"Challenge context does not match challenge",
		);
	}
}

function malformedContext(cause?: unknown): ChallengeContextError {
	return new ChallengeContextError("malformed_context", "Malformed challenge context", { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeChallengeContext<Type extends string, Context>(
	serialized: string,
	codec: ChallengeContextCodec<Type, Context>,
): Context {
	let value: unknown;
	try {
		if (serialized.length > MAX_SERIALIZED_CONTEXT_LENGTH || !BASE64URL_PATTERN.test(serialized)) {
			throw malformedContext();
		}
		const bytes = decodeBase64urlIgnorePadding(serialized);
		if (encodeBase64urlNoPadding(bytes) !== serialized) throw malformedContext();
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch (error) {
		if (error instanceof ChallengeContextError) throw error;
		throw malformedContext(error);
	}

	if (!isRecord(value)) {
		throw malformedContext();
	}
	const envelope = value;
	if (
		Object.keys(envelope).length !== 3 ||
		!("context" in envelope) ||
		typeof envelope.type !== "string" ||
		typeof envelope.version !== "number"
	) {
		throw malformedContext();
	}
	if (envelope.type !== codec.type) {
		throw new ChallengeContextError(
			"context_type_mismatch",
			`Challenge context type mismatch: expected ${codec.type}`,
		);
	}
	if (envelope.version !== codec.version) {
		throw new ChallengeContextError(
			"context_version_mismatch",
			`Challenge context version mismatch: expected ${codec.version}`,
		);
	}

	let canonical: string;
	try {
		canonical = encodeBase64urlNoPadding(
			new TextEncoder().encode(
				serializeEnvelope(envelope.type, envelope.version, envelope.context),
			),
		);
	} catch (error) {
		throw malformedContext(error);
	}
	if (canonical !== serialized) throw malformedContext();

	return codec.parse(envelope.context);
}
