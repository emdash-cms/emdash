import { DurableObject } from "cloudflare:workers";

import { addRole, getRoleState, postMessage, postMessageWithNonce, removeRole } from "./discord.js";
import { findByDiscordId, findByGitHubId, hasContributed } from "./kv.js";
import type { LinkRecord } from "./types.js";

const githubKey = (id: number) => `github:${id}`;
const discordKey = (id: string) => `discord:${id}`;
const retiredGithubKey = (id: number) => `retired:github:${id}`;
const retiredDiscordKey = (id: string) => `retired:discord:${id}`;
const contributedKey = (id: number) => `contributed:${id}`;
const everLinkedKey = (id: number) => `ever-linked:${id}`;
const welcomePendingKey = (id: number) => `welcome-pending:${id}`;
const welcomeDeliveryKey = (id: number) => `welcome-delivery:${id}`;
const linkGenerationKey = (id: string) => `link-generation:${id}`;
const roleGrantKey = (id: number) => `role-granted:${id}`;
const UNLINK_REPLAY_PREFIX = "unlink:";
const UNLINK_REPLAY_TTL_MS = 10 * 60 * 1000;
// Discord deduplicates recent nonces, not messages retried indefinitely.
const WELCOME_RETRY_BUDGET_MS = 15_000;
const WELCOME_MAX_ATTEMPTS = 2;

type UnlinkResult = { unlinked: boolean; roleRemoved: boolean };

interface RoleGrantRecord {
	discordId: string;
	roleId: string;
}

interface WelcomeDeliveryRecord {
	discordId: string;
	channelId: string;
	content: string;
	nonce: string;
	startedAt: number;
	nextAttemptAt: number;
	attempts: number;
	status: "pending" | "sent" | "unresolved";
	messageId?: string;
}

interface UnlinkReplayRecord {
	result: UnlinkResult;
	expiresAt: number;
}

/**
 * One global instance owns account links so concurrent callbacks and webhooks
 * cannot act on different versions of the same GitHub/Discord pairing.
 */
export class ContributorLinks extends DurableObject<Env> {
	private pending: Promise<void> = Promise.resolve();

	private exclusive<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.pending.then(operation, operation);
		this.pending = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	override alarm(): Promise<void> {
		return this.exclusive(() => this.deleteExpiredUnlinkReplays(Date.now()));
	}

	getLinkContext(discordId: string): Promise<{ existing: LinkRecord | null; generation: number }> {
		return this.exclusive(async () => ({
			existing: await this.lookupDiscord(discordId),
			generation: (await this.ctx.storage.get<number>(linkGenerationKey(discordId))) ?? 0,
		}));
	}

	getByGitHubId(githubId: number): Promise<LinkRecord | null> {
		return this.exclusive(() => this.lookupGitHub(githubId));
	}

