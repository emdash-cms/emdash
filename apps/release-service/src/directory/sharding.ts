import { env } from "cloudflare:workers";

import type {
	DirectoryIdentityKind,
	IdentityDirectoryDurableObject,
} from "./identity-directory-do.js";

export async function identityDirectoryShard(did: string): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(did)),
	);
	return digest[0]!.toString(16).padStart(2, "0");
}

export async function registerDirectoryIdentity(
	kind: DirectoryIdentityKind,
	did: string,
	now = Date.now(),
	directory: DurableObjectNamespace<IdentityDirectoryDurableObject> = env.IDENTITY_DIRECTORY_DO,
): Promise<{ shard: string; created: boolean }> {
	const shard = await identityDirectoryShard(did);
	const result = await directory.getByName(shard).register(kind, did, now);
	return { shard, created: result.created };
}
