import type { MigrationTarget } from "./protocol.js";

const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function encodeHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createMigrationTarget(
	kind: string,
	label: string,
	identity: readonly string[],
): Promise<MigrationTarget> {
	const encoded = new TextEncoder().encode(JSON.stringify({ kind, identity }));
	const digest = await crypto.subtle.digest("SHA-256", encoded);
	return {
		kind,
		label,
		fingerprint: encodeHex(new Uint8Array(digest)),
	};
}

export function requireMigrationEnvironment(
	name: unknown,
	env: Readonly<Record<string, string | undefined>>,
): string {
	if (typeof name !== "string" || !ENVIRONMENT_VARIABLE_PATTERN.test(name)) {
		throw new Error("Migration credential environment variable name is invalid.");
	}
	const value = env[name];
	if (!value) {
		throw new Error(`Migration credential environment variable ${name} is not set.`);
	}
	return value;
}