	link(
		record: LinkRecord,
		generation: number,
	): Promise<
		| { status: "stale" }
		| {
				status: "linked";
				contributed: boolean;
				roleGranted: boolean;
				shouldWelcome: boolean;
		  }
	> {
		return this.exclusive(async () => {
			if (
				((await this.ctx.storage.get<number>(linkGenerationKey(record.discord_id))) ?? 0) !==
				generation
			) {
				return { status: "stale" as const };
			}
			const previousGitHubLink = await this.lookupGitHub(record.github_id);
			const previousDiscordLink = await this.lookupDiscord(record.discord_id);
			const contributed =
				Boolean(await this.ctx.storage.get<boolean>(contributedKey(record.github_id))) ||
				(await hasContributed(this.env.KV, record.github_id));
			let firstLink = !(await this.ctx.storage.get<boolean>(everLinkedKey(record.github_id)));
			if (firstLink) {
				const [legacyGitHub, legacyDiscord] = await Promise.all([
					findByGitHubId(this.env.KV, record.github_id),
					findByDiscordId(this.env.KV, record.discord_id),
				]);
				firstLink =
					legacyGitHub?.github_id !== record.github_id &&
					legacyDiscord?.github_id !== record.github_id;
			}

			const newMemberRole = await getRoleState(
				this.env,
				record.discord_id,
				this.env.DISCORD_CONTRIBUTOR_ROLE_ID,
			);
			if (newMemberRole === "member_missing") {
				throw new Error("Discord member is not in the configured guild");
			}
			const oldDiscordId =
				previousGitHubLink?.discord_id !== record.discord_id
					? previousGitHubLink?.discord_id
					: undefined;
			let oldRoleRemoved = false;
			let replacedRoleRemoved = false;
			let roleGranted = false;
			let roleGrantAttempted = false;
			try {
				if (oldDiscordId) {
					oldRoleRemoved = await this.revokeRole(oldDiscordId, record.github_id);
				}
				if (!contributed && newMemberRole === "present") {
					replacedRoleRemoved = await this.revokeRole(
						record.discord_id,
						previousDiscordLink?.github_id,
					);
				}
				if (contributed && newMemberRole === "absent") {
					roleGrantAttempted = true;
					roleGranted = await addRole(
						this.env,
						record.discord_id,
						this.env.DISCORD_CONTRIBUTOR_ROLE_ID,
					);
					if (!roleGranted) throw new Error("Discord rejected Contributor role grant");
				}

				await this.ctx.storage.transaction(async (transaction) => {
					await transaction.put(linkGenerationKey(record.discord_id), generation + 1);
					if (oldDiscordId) {
						const oldGeneration =
							(await transaction.get<number>(linkGenerationKey(oldDiscordId))) ?? 0;
						await transaction.put(linkGenerationKey(oldDiscordId), oldGeneration + 1);
						await transaction.delete(discordKey(oldDiscordId));
						await transaction.put(retiredDiscordKey(oldDiscordId), true);
					}
					if (previousDiscordLink && previousDiscordLink.github_id !== record.github_id) {
						await transaction.delete(githubKey(previousDiscordLink.github_id));
						await transaction.delete(roleGrantKey(previousDiscordLink.github_id));
						await transaction.put(retiredGithubKey(previousDiscordLink.github_id), true);
					}
					await transaction.put(githubKey(record.github_id), record);
					await transaction.put(discordKey(record.discord_id), record);
					await transaction.put(retiredGithubKey(record.github_id), true);
					await transaction.put(retiredDiscordKey(record.discord_id), true);
					await transaction.put(everLinkedKey(record.github_id), true);
					if (contributed) await transaction.put(contributedKey(record.github_id), true);
					if (contributed) {
						await transaction.put(roleGrantKey(record.github_id), {
							discordId: record.discord_id,
							roleId: this.env.DISCORD_CONTRIBUTOR_ROLE_ID,
						} satisfies RoleGrantRecord);
					} else {
						await transaction.delete(roleGrantKey(record.github_id));
					}
					if (firstLink && contributed && newMemberRole === "absent") {
						await transaction.put(welcomePendingKey(record.github_id), true);
					}
				});
			} catch (error) {
				if (roleGrantAttempted) await this.tryRevokeRole(record.discord_id);
				if (replacedRoleRemoved) await this.tryRestoreRole(record.discord_id);
				if (oldRoleRemoved && oldDiscordId) await this.tryRestoreRole(oldDiscordId);
				throw error;
			}

			await this.deleteLegacyLinks(record, previousGitHubLink, previousDiscordLink);

			const shouldWelcome =
				contributed &&
				Boolean(await this.ctx.storage.get<boolean>(welcomePendingKey(record.github_id)));
			return { status: "linked" as const, contributed, roleGranted, shouldWelcome };
		});
	}

	postWelcomeIfLinked(githubId: number, discordId: string, content: string): Promise<boolean> {
		return this.exclusive(async () => {
			const link = await this.lookupGitHub(githubId);
			if (link?.discord_id !== discordId) return false;
			if (!(await this.ctx.storage.get<boolean>(welcomePendingKey(githubId)))) return false;
			const key = welcomeDeliveryKey(githubId);
			const delivery = (await this.ctx.storage.get<WelcomeDeliveryRecord>(key)) ?? {
				discordId,
				channelId: this.env.DISCORD_CHANNEL_ID,
				content,
				nonce: crypto.randomUUID().replaceAll("-", "").slice(0, 25),
				startedAt: Date.now(),
				nextAttemptAt: Date.now(),
				attempts: 0,
				status: "pending",
			};
			if (delivery.status !== "pending") return false;
			const deadline = delivery.startedAt + WELCOME_RETRY_BUDGET_MS;
			while (
				delivery.discordId === discordId &&
				delivery.channelId === this.env.DISCORD_CHANNEL_ID &&
				delivery.attempts < WELCOME_MAX_ATTEMPTS &&
				Math.max(Date.now(), delivery.nextAttemptAt) < deadline
			) {
				const delay = delivery.nextAttemptAt - Date.now();
				if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
				if (Date.now() >= deadline) break;
				delivery.attempts++;
				await this.ctx.storage.put(key, delivery);
				if (Date.now() >= deadline) break;
				const result = await postMessageWithNonce(
					this.env,
					delivery.channelId,
					delivery.content,
					[delivery.discordId],
					delivery.nonce,
					deadline - Date.now(),
				);
				if (result.status === "sent") {
					await this.ctx.storage.transaction(async (transaction) => {
						await transaction.put(key, {
							...delivery,
							status: "sent",
							messageId: result.messageId,
						});
						await transaction.delete(welcomePendingKey(githubId));
					});
					return true;
				}
				if (result.status === "rejected") break;
				delivery.nextAttemptAt = Date.now() + result.retryAfterMs;
				await this.ctx.storage.put(key, delivery);
			}
			delivery.status = "unresolved";
			await this.ctx.storage.put(key, delivery);
			console.error("Contributor welcome delivery could not be confirmed", { githubId });
			return false;
		});
	}

