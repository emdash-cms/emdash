import { MIGRATION_NAMES } from "../database/migrations/runner.js";
import { VERSION } from "../version.js";

export interface CoreMigrationIdentity {
	emdashVersion: string;
	names: readonly string[];
	fingerprint: string;
}

function encodeFingerprintInput(emdashVersion: string, names: readonly string[]): ArrayBuffer {
	const encoded = new TextEncoder().encode(JSON.stringify({ emdashVersion, names }));
	const buffer = new ArrayBuffer(encoded.byteLength);
	new Uint8Array(buffer).set(encoded);
	return buffer;
}

function encodeHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function fingerprintMigrationSet(
	emdashVersion: string,
	names: readonly string[],
): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		encodeFingerprintInput(emdashVersion, names),
	);
	return encodeHex(new Uint8Array(digest));
}

export async function createCoreMigrationIdentity(
	emdashVersion: string,
	names: readonly string[],
): Promise<CoreMigrationIdentity> {
	const nameSnapshot = Object.freeze([...names]);
	return Object.freeze({
		emdashVersion,
		names: nameSnapshot,
		fingerprint: await fingerprintMigrationSet(emdashVersion, nameSnapshot),
	});
}

export function getCoreMigrationIdentity(): Promise<CoreMigrationIdentity> {
	return createCoreMigrationIdentity(VERSION, MIGRATION_NAMES);
}
