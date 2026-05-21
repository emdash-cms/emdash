import type { LinkRecord } from "./types.js";

/**
 * Store a bidirectional link between GitHub and Discord accounts.
 * Two keys: github:{github_id} -> record, discord:{discord_id} -> record
 *
 * Cleans up stale keys from any previous link for either account
 * (e.g. Discord user relinks to a different GitHub account).
 */
export async function storeLink(kv: KVNamespace, record: LinkRecord): Promise<void> {
	// Check for existing links and clean up stale counterpart keys
	const [existingByDiscord, existingByGitHub] = await Promise.all([
		findByDiscordId(kv, record.discord_id),
		findByGitHubId(kv, record.github_id),
	]);

	const deletes: Promise<void>[] = [];
	// If this Discord user was linked to a different GitHub account, remove old github:{id} key
	if (existingByDiscord && existingByDiscord.github_id !== record.github_id) {
		deletes.push(kv.delete(`github:${existingByDiscord.github_id}`));
	}
	// If this GitHub account was linked to a different Discord user, remove old discord:{id} key
	if (existingByGitHub && existingByGitHub.discord_id !== record.discord_id) {
		deletes.push(kv.delete(`discord:${existingByGitHub.discord_id}`));
	}
	if (deletes.length > 0) {
		await Promise.all(deletes);
	}

	const value = JSON.stringify(record);
	await Promise.all([
		kv.put(`github:${record.github_id}`, value),
		kv.put(`discord:${record.discord_id}`, value),
	]);
}

/**
 * Look up a link by GitHub user ID.
 */
export async function findByGitHubId(
	kv: KVNamespace,
	githubId: number,
): Promise<LinkRecord | null> {
	const value = await kv.get(`github:${githubId}`);
	if (!value) return null;
	const record: LinkRecord = JSON.parse(value);
	return record;
}

/**
 * Look up a link by Discord user ID.
 */
export async function findByDiscordId(
	kv: KVNamespace,
	discordId: string,
): Promise<LinkRecord | null> {
	const value = await kv.get(`discord:${discordId}`);
	if (!value) return null;
	const record: LinkRecord = JSON.parse(value);
	return record;
}

/**
 * Check if a webhook delivery has already been processed (dedup).
 */
export async function isDeliveryProcessed(kv: KVNamespace, deliveryId: string): Promise<boolean> {
	return (await kv.get(`delivery:${deliveryId}`)) !== null;
}

/**
 * Mark a webhook delivery as processed. TTL 7 days.
 */
export async function markDeliveryProcessed(kv: KVNamespace, deliveryId: string): Promise<void> {
	await kv.put(`delivery:${deliveryId}`, "1", {
		expirationTtl: 7 * 24 * 60 * 60,
	});
}

/**
 * Store an OAuth state token. TTL 10 minutes.
 */
export async function storeOAuthState(
	kv: KVNamespace,
	state: string,
	data: { discord_id: string; discord_username: string },
): Promise<void> {
	await kv.put(`oauth:${state}`, JSON.stringify(data), {
		expirationTtl: 600,
	});
}

/**
 * Consume an OAuth state token (read + delete).
 */
export async function consumeOAuthState(
	kv: KVNamespace,
	state: string,
): Promise<{ discord_id: string; discord_username: string } | null> {
	const value = await kv.get(`oauth:${state}`);
	if (!value) return null;
	await kv.delete(`oauth:${state}`);
	const data: { discord_id: string; discord_username: string } = JSON.parse(value);
	return data;
}

/**
 * Record that a GitHub user has had a PR merged. No TTL -- permanent.
 * Value is the login (for display). We only need to know they contributed.
 */
export async function recordContributor(
	kv: KVNamespace,
	githubId: number,
	githubLogin: string,
): Promise<void> {
	await kv.put(`contributor:${githubId}`, githubLogin);
}

/**
 * Check if a GitHub user has ever had a PR merged.
 */
export async function hasContributed(kv: KVNamespace, githubId: number): Promise<boolean> {
	return (await kv.get(`contributor:${githubId}`)) !== null;
}