	postMergeIfLinked(githubId: number, discordId: string, content: string): Promise<boolean> {
		return this.exclusive(async () => {
			const link = await this.lookupGitHub(githubId);
			if (link?.discord_id !== discordId) return false;
			return postMessage(this.env, this.env.DISCORD_CHANNEL_ID, content, [discordId]);
		});
	}

	unlink(discordId: string, interactionId: string): Promise<UnlinkResult> {
		return this.exclusive(async () => {
			const now = Date.now();
			const interactionKey = `${UNLINK_REPLAY_PREFIX}${interactionId}`;
			const previous = await this.ctx.storage.get<UnlinkReplayRecord>(interactionKey);
			if (previous && previous.expiresAt > now) return previous.result;

			const link = await this.lookupDiscord(discordId);
			const roleRemoved = await this.revokeRole(discordId, link?.github_id);
			const result = { unlinked: Boolean(link), roleRemoved };
			try {
				await this.ctx.storage.transaction(async (transaction) => {
					const generation = (await transaction.get<number>(linkGenerationKey(discordId))) ?? 0;
					if (link) {
						await transaction.delete(githubKey(link.github_id));
						await transaction.delete(roleGrantKey(link.github_id));
						await transaction.put(retiredGithubKey(link.github_id), true);
					}
					await transaction.delete(discordKey(discordId));
					await transaction.put(retiredDiscordKey(discordId), true);
					await transaction.put(linkGenerationKey(discordId), generation + 1);
					await this.storeUnlinkReplay(transaction, interactionKey, result, now);
				});
			} catch (error) {
				if (roleRemoved) await this.tryRestoreRole(discordId);
				throw error;
			}
			if (link) await this.deleteLegacyLinks(link);
			else await this.deleteLegacyKeys([discordKey(discordId)]);
			return result;
		});
	}

	grantRoleForGitHub(githubId: number): Promise<{ linked: boolean; discordId?: string }> {
		return this.exclusive(async () => {
			await this.ctx.storage.put(contributedKey(githubId), true);
			const link = await this.lookupGitHub(githubId);
			if (!link) return { linked: false };
			const confirmed = await this.ctx.storage.get<RoleGrantRecord>(roleGrantKey(githubId));
			if (
				confirmed?.discordId === link.discord_id &&
				confirmed.roleId === this.env.DISCORD_CONTRIBUTOR_ROLE_ID
			) {
				return { linked: true, discordId: link.discord_id };
			}

			const state = await getRoleState(
				this.env,
				link.discord_id,
				this.env.DISCORD_CONTRIBUTOR_ROLE_ID,
			);
			// A member who left the guild cannot receive the role or be mentioned.
			// Keep the link so they can relink after rejoining.
			if (state === "member_missing") return { linked: true };
			if (state === "absent") {
				const granted = await addRole(
					this.env,
					link.discord_id,
					this.env.DISCORD_CONTRIBUTOR_ROLE_ID,
				);
				if (!granted) throw new Error("Discord rejected Contributor role grant");
			}
			await this.ctx.storage.put(roleGrantKey(githubId), {
				discordId: link.discord_id,
				roleId: this.env.DISCORD_CONTRIBUTOR_ROLE_ID,
			} satisfies RoleGrantRecord);
			return { linked: true, discordId: link.discord_id };
		});
	}

	private async revokeRole(discordId: string, githubId?: number): Promise<boolean> {
		const state = await getRoleState(this.env, discordId, this.env.DISCORD_CONTRIBUTOR_ROLE_ID);
		if (state !== "present") return false;
		if (githubId !== undefined) await this.ctx.storage.delete(roleGrantKey(githubId));
		try {
			const removed = await removeRole(this.env, discordId, this.env.DISCORD_CONTRIBUTOR_ROLE_ID);
			if (!removed) throw new Error("Discord rejected Contributor role removal");
		} catch (error) {
			await this.tryRestoreRole(discordId);
			throw error;
		}
		return true;
	}

	private async tryRestoreRole(discordId: string): Promise<void> {
		try {
			const restored = await addRole(this.env, discordId, this.env.DISCORD_CONTRIBUTOR_ROLE_ID);
			if (!restored) console.error("Could not restore Contributor role");
		} catch (error) {
			console.error("Could not restore Contributor role", error);
		}
	}

