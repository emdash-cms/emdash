import { DurableObject } from "cloudflare:workers";

import { addRole, getRoleState, postMessage, removeRole } from "./discord.js";
import { findByDiscordId, findByGitHubId, hasContributed } from "./kv.js";
import type { LinkRecord } from "./types.js";

const githubKey = (id: number) => `github:${id}`;
const discordKey = (id: string) => `discord:${id}`;
const retiredGithubKey = (id: number) => `retired:github:${id}`;
const retiredDiscordKey = (id: string) => `retired:discord:${id}`;
const contributedKey = (id: number) => `contributed:${id}`;
const everLinkedKey = (id: number) => `ever-linked:${id}`;
const welcomePendingKey = (id: number) => `welcome-pending:${id}`;
const linkGenerationKey = (id: string) => `link-generation:${id}`;

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
			const firstLink = !(await this.ctx.storage.get<boolean>(everLinkedKey(record.github_id)));

			const newMemberRole = await getRoleState(
				this.env,
				record.discord_id,
				this.env.DISCORD_CONTRIBUTOR_ROLE_ID,
			);
			if (newMemberRole === "member_missing") {
				throw new Error("Discord member is not in the configured guild");
			}
			if (previousGitHubLink && previousGitHubLink.discord_id !== record.discord_id) {
				await this.revokeRole(previousGitHubLink.discord_id);
			}
			if (!contributed && previousDiscordLink?.github_id !== record.github_id) {
				if (previousDiscordLink && newMemberRole === "present") {
					await this.revokeRole(record.discord_id);
				}
			}
			await this.deleteLegacyLinks(previousGitHubLink, previousDiscordLink);

			await this.ctx.storage.transaction(async (transaction) => {
				await transaction.put(linkGenerationKey(record.discord_id), generation + 1);
				if (previousGitHubLink && previousGitHubLink.discord_id !== record.discord_id) {
					const oldDiscordId = previousGitHubLink.discord_id;
					const oldGeneration =
						(await transaction.get<number>(linkGenerationKey(oldDiscordId))) ?? 0;
					await transaction.put(linkGenerationKey(oldDiscordId), oldGeneration + 1);
					await transaction.delete(discordKey(previousGitHubLink.discord_id));
					await transaction.put(retiredDiscordKey(previousGitHubLink.discord_id), true);
				}
				if (previousDiscordLink && previousDiscordLink.github_id !== record.github_id) {
					await transaction.delete(githubKey(previousDiscordLink.github_id));
					await transaction.put(retiredGithubKey(previousDiscordLink.github_id), true);
				}
				await transaction.put(githubKey(record.github_id), record);
				await transaction.put(discordKey(record.discord_id), record);
				await transaction.put(retiredGithubKey(record.github_id), true);
				await transaction.put(retiredDiscordKey(record.discord_id), true);
				await transaction.put(everLinkedKey(record.github_id), true);
				if (contributed) await transaction.put(contributedKey(record.github_id), true);
				if (firstLink && contributed && newMemberRole === "absent") {
					await transaction.put(welcomePendingKey(record.github_id), true);
				}
			});

			let roleGranted = false;
			if (contributed && newMemberRole === "absent") {
				roleGranted = await addRole(
					this.env,
					record.discord_id,
					this.env.DISCORD_CONTRIBUTOR_ROLE_ID,
				);
				if (!roleGranted) throw new Error("Discord rejected Contributor role grant");
			}

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
			// Claim before posting so a retry cannot send the welcome a second time.
			await this.ctx.storage.delete(welcomePendingKey(githubId));
			return postMessage(this.env, this.env.DISCORD_CHANNEL_ID, content, [discordId]);
		});
	}

	postMergeIfLinked(githubId: number, discordId: string, content: string): Promise<boolean> {
		return this.exclusive(async () => {
			const link = await this.lookupGitHub(githubId);
			if (link?.discord_id !== discordId) return false;
			return postMessage(this.env, this.env.DISCORD_CHANNEL_ID, content, [discordId]);
		});
	}

	unlink(discordId: string, interactionId: string): Promise<{ unlinked: boolean }> {
		return this.exclusive(async () => {
			const interactionKey = `unlink:${interactionId}`;
			const previousResult = await this.ctx.storage.get<{ unlinked: boolean }>(interactionKey);
			if (previousResult) return previousResult;

			const link = await this.lookupDiscord(discordId);
			if (!link) {
				const result = { unlinked: false };
				await this.ctx.storage.transaction(async (transaction) => {
					const generation = (await transaction.get<number>(linkGenerationKey(discordId))) ?? 0;
					await transaction.put(linkGenerationKey(discordId), generation + 1);
					await transaction.put(interactionKey, result);
				});
				return result;
			}

			await this.revokeRole(discordId);
			await this.deleteLegacyLinks(link);
			const result = { unlinked: true };
			await this.ctx.storage.transaction(async (transaction) => {
				const generation = (await transaction.get<number>(linkGenerationKey(discordId))) ?? 0;
				await transaction.delete(githubKey(link.github_id));
				await transaction.delete(discordKey(discordId));
				await transaction.put(retiredGithubKey(link.github_id), true);
				await transaction.put(retiredDiscordKey(discordId), true);
				await transaction.put(linkGenerationKey(discordId), generation + 1);
				await transaction.put(interactionKey, result);
			});
			return result;
		});
	}

	grantRoleForGitHub(githubId: number): Promise<{ linked: boolean; discordId?: string }> {
		return this.exclusive(async () => {
			await this.ctx.storage.put(contributedKey(githubId), true);
			const link = await this.lookupGitHub(githubId);
			if (!link) return { linked: false };

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
			return { linked: true, discordId: link.discord_id };
		});
	}

	private async revokeRole(discordId: string): Promise<void> {
		const state = await getRoleState(this.env, discordId, this.env.DISCORD_CONTRIBUTOR_ROLE_ID);
		if (state !== "present") return;
		const removed = await removeRole(this.env, discordId, this.env.DISCORD_CONTRIBUTOR_ROLE_ID);
		if (!removed) throw new Error("Discord rejected Contributor role removal");
	}

	private async deleteLegacyLinks(...links: (LinkRecord | null)[]): Promise<void> {
		const keys = new Set<string>();
		for (const link of links) {
			if (!link) continue;
			keys.add(githubKey(link.github_id));
			keys.add(discordKey(link.discord_id));
		}
		await Promise.all(Array.from(keys, (key) => this.env.KV.delete(key)));
	}

	private async lookupGitHub(githubId: number): Promise<LinkRecord | null> {
		const current = await this.ctx.storage.get<LinkRecord>(githubKey(githubId));
		if (current) return current;
		if (await this.ctx.storage.get<boolean>(retiredGithubKey(githubId))) return null;

		const legacy = await findByGitHubId(this.env.KV, githubId);
		if (!legacy) return null;
		const counterpart = await findByDiscordId(this.env.KV, legacy.discord_id);
		if (counterpart?.github_id !== githubId) {
			throw new Error("Inconsistent legacy GitHub link");
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
			throw new Error("Inconsistent legacy Discord link");
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
