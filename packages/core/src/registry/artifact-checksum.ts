import { verifyMultihash } from "@emdash-cms/registry-verification/checksum";

const SHA256_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;

export async function verifyRegistryArtifactChecksum(
	bytes: Uint8Array,
	checksum: string,
): Promise<boolean> {
	if (SHA256_HEX_PATTERN.test(checksum)) {
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
		const actual = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
		return actual === checksum.toLowerCase();
	}
	return (await verifyMultihash(bytes, checksum)).success;
}