	private async tryRevokeRole(discordId: string): Promise<void> {
		try {
			const state = await getRoleState(this.env, discordId, this.env.DISCORD_CONTRIBUTOR_ROLE_ID);
			if (state === "present") {
				const removed = await removeRole(this.env, discordId, this.env.DISCORD_CONTRIBUTOR_ROLE_ID);
				if (!removed) console.error("Could not roll back Contributor role");
			}
		} catch (error) {
			console.error("Could not roll back Contributor role", error);
		}
	}

	private async deleteLegacyLinks(...links: (LinkRecord | null)[]): Promise<void> {
		const keys = new Set<string>();
		for (const link of links) {
			if (!link) continue;
			keys.add(githubKey(link.github_id));
			keys.add(discordKey(link.discord_id));
		}
		await this.deleteLegacyKeys([...keys]);
	}

	private async deleteLegacyKeys(keys: string[]): Promise<void> {
		const results = await Promise.allSettled(keys.map((key) => this.env.KV.delete(key)));
		for (const result of results) {
			if (result.status === "rejected") {
				console.error("Could not delete a retired legacy account link", result.reason);
			}
		}
	}

	private async storeUnlinkReplay(
		transaction: DurableObjectTransaction,
		interactionKey: string,
		result: UnlinkResult,
		now: number,
	): Promise<void> {
		const expiresAt = now + UNLINK_REPLAY_TTL_MS;
		await transaction.put(interactionKey, { result, expiresAt } satisfies UnlinkReplayRecord);
		const alarm = await transaction.getAlarm();
		if (alarm === null || alarm > expiresAt) await transaction.setAlarm(expiresAt);
	}

	private async deleteExpiredUnlinkReplays(now: number): Promise<void> {
		await this.ctx.storage.transaction(async (transaction) => {
			const records = await transaction.list<UnlinkReplayRecord>({
				prefix: UNLINK_REPLAY_PREFIX,
			});
			const expired: string[] = [];
			let nextExpiry: number | undefined;
			for (const [key, record] of records) {
				if (!record || !Number.isFinite(record.expiresAt) || record.expiresAt <= now) {
					expired.push(key);
					continue;
				}
				nextExpiry = Math.min(nextExpiry ?? record.expiresAt, record.expiresAt);
			}
			if (expired.length > 0) await transaction.delete(expired);
			if (nextExpiry === undefined) await transaction.deleteAlarm();
			else await transaction.setAlarm(nextExpiry);
		});
	}

	private async lookupGitHub(githubId: number): Promise<LinkRecord | null> {
		const current = await this.ctx.storage.get<LinkRecord>(githubKey(githubId));
		if (current) return current;
		if (await this.ctx.storage.get<boolean>(retiredGithubKey(githubId))) return null;

		const legacy = await findByGitHubId(this.env.KV, githubId);
		if (!legacy) return null;
		const counterpart = await findByDiscordId(this.env.KV, legacy.discord_id);
		if (counterpart?.github_id !== githubId) {
			return null;
		}
		return this.importLegacy(legacy);
	}

	private async lookupDiscord(discordId: string): Promise<LinkRecord | null> {
		const current = await this.ctx.storage.get<LinkRecord>(discordKey(discordId));
		if (current) return current;
		if (await this.ctx.storage.get<boolean>(retiredDiscordKey(discordId))) return null;

		const legacy = await findByDiscordId(this.env.KV, discordId);
		if (!legacy) return null;
		const counterpart = await findByGitHubId(this.env.KV, legacy.github_id);
		if (counterpart?.discord_id !== discordId) {
			return null;
		}
		return this.importLegacy(legacy);
	}

	private async importLegacy(record: LinkRecord): Promise<LinkRecord | null> {
		const [currentGitHub, currentDiscord, retiredGitHub, retiredDiscord] = await Promise.all([
			this.ctx.storage.get<LinkRecord>(githubKey(record.github_id)),
			this.ctx.storage.get<LinkRecord>(discordKey(record.discord_id)),
			this.ctx.storage.get<boolean>(retiredGithubKey(record.github_id)),
			this.ctx.storage.get<boolean>(retiredDiscordKey(record.discord_id)),
		]);
		if (retiredGitHub || retiredDiscord) return null;
		if (currentGitHub || currentDiscord) {
			if (
				currentGitHub?.discord_id !== record.discord_id ||
				currentDiscord?.github_id !== record.github_id
			) {
				throw new Error("Legacy link conflicts with current link");
			}
			return record;
		}
		await this.ctx.storage.transaction(async (transaction) => {
			await transaction.put(githubKey(record.github_id), record);
			await transaction.put(discordKey(record.discord_id), record);
			await transaction.put(retiredGithubKey(record.github_id), true);
			await transaction.put(retiredDiscordKey(record.discord_id), true);
			await transaction.put(everLinkedKey(record.github_id), true);
		});
		return record;
	}
}
