import {
	createExecutionContext,
	runDurableObjectAlarm,
	runInDurableObject,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import worker from "../src/index.js";
import { recordContributor, storeLink, storeOAuthState } from "../src/kv.js";

const testEnv = env as Env;
const guildId = "123456789";
const roleId = "987654321";
const channelId = "555555555";
const githubTokenUrl = "https://github.com/login/oauth/access_token";
const githubUserUrl = "https://api.github.com/user";
const messageUrl = `https://discord.com/api/v10/channels/${channelId}/messages`;
const interactionResponses = new Map<string, Record<string, unknown>>();

beforeEach(() => {
	interactionResponses.clear();
	testEnv.DISCORD_APP_ID = "test-application";
	testEnv.DISCORD_GUILD_ID = guildId;
	testEnv.DISCORD_CONTRIBUTOR_ROLE_ID = roleId;
	testEnv.DISCORD_CHANNEL_ID = channelId;
	testEnv.DISCORD_BOT_TOKEN = "test-bot-token";
	testEnv.GITHUB_CLIENT_ID = "test-client-id";
	testEnv.GITHUB_CLIENT_SECRET = "test-client-secret";
	testEnv.PUBLIC_URL = "https://worker.test";
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Contributor link lifecycle", () => {
	test("keeps a successful link when the welcome request fails", async () => {
		const githubId = randomGithubId();
		const discordId = randomDiscordId();
		await recordContributor(testEnv.KV, githubId, "contributor");
		const api = mockExternalApi(githubId);
		api.beforeMessage = async () => {
			throw new TypeError("Connection lost");
		};
		vi.stubGlobal("fetch", api.fetchMock);

		const response = await linkByCallback(githubId, discordId);

		expect(response.status).toBe(200);
		expect(await response.text()).toContain("Successfully linked!");
		expect(api.roles.get(discordId)?.has(roleId)).toBe(true);
		expect(await linkButtonLabel(discordId)).toBe("Relink GitHub Account");
		expect(api.messages).toHaveLength(0);
		expect(api.messageRequests).toHaveLength(2);
		await runInDurableObject(testEnv.CONTRIBUTOR_LINKS.getByName("global"), async (_, state) => {
			expect(await state.storage.get(`welcome-pending:${githubId}`)).toBe(true);
			expect(await state.storage.get(`welcome-delivery:${githubId}`)).toMatchObject({
				status: "unresolved",
				attempts: 2,
			});
		});
	});

	test("confirms one welcome when Discord accepts it but the response is lost", async () => {
		const githubId = randomGithubId();
		const discordId = randomDiscordId();
		await recordContributor(testEnv.KV, githubId, "contributor");
		const api = mockExternalApi(githubId);
		api.afterMessage = async () => {
			throw new TypeError("Response lost after acceptance");
		};
		vi.stubGlobal("fetch", api.fetchMock);

		expect((await linkByCallback(githubId, discordId)).status).toBe(200);
		expect(api.messageRequests).toHaveLength(2);
		expect(api.messageRequests[0]).toBe(api.messageRequests[1]);
		expect(api.messages).toHaveLength(1);
		const links = testEnv.CONTRIBUTOR_LINKS.getByName("global");
		await runInDurableObject(links, async (_, state) => {
			expect(await state.storage.get(`welcome-pending:${githubId}`)).toBeUndefined();
			expect(await state.storage.get(`welcome-delivery:${githubId}`)).toMatchObject({
				status: "sent",
				messageId: "test-message",
			});
		});
		expect(await links.postWelcomeIfLinked(githubId, discordId, "Another welcome")).toBe(false);
		expect((await linkByCallback(githubId, randomDiscordId())).status).toBe(200);
		expect(api.messageRequests).toHaveLength(2);
	});

	test("reuses the original welcome after its receipt could not be saved", async () => {
		const githubId = randomGithubId();
		const discordId = randomDiscordId();
		await recordContributor(testEnv.KV, githubId, "contributor");
		const api = mockExternalApi(githubId);
		vi.stubGlobal("fetch", api.fetchMock);
		const links = testEnv.CONTRIBUTOR_LINKS.getByName("global");
		await links.link(linkRecord(githubId, discordId), 0);

		await runInDurableObject(links, async (instance, state) => {
			const transaction = vi
				.spyOn(state.storage, "transaction")
				.mockRejectedValueOnce(new Error("Receipt storage unavailable"));
			try {
				await expect(
					instance.postWelcomeIfLinked(githubId, discordId, "First welcome"),
				).rejects.toThrow("Receipt storage unavailable");
			} finally {
				transaction.mockRestore();
			}
			expect(await state.storage.get(`welcome-pending:${githubId}`)).toBe(true);
			expect(await instance.postWelcomeIfLinked(githubId, discordId, "Different wording")).toBe(
				true,
			);
			expect(await state.storage.get(`welcome-delivery:${githubId}`)).toMatchObject({
				status: "sent",
				messageId: "test-message",
			});
		});
		expect(api.messageRequests).toHaveLength(2);
		expect(api.messageRequests[0]).toBe(api.messageRequests[1]);
		expect(api.messages).toHaveLength(1);
	});

	test("waits for Discord's retry delay before retrying a welcome", async () => {
		const githubId = randomGithubId();
		const discordId = randomDiscordId();
		await recordContributor(testEnv.KV, githubId, "contributor");
		const api = mockExternalApi(githubId);
		let rejectedAt = 0;
		api.beforeMessage = async () => {
			if (api.messageRequests.length === 1) {
				rejectedAt = Date.now();
				return Response.json({ retry_after: 0.05 }, { status: 429 });
			}
			expect(Date.now() - rejectedAt).toBeGreaterThanOrEqual(50);
		};
		vi.stubGlobal("fetch", api.fetchMock);

		expect((await linkByCallback(githubId, discordId)).status).toBe(200);
		expect(api.messageRequests).toHaveLength(2);
		expect(api.messageRequests[0]).toBe(api.messageRequests[1]);
		expect(api.messages).toHaveLength(1);
	});

	test.each([403, 429])(
		"stops welcome retries after HTTP %s without losing the link",
		async (status) => {
			const githubId = randomGithubId();
			const discordId = randomDiscordId();
			await recordContributor(testEnv.KV, githubId, "contributor");
			const api = mockExternalApi(githubId);
			api.beforeMessage = async () => Response.json({ retry_after: 60 }, { status });
			vi.stubGlobal("fetch", api.fetchMock);

			expect((await linkByCallback(githubId, discordId)).status).toBe(200);
			expect(api.messages).toHaveLength(0);
			expect(api.messageRequests).toHaveLength(1);
			api.beforeMessage = undefined;
			expect((await linkByCallback(githubId, randomDiscordId())).status).toBe(200);
			expect(api.messageRequests).toHaveLength(1);
		},
	);

	test.each(["expired", "exhausted", "transferred"] as const)(
		"does not restart an %s welcome attempt after interruption",
		async (interruption) => {
			const githubId = randomGithubId();
			const discordId = randomDiscordId();
			await recordContributor(testEnv.KV, githubId, "contributor");
			const api = mockExternalApi(githubId);
			vi.stubGlobal("fetch", api.fetchMock);
			const links = testEnv.CONTRIBUTOR_LINKS.getByName("global");
			await links.link(linkRecord(githubId, discordId), 0);
			await runInDurableObject(links, async (_, state) => {
				await state.storage.put(`welcome-delivery:${githubId}`, {
					discordId: interruption === "transferred" ? randomDiscordId() : discordId,
					channelId,
					content: "Original welcome",
					nonce: "original-send",
					startedAt: Date.now() - (interruption === "expired" ? 60_000 : 0),
					nextAttemptAt: Date.now(),
					attempts: interruption === "exhausted" ? 2 : 1,
					status: "pending",
				});
			});

			expect(await links.postWelcomeIfLinked(githubId, discordId, "New welcome")).toBe(false);
			expect(api.messageRequests).toHaveLength(0);
			await runInDurableObject(links, async (_, state) => {
				const delivery = await state.storage.get(`welcome-delivery:${githubId}`);
				expect(delivery).toMatchObject({ status: "unresolved", nonce: "original-send" });
				expect(await state.storage.get(`welcome-pending:${githubId}`)).toBe(true);
			});
		},
	);

	test("moves the role to a new Discord account without a second welcome", async () => {
		const githubId = randomGithubId();
		const oldDiscordId = randomDiscordId();
		const newDiscordId = randomDiscordId();
		await recordContributor(testEnv.KV, githubId, "contributor");
		const api = mockExternalApi(githubId);
		api.roles.set(oldDiscordId, new Set(["other-role"]));
		api.roles.set(newDiscordId, new Set(["other-role"]));
		vi.stubGlobal("fetch", api.fetchMock);

		expect((await linkByCallback(githubId, oldDiscordId)).status).toBe(200);
		expect(api.roles.get(oldDiscordId)?.has(roleId)).toBe(true);
		expect(api.messages).toHaveLength(1);

		expect((await linkByCallback(githubId, newDiscordId)).status).toBe(200);
		expect(api.roles.get(oldDiscordId)?.has(roleId)).toBe(false);
		expect(api.roles.get(newDiscordId)?.has(roleId)).toBe(true);
		expect(api.roles.get(oldDiscordId)).toEqual(new Set(["other-role"]));
		expect(api.roles.get(newDiscordId)).toEqual(new Set(["other-role", roleId]));
		expect(api.messages).toHaveLength(1);
		expect(await linkButtonLabel(oldDiscordId)).toBe("Link GitHub Account");
		expect(await linkButtonLabel(newDiscordId)).toBe("Relink GitHub Account");
		expect(api.roleCalls()).toEqual([
			{ discordId: oldDiscordId, method: "PUT" },
			{ discordId: oldDiscordId, method: "DELETE" },
			{ discordId: newDiscordId, method: "PUT" },
		]);
	});

	test("removes the Contributor role and both link keys on /unlink", async () => {
		const githubId = randomGithubId();
		const discordId = randomDiscordId();
		await storeLink(testEnv.KV, linkRecord(githubId, discordId));
		const api = mockExternalApi(githubId);
		api.roles.set(discordId, new Set([roleId, "other-role"]));
		vi.stubGlobal("fetch", api.fetchMock);

		const response = await fetchWorker(await signedUnlinkRequest(discordId), testEnv);

		expect(response.status).toBe(200);
		expect(api.roles.get(discordId)?.has(roleId)).toBe(false);
		expect(api.roles.get(discordId)).toEqual(new Set(["other-role"]));
		expect(await testEnv.KV.get(`github:${githubId}`)).toBeNull();
		expect(await testEnv.KV.get(`discord:${discordId}`)).toBeNull();
		expect(await linkButtonLabel(discordId)).toBe("Link GitHub Account");
		expect(api.roleCalls()).toContainEqual({ discordId, method: "DELETE" });
	});

	test("removes an orphaned role without replaying the removal after a new link", async () => {
		const githubId = randomGithubId();
		const discordId = randomDiscordId();
		await recordContributor(testEnv.KV, githubId, "contributor");
		const api = mockExternalApi(githubId);
		api.roles.set(discordId, new Set([roleId, "other-role"]));
		vi.stubGlobal("fetch", api.fetchMock);
		const unlinkRequest = await signedUnlinkRequest(discordId);

		const response = await fetchWorker(unlinkRequest.clone(), testEnv);
		const result: { data: { content: string } } = await response.json();
		expect(result.data.content).toBe(
			"Your Contributor role has been removed. Your Discord account was not linked to a GitHub account.",
		);
		expect(api.roles.get(discordId)).toEqual(new Set(["other-role"]));

		expect((await linkByCallback(githubId, discordId)).status).toBe(200);
		await fetchWorker(unlinkRequest.clone(), testEnv);
		expect(api.roles.get(discordId)).toEqual(new Set(["other-role", roleId]));
		expect(api.roleCalls().filter((call) => call.method === "DELETE")).toHaveLength(1);
	});

	test("retries removing an orphaned role after Discord rejects /unlink", async () => {
		const discordId = randomDiscordId();
		const api = mockExternalApi(randomGithubId());
		api.roles.set(discordId, new Set([roleId]));
		api.removeRoleStatus = 503;
		vi.stubGlobal("fetch", api.fetchMock);
		const unlinkRequest = await signedUnlinkRequest(discordId);

		const failed = await fetchWorker(unlinkRequest.clone(), testEnv);
		expect(await failed.json()).toMatchObject({
			data: {
				content: "Could not unlink your account or remove the Contributor role. Please try again.",
			},
		});
		expect(api.roles.get(discordId)?.has(roleId)).toBe(true);

		api.removeRoleStatus = 204;
		await fetchWorker(unlinkRequest.clone(), testEnv);
		expect(api.roles.get(discordId)?.has(roleId)).toBe(false);
	});

	test("acknowledges /unlink and a queued /link before a slow role removal completes", async () => {
		const githubId = randomGithubId();
		const discordId = randomDiscordId();
		await storeLink(testEnv.KV, linkRecord(githubId, discordId));
		const api = mockExternalApi(githubId);
		api.roles.set(discordId, new Set([roleId]));
		let releaseMember!: () => void;
		let markMemberStarted!: () => void;
		const memberPending = new Promise<void>((resolve) => {
			releaseMember = resolve;
		});
		const memberStarted = new Promise<void>((resolve) => {
			markMemberStarted = resolve;
		});
		api.beforeMemberGet = async () => {
			markMemberStarted();
			await memberPending;
		};
		vi.stubGlobal("fetch", api.fetchMock);

		const unlinkRequest = await signedUnlinkRequest(discordId);
		const unlinkInteraction: { token: string } = await unlinkRequest.clone().json();
		const unlinkCtx = createExecutionContext();
		const linkCtx = createExecutionContext();
		let unlinkResponse: Response | undefined;
		let linkResponse: Response | undefined;
		let linkInteraction: { token: string } | undefined;
		const unlinkFetch = worker.fetch(unlinkRequest, testEnv, unlinkCtx).then((response) => {
			unlinkResponse = response;
			return response;
		});
		let linkFetch: Promise<Response> | undefined;
		try {
			await vi.waitFor(() => expect(unlinkResponse).toBeDefined());
			expect(await unlinkResponse!.json()).toEqual({ type: 5, data: { flags: 64 } });
			await memberStarted;
			const linkRequest = await signedCommandRequest(discordId, "link");
			linkInteraction = await linkRequest.clone().json();
			linkFetch = worker.fetch(linkRequest, testEnv, linkCtx).then((response) => {
				linkResponse = response;
				return response;
			});
			await vi.waitFor(() => expect(linkResponse).toBeDefined());
			expect(await linkResponse!.json()).toEqual({ type: 5, data: { flags: 64 } });
			expect(interactionResponses.size).toBe(0);
			expect(api.roles.get(discordId)?.has(roleId)).toBe(true);
		} finally {
			releaseMember();
			await Promise.all([unlinkFetch, linkFetch]);
			await Promise.all([waitOnExecutionContext(unlinkCtx), waitOnExecutionContext(linkCtx)]);
		}

		expect(interactionResponses.get(unlinkInteraction.token)?.content).toBe(
			"Your GitHub account has been unlinked and your Contributor role removed.",
		);
		const completedLink = interactionResponses.get(linkInteraction!.token);
		expect(completedLink).toMatchObject({
			components: [{ components: [{ label: "Link GitHub Account" }] }],
		});
		expect(api.roles.get(discordId)?.has(roleId)).toBe(false);
		expect(await testEnv.KV.get(`github:${githubId}`)).toBeNull();
		expect(await testEnv.KV.get(`discord:${discordId}`)).toBeNull();
	});

	test("removes legacy link keys when a GitHub account moves to another Discord account", async () => {
		const githubId = randomGithubId();
		const oldDiscordId = randomDiscordId();
		const newDiscordId = randomDiscordId();
		await recordContributor(testEnv.KV, githubId, "contributor");
		await storeLink(testEnv.KV, linkRecord(githubId, oldDiscordId));
		const api = mockExternalApi(githubId);
		api.roles.set(oldDiscordId, new Set([roleId]));
		vi.stubGlobal("fetch", api.fetchMock);

		expect((await linkByCallback(githubId, newDiscordId)).status).toBe(200);
		expect(api.roles.get(oldDiscordId)?.has(roleId)).toBe(false);
		expect(api.roles.get(newDiscordId)?.has(roleId)).toBe(true);
		expect(await testEnv.KV.get(`github:${githubId}`)).toBeNull();
		expect(await testEnv.KV.get(`discord:${oldDiscordId}`)).toBeNull();
		expect(api.messages).toHaveLength(0);
	});

	test("does not repeat the welcome after unlinking and linking another Discord account", async () => {
		const githubId = randomGithubId();
		const oldDiscordId = randomDiscordId();
		const newDiscordId = randomDiscordId();
		await recordContributor(testEnv.KV, githubId, "contributor");
		const api = mockExternalApi(githubId);
		vi.stubGlobal("fetch", api.fetchMock);

		expect((await linkByCallback(githubId, oldDiscordId)).status).toBe(200);
		expect((await fetchWorker(await signedUnlinkRequest(oldDiscordId), testEnv)).status).toBe(200);
		expect((await linkByCallback(githubId, newDiscordId)).status).toBe(200);

		expect(api.roles.get(oldDiscordId)?.has(roleId)).toBe(false);
		expect(api.roles.get(newDiscordId)?.has(roleId)).toBe(true);
		expect(api.messages).toHaveLength(1);
	});

	test("welcomes a different contributing GitHub account on the same Discord account", async () => {
		const firstGithubId = randomGithubId();
		const secondGithubId = randomGithubId();
		const discordId = randomDiscordId();
		await recordContributor(testEnv.KV, firstGithubId, "first-contributor");
		await recordContributor(testEnv.KV, secondGithubId, "second-contributor");
		const api = mockExternalApi(firstGithubId);
		api.githubLogin = "first-contributor";
		vi.stubGlobal("fetch", api.fetchMock);

		expect((await linkByCallback(firstGithubId, discordId)).status).toBe(200);
		expect(api.messages).toHaveLength(1);
		expect((await fetchWorker(await signedUnlinkRequest(discordId), testEnv)).status).toBe(200);
		api.githubId = secondGithubId;
		api.githubLogin = "second-contributor";
		expect((await linkByCallback(secondGithubId, discordId)).status).toBe(200);
		expect(api.messages).toHaveLength(2);
		expect(api.messages[1]).toContain("second-contributor");
		expect(api.roles.get(discordId)?.has(roleId)).toBe(true);

		expect((await linkByCallback(secondGithubId, discordId)).status).toBe(200);
		expect(api.messages).toHaveLength(2);
		expect(api.roleCalls()).toEqual([
			{ discordId, method: "PUT" },
			{ discordId, method: "DELETE" },
			{ discordId, method: "PUT" },
		]);
	});

	test("retries a failed role grant without losing the first welcome", async () => {
		const githubId = randomGithubId();
		const discordId = randomDiscordId();
		await recordContributor(testEnv.KV, githubId, "contributor");
		const api = mockExternalApi(githubId);
		api.addRoleStatus = 503;
		vi.stubGlobal("fetch", api.fetchMock);

		expect((await linkByCallback(githubId, discordId)).status).toBe(502);
		expect(api.roles.get(discordId)?.has(roleId)).not.toBe(true);
		expect(api.messages).toHaveLength(0);

		api.addRoleStatus = 204;
		expect((await linkByCallback(githubId, discordId)).status).toBe(200);
		expect(api.roles.get(discordId)?.has(roleId)).toBe(true);
		expect(api.messages).toHaveLength(1);
	});

	test("does not replay an old /unlink after the account is linked again", async () => {
		const githubId = randomGithubId();
		const discordId = randomDiscordId();
		await recordContributor(testEnv.KV, githubId, "contributor");
		const api = mockExternalApi(githubId);
		vi.stubGlobal("fetch", api.fetchMock);

		expect((await linkByCallback(githubId, discordId)).status).toBe(200);
		const unlinkRequest = await signedUnlinkRequest(discordId);
		expect((await fetchWorker(unlinkRequest.clone(), testEnv)).status).toBe(200);
		expect((await linkByCallback(githubId, discordId)).status).toBe(200);
		expect((await fetchWorker(unlinkRequest.clone(), testEnv)).status).toBe(200);

		expect(api.roles.get(discordId)?.has(roleId)).toBe(true);
		expect(await linkButtonLabel(discordId)).toBe("Relink GitHub Account");
		expect(api.roleCalls().filter((call) => call.method === "DELETE")).toHaveLength(1);
	});

	test("expires /unlink replay records after the full signature replay window", async () => {
		const discordId = randomDiscordId();
		const api = mockExternalApi(randomGithubId());
		vi.stubGlobal("fetch", api.fetchMock);
		const interactionId = crypto.randomUUID();
		const interactionKey = `unlink:${interactionId}`;
		const links = testEnv.CONTRIBUTOR_LINKS.getByName("global");
		const startedAt = Date.now();

		expect(await links.unlink(discordId, interactionId)).toEqual({
			unlinked: false,
			roleRemoved: false,
		});
		await runInDurableObject(links, async (_instance, state) => {
			const replay = await state.storage.get<{
				result: { unlinked: boolean; roleRemoved: boolean };
				expiresAt: number;
			}>(interactionKey);
			expect(replay?.result).toEqual({ unlinked: false, roleRemoved: false });
			expect(replay?.expiresAt).toBeGreaterThanOrEqual(startedAt + 10 * 60 * 1000);
			await state.storage.put(interactionKey, {
				result: { unlinked: false, roleRemoved: false },
				expiresAt: Date.now() - 1,
			});
			await state.storage.setAlarm(Date.now());
		});

		await runDurableObjectAlarm(links);
		await runInDurableObject(links, async (_instance, state) => {
			expect(await state.storage.get(interactionKey)).toBeUndefined();
		});
	});

	test("does not accept an OAuth callback started before /unlink", async () => {
		const githubId = randomGithubId();
		const discordId = randomDiscordId();
		await recordContributor(testEnv.KV, githubId, "contributor");
		const api = mockExternalApi(githubId);
		vi.stubGlobal("fetch", api.fetchMock);

		expect((await linkByCallback(githubId, discordId)).status).toBe(200);
		const oldState = await pendingOAuthState(discordId);

		expect((await fetchWorker(await signedUnlinkRequest(discordId), testEnv)).status).toBe(200);
		const staleCallback = await fetchWorker(
			new Request(`https://worker.test/callback/github?code=${githubId}&state=${oldState}`),
			testEnv,
		);

		expect(staleCallback.status).toBe(400);
		expect(api.roles.get(discordId)?.has(roleId)).toBe(false);
		expect(await linkButtonLabel(discordId)).toBe("Link GitHub Account");
	});

	test("does not accept an old account's OAuth callback after a transfer", async () => {
		const githubId = randomGithubId();
		const oldDiscordId = randomDiscordId();
		const newDiscordId = randomDiscordId();
		await recordContributor(testEnv.KV, githubId, "contributor");
		const api = mockExternalApi(githubId);
		vi.stubGlobal("fetch", api.fetchMock);

		expect((await linkByCallback(githubId, oldDiscordId)).status).toBe(200);
		const oldState = await pendingOAuthState(oldDiscordId);
		expect((await linkByCallback(githubId, newDiscordId)).status).toBe(200);
		const staleCallback = await fetchWorker(
			new Request(`https://worker.test/callback/github?code=${githubId}&state=${oldState}`),
			testEnv,
		);

		expect(staleCallback.status).toBe(400);
		expect(api.roles.get(oldDiscordId)?.has(roleId)).toBe(false);
		expect(api.roles.get(newDiscordId)?.has(roleId)).toBe(true);
	});

	test("does not send a delayed merge message to the previous Discord account", async () => {
		const githubId = randomGithubId();
		const oldDiscordId = randomDiscordId();
		const newDiscordId = randomDiscordId();
		await recordContributor(testEnv.KV, githubId, "contributor");
		const api = mockExternalApi(githubId);
		vi.stubGlobal("fetch", api.fetchMock);

		expect((await linkByCallback(githubId, oldDiscordId)).status).toBe(200);
		expect((await linkByCallback(githubId, newDiscordId)).status).toBe(200);
		const count = api.messages.length;
		const posted = await testEnv.CONTRIBUTOR_LINKS.getByName("global").postMergeIfLinked(
			githubId,
			oldDiscordId,
			`<@${oldDiscordId}> PR merged`,
		);

		expect(posted).toBe(false);
		expect(api.messages).toHaveLength(count);
	});

	test("sends a delayed first welcome only to the current Discord account", async () => {
		const githubId = randomGithubId();
		const oldDiscordId = randomDiscordId();
		const newDiscordId = randomDiscordId();
		await recordContributor(testEnv.KV, githubId, "contributor");
		const api = mockExternalApi(githubId);
		vi.stubGlobal("fetch", api.fetchMock);
		const links = testEnv.CONTRIBUTOR_LINKS.getByName("global");

		const first = await links.link(linkRecord(githubId, oldDiscordId), 0);
		const second = await links.link(linkRecord(githubId, newDiscordId), 0);
		expect(first.status).toBe("linked");
		expect(second.status).toBe("linked");
		expect(await links.postWelcomeIfLinked(githubId, oldDiscordId, "Old account welcome")).toBe(
			false,
		);
		expect(await links.postWelcomeIfLinked(githubId, newDiscordId, "New account welcome")).toBe(
			true,
		);
		expect(api.messages).toHaveLength(1);
		expect(api.messages[0]).toContain("New account welcome");
	});

	test("rejects /unlink from another guild", async () => {
		const githubId = randomGithubId();
		const discordId = randomDiscordId();
		await storeLink(testEnv.KV, linkRecord(githubId, discordId));
		const api = mockExternalApi(githubId);
		api.roles.set(discordId, new Set([roleId]));
		vi.stubGlobal("fetch", api.fetchMock);

		const response = await fetchWorker(
			await signedCommandRequest(discordId, "unlink", "another-guild"),
			testEnv,
		);

		expect(response.status).toBe(200);
		expect(api.roleCalls()).toHaveLength(0);
		expect(api.roles.get(discordId)?.has(roleId)).toBe(true);
	});

	test("rejects an expired signed /unlink request", async () => {
		const githubId = randomGithubId();
		const discordId = randomDiscordId();
		await storeLink(testEnv.KV, linkRecord(githubId, discordId));
		const api = mockExternalApi(githubId);
		api.roles.set(discordId, new Set([roleId]));
		vi.stubGlobal("fetch", api.fetchMock);

		const expiredTimestamp = String(Math.floor(Date.now() / 1000) - 601);
		const response = await fetchWorker(
			await signedCommandRequest(discordId, "unlink", guildId, expiredTimestamp),
			testEnv,
		);

		expect(response.status).toBe(401);
		expect(api.roleCalls()).toHaveLength(0);
		expect(api.roles.get(discordId)?.has(roleId)).toBe(true);
	});

	test("keeps the link when Discord rejects role removal on /unlink", async () => {
		const githubId = randomGithubId();
		const discordId = randomDiscordId();
		await storeLink(testEnv.KV, linkRecord(githubId, discordId));
		const api = mockExternalApi(githubId);
		api.roles.set(discordId, new Set([roleId]));
		api.removeRoleStatus = 503;
		vi.stubGlobal("fetch", api.fetchMock);

		const response = await fetchWorker(await signedUnlinkRequest(discordId), testEnv);
		const result: { data?: { content?: string } } = await response.json();

		expect(api.roleCalls()).toContainEqual({ discordId, method: "DELETE" });
		expect(api.roles.get(discordId)?.has(roleId)).toBe(true);
		expect(await linkButtonLabel(discordId)).toBe("Relink GitHub Account");
		expect(result.data?.content).toBe(
			"Could not unlink your account or remove the Contributor role. Please try again.",
		);
	});

	test("keeps the original link when Discord rejects role removal during transfer", async () => {
		const githubId = randomGithubId();
		const oldDiscordId = randomDiscordId();
		const newDiscordId = randomDiscordId();
		await recordContributor(testEnv.KV, githubId, "contributor");
		await storeLink(testEnv.KV, linkRecord(githubId, oldDiscordId));
		const api = mockExternalApi(githubId);
		api.roles.set(oldDiscordId, new Set([roleId]));
		api.removeRoleStatus = 503;
		vi.stubGlobal("fetch", api.fetchMock);

		const status = await linkByCallback(githubId, newDiscordId).then(
			(response) => response.status,
			() => 500,
		);

		expect(status).toBeGreaterThanOrEqual(500);
		expect(api.roleCalls()).toContainEqual({ discordId: oldDiscordId, method: "DELETE" });
		expect(api.roles.get(oldDiscordId)?.has(roleId)).toBe(true);
		expect(api.roles.get(newDiscordId)?.has(roleId)).not.toBe(true);
		expect(await linkButtonLabel(oldDiscordId)).toBe("Relink GitHub Account");
		expect(await linkButtonLabel(newDiscordId)).toBe("Link GitHub Account");
		expect(api.messages).toHaveLength(0);
	});

	test("restores the original role and link when the destination role grant fails", async () => {
		const githubId = randomGithubId();
		const oldDiscordId = randomDiscordId();
		const newDiscordId = randomDiscordId();
		await recordContributor(testEnv.KV, githubId, "contributor");
		await storeLink(testEnv.KV, linkRecord(githubId, oldDiscordId));
		const api = mockExternalApi(githubId);
		api.roles.set(oldDiscordId, new Set([roleId]));
		api.addRoleStatuses.set(newDiscordId, 503);
		vi.stubGlobal("fetch", api.fetchMock);

		expect((await linkByCallback(githubId, newDiscordId)).status).toBe(502);

		expect(api.roleCalls()).toEqual([
			{ discordId: oldDiscordId, method: "DELETE" },
			{ discordId: newDiscordId, method: "PUT" },
			{ discordId: oldDiscordId, method: "PUT" },
		]);
		expect(api.roles.get(oldDiscordId)?.has(roleId)).toBe(true);
		expect(api.roles.get(newDiscordId)?.has(roleId)).not.toBe(true);
		expect(await linkButtonLabel(oldDiscordId)).toBe("Relink GitHub Account");
		expect(await linkButtonLabel(newDiscordId)).toBe("Link GitHub Account");
		expect(await testEnv.KV.get(`github:${githubId}`)).not.toBeNull();
		expect(await testEnv.KV.get(`discord:${oldDiscordId}`)).not.toBeNull();
		expect(api.messages).toHaveLength(0);
	});

	test("recovers a stale GitHub link without disturbing a different valid pair", async () => {
		const githubId = randomGithubId();
		const otherGithubId = randomGithubId();
		const oldDiscordId = randomDiscordId();
		const newDiscordId = randomDiscordId();
		await recordContributor(testEnv.KV, githubId, "contributor");
		await testEnv.KV.put(`github:${githubId}`, JSON.stringify(linkRecord(githubId, oldDiscordId)));
		await storeLink(testEnv.KV, linkRecord(otherGithubId, oldDiscordId));
		const api = mockExternalApi(githubId);
		api.roles.set(oldDiscordId, new Set([roleId]));
		vi.stubGlobal("fetch", api.fetchMock);

		expect((await linkByCallback(githubId, newDiscordId)).status).toBe(200);
		expect(api.roleCalls()).toEqual([{ discordId: newDiscordId, method: "PUT" }]);
		expect(api.roles.get(oldDiscordId)?.has(roleId)).toBe(true);
		expect(api.roles.get(newDiscordId)?.has(roleId)).toBe(true);
		expect(await testEnv.KV.get(`github:${otherGithubId}`)).not.toBeNull();
		expect(await testEnv.KV.get(`discord:${oldDiscordId}`)).not.toBeNull();
		expect(api.messages).toHaveLength(0);
	});

	test("retries a confirmed role after a failed transfer could not restore it", async () => {
		const githubId = randomGithubId();
		const oldDiscordId = randomDiscordId();
		const newDiscordId = randomDiscordId();
		await recordContributor(testEnv.KV, githubId, "contributor");
		const api = mockExternalApi(githubId);
		vi.stubGlobal("fetch", api.fetchMock);
		expect((await linkByCallback(githubId, oldDiscordId)).status).toBe(200);
		api.addRoleStatuses.set(newDiscordId, 503);
		api.addRoleStatuses.set(oldDiscordId, 503);

		expect((await linkByCallback(githubId, newDiscordId)).status).toBe(502);
		expect(api.roles.get(oldDiscordId)?.has(roleId)).toBe(false);
		api.addRoleStatuses.delete(oldDiscordId);
		expect(
			await testEnv.CONTRIBUTOR_LINKS.getByName("global").grantRoleForGitHub(githubId),
		).toEqual({
			linked: true,
			discordId: oldDiscordId,
		});
		expect(api.roles.get(oldDiscordId)?.has(roleId)).toBe(true);
		expect(api.roles.get(newDiscordId)?.has(roleId)).not.toBe(true);
	});

	test("rolls back a transfer when Discord applied the new role before timing out", async () => {
		const githubId = randomGithubId();
		const oldDiscordId = randomDiscordId();
		const newDiscordId = randomDiscordId();
		await recordContributor(testEnv.KV, githubId, "contributor");
		const api = mockExternalApi(githubId);
		vi.stubGlobal("fetch", api.fetchMock);
		expect((await linkByCallback(githubId, oldDiscordId)).status).toBe(200);
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		api.afterRolePut = async (discordId, signal) => {
			if (discordId !== newDiscordId) return;
			markStarted();
			await untilAborted(signal);
		};
		vi.useFakeTimers();
		try {
			await runInDurableObject(testEnv.CONTRIBUTOR_LINKS.getByName("global"), async (instance) => {
				const failed = expect(instance.link(linkRecord(githubId, newDiscordId), 0)).rejects.toThrow(
					"Discord request timed out",
				);
				await started;
				await vi.advanceTimersByTimeAsync(5_000);
				await failed;
				expect((await instance.getByGitHubId(githubId))?.discord_id).toBe(oldDiscordId);
			});
		} finally {
			vi.useRealTimers();
		}
		expect(api.roles.get(oldDiscordId)?.has(roleId)).toBe(true);
		expect(api.roles.get(newDiscordId)?.has(roleId)).toBe(false);
	});

	test("restores a role when Discord applied /unlink removal before timing out", async () => {
		const githubId = randomGithubId();
		const discordId = randomDiscordId();
		await recordContributor(testEnv.KV, githubId, "contributor");
		const api = mockExternalApi(githubId);
		vi.stubGlobal("fetch", api.fetchMock);
		expect((await linkByCallback(githubId, discordId)).status).toBe(200);
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		api.afterRoleDelete = async (_discordId, signal) => {
			markStarted();
			await untilAborted(signal);
		};
		vi.useFakeTimers();
		try {
			await runInDurableObject(testEnv.CONTRIBUTOR_LINKS.getByName("global"), async (instance) => {
				const failed = expect(instance.unlink(discordId, crypto.randomUUID())).rejects.toThrow(
					"Discord request timed out",
				);
				await started;
				await vi.advanceTimersByTimeAsync(5_000);
				await failed;
				expect((await instance.getLinkContext(discordId)).existing?.github_id).toBe(githubId);
			});
		} finally {
			vi.useRealTimers();
		}
		expect(api.roles.get(discordId)?.has(roleId)).toBe(true);
	});

	test.each(["github", "discord"] as const)(
		"imports a legacy pair after a temporary %s-side mismatch settles",
		async (side) => {
			const githubId = randomGithubId();
			const discordId = randomDiscordId();
			const record = linkRecord(githubId, discordId);
			const links = testEnv.CONTRIBUTOR_LINKS.getByName("global");
			const read = () =>
				side === "github"
					? links.getByGitHubId(githubId)
					: links.getLinkContext(discordId).then((context) => context.existing);
			const firstKey = side === "github" ? `github:${githubId}` : `discord:${discordId}`;
			const secondKey = side === "github" ? `discord:${discordId}` : `github:${githubId}`;

			await testEnv.KV.put(firstKey, JSON.stringify(record));
			expect(await read()).toBeNull();
			await testEnv.KV.put(secondKey, JSON.stringify(record));
			expect(await read()).toEqual(record);
		},
	);

	test("unlinks a stale Discord pointer without retiring its GitHub account's valid link", async () => {
		const githubId = randomGithubId();
		const oldDiscordId = randomDiscordId();
		const newDiscordId = randomDiscordId();
		await storeLink(testEnv.KV, linkRecord(githubId, newDiscordId));
		await testEnv.KV.put(
			`discord:${oldDiscordId}`,
			JSON.stringify(linkRecord(githubId, oldDiscordId)),
		);
		const api = mockExternalApi(githubId);
		api.roles.set(oldDiscordId, new Set([roleId]));
		api.roles.set(newDiscordId, new Set([roleId]));
		vi.stubGlobal("fetch", api.fetchMock);

		await fetchWorker(await signedUnlinkRequest(oldDiscordId), testEnv);
		expect(api.roles.get(oldDiscordId)?.has(roleId)).toBe(false);
		expect(api.roles.get(newDiscordId)?.has(roleId)).toBe(true);
		expect(await testEnv.KV.get(`github:${githubId}`)).not.toBeNull();
		expect(await testEnv.KV.get(`discord:${newDiscordId}`)).not.toBeNull();
		expect(await linkButtonLabel(newDiscordId)).toBe("Relink GitHub Account");
	});

	test("does not resurrect a legacy pair that settled after /unlink", async () => {
		const githubId = randomGithubId();
		const discordId = randomDiscordId();
		const record = linkRecord(githubId, discordId);
		await testEnv.KV.put(`discord:${discordId}`, JSON.stringify(record));
		const api = mockExternalApi(githubId);
		api.roles.set(discordId, new Set([roleId]));
		vi.stubGlobal("fetch", api.fetchMock);

		await fetchWorker(await signedUnlinkRequest(discordId), testEnv);
		await testEnv.KV.put(`github:${githubId}`, JSON.stringify(record));
		await testEnv.KV.put(`discord:${discordId}`, JSON.stringify(record));
		expect(await testEnv.CONTRIBUTOR_LINKS.getByName("global").getByGitHubId(githubId)).toBeNull();
		expect(await linkButtonLabel(discordId)).toBe("Link GitHub Account");
		expect(api.roles.get(discordId)?.has(roleId)).toBe(false);
	});

	test("does not check or restore a confirmed role on subsequent merge events", async () => {
		const githubId = randomGithubId();
		const discordId = randomDiscordId();
		await recordContributor(testEnv.KV, githubId, "contributor");
		const api = mockExternalApi(githubId);
		vi.stubGlobal("fetch", api.fetchMock);
		expect((await linkByCallback(githubId, discordId)).status).toBe(200);
		api.roles.get(discordId)?.delete(roleId);
		const calls = api.fetchMock.mock.calls.length;

		expect(
			await testEnv.CONTRIBUTOR_LINKS.getByName("global").grantRoleForGitHub(githubId),
		).toEqual({
			linked: true,
			discordId,
		});
		expect(api.fetchMock.mock.calls).toHaveLength(calls);
		expect(api.roles.get(discordId)?.has(roleId)).toBe(false);
	});

	test("treats a mismatched legacy GitHub link as unlinked during a merge", async () => {
		const githubId = randomGithubId();
		const discordId = randomDiscordId();
		await testEnv.KV.put(`github:${githubId}`, JSON.stringify(linkRecord(githubId, discordId)));
		const api = mockExternalApi(githubId);
		vi.stubGlobal("fetch", api.fetchMock);

		expect(
			await testEnv.CONTRIBUTOR_LINKS.getByName("global").grantRoleForGitHub(githubId),
		).toEqual({
			linked: false,
		});
		expect(api.fetchMock.mock.calls).toHaveLength(0);
	});

	test("releases the link queue after a Discord request times out", async () => {
		const githubId = randomGithubId();
		const discordId = randomDiscordId();
		await storeLink(testEnv.KV, linkRecord(githubId, discordId));
		const api = mockExternalApi(githubId);
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		api.beforeMemberGet = async (_discordId, signal) => {
			markStarted();
			await untilAborted(signal);
		};
		vi.stubGlobal("fetch", api.fetchMock);
		vi.useFakeTimers();
		try {
			const links = testEnv.CONTRIBUTOR_LINKS.getByName("global");
			await runInDurableObject(links, async (instance) => {
				const failed = expect(instance.unlink(discordId, crypto.randomUUID())).rejects.toThrow(
					"Discord request timed out",
				);
				await started;
				const next = instance.getLinkContext(randomDiscordId());
				await vi.advanceTimersByTimeAsync(5_000);
				await failed;
				expect((await next).existing).toBeNull();
			});
		} finally {
			vi.useRealTimers();
		}
	});

	test("clears a stale Contributor role when linking a noncontributor", async () => {
		const githubId = randomGithubId();
		const discordId = randomDiscordId();
		const api = mockExternalApi(githubId);
		api.roles.set(discordId, new Set([roleId, "other-role"]));
		vi.stubGlobal("fetch", api.fetchMock);

		expect((await linkByCallback(githubId, discordId)).status).toBe(200);
		expect(api.roles.get(discordId)).toEqual(new Set(["other-role"]));
	});

	test("does not retain Contributor when one Discord account switches to a non-contributor", async () => {
		const contributingGithubId = randomGithubId();
		const otherGithubId = randomGithubId();
		const discordId = randomDiscordId();
		await recordContributor(testEnv.KV, contributingGithubId, "contributor");
		await storeLink(testEnv.KV, linkRecord(contributingGithubId, discordId));
		const api = mockExternalApi(otherGithubId);
		api.roles.set(discordId, new Set([roleId]));
		vi.stubGlobal("fetch", api.fetchMock);

		expect((await linkByCallback(otherGithubId, discordId)).status).toBe(200);
		expect(api.roles.get(discordId)?.has(roleId)).toBe(false);
		expect(await linkButtonLabel(discordId)).toBe("Relink GitHub Account");
		expect(api.messages).toHaveLength(0);
	});
});

function mockExternalApi(githubId: number) {
	const roles = new Map<string, Set<string>>();
	const messages: string[] = [];
	const messageRequests: string[] = [];
	const receivedNonces = new Set<string>();
	const api = {
		githubId,
		githubLogin: "contributor",
		roles,
		messages,
		messageRequests,
		beforeMessage: undefined as (() => Promise<Response | void>) | undefined,
		afterMessage: undefined as (() => Promise<void>) | undefined,
		addRoleStatus: 204,
		addRoleStatuses: new Map<string, number>(),
		removeRoleStatus: 204,
		beforeMemberGet: undefined as
			| ((discordId: string, signal?: AbortSignal | null) => Promise<void>)
			| undefined,
		afterRolePut: undefined as
			| ((discordId: string, signal?: AbortSignal | null) => Promise<void>)
			| undefined,
		afterRoleDelete: undefined as
			| ((discordId: string, signal?: AbortSignal | null) => Promise<void>)
			| undefined,
		roleCalls: () =>
			fetchMock.mock.calls.flatMap(([input, init]) => {
				const match =
					/^https:\/\/discord\.com\/api\/v10\/guilds\/123456789\/members\/(\d+)\/roles\/987654321$/.exec(
						requestUrl(input),
					);
				const method = requestMethod(input, init);
				return match && (method === "PUT" || method === "DELETE")
					? [{ discordId: match[1], method }]
					: [];
			}),
		fetchMock: undefined as unknown as ReturnType<typeof vi.fn<typeof fetch>>,
	};
	const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
		const url = requestUrl(input);
		const method = requestMethod(input, init);
		if (url === githubTokenUrl && method === "POST") {
			return Response.json({ access_token: "test-github-token" });
		}
		if (url === githubUserUrl && method === "GET") {
			return Response.json({ id: api.githubId, login: api.githubLogin });
		}
		const memberMatch =
			/^https:\/\/discord\.com\/api\/v10\/guilds\/123456789\/members\/(\d+)$/.exec(url);
		if (memberMatch && method === "GET") {
			await api.beforeMemberGet?.(memberMatch[1]!, init?.signal);
			return Response.json({ roles: [...(roles.get(memberMatch[1]!) ?? [])] });
		}
		const roleMatch =
			/^https:\/\/discord\.com\/api\/v10\/guilds\/123456789\/members\/(\d+)\/roles\/987654321$/.exec(
				url,
			);
		if (roleMatch && method === "PUT") {
			const status = api.addRoleStatuses.get(roleMatch[1]!) ?? api.addRoleStatus;
			if (status >= 400) return new Response(null, { status });
			const memberRoles = roles.get(roleMatch[1]!) ?? new Set<string>();
			memberRoles.add(roleId);
			roles.set(roleMatch[1]!, memberRoles);
			await api.afterRolePut?.(roleMatch[1]!, init?.signal);
			return new Response(null, { status: 204 });
		}
		if (roleMatch && method === "DELETE") {
			if (api.removeRoleStatus >= 400) return new Response(null, { status: api.removeRoleStatus });
			roles.get(roleMatch[1]!)?.delete(roleId);
			await api.afterRoleDelete?.(roleMatch[1]!, init?.signal);
			return new Response(null, { status: 204 });
		}
		const interactionMatch =
			/^https:\/\/discord\.com\/api\/v10\/webhooks\/test-application\/([^/]+)\/messages\/@original$/.exec(
				url,
			);
		if (interactionMatch && method === "PATCH") {
			if (typeof init?.body !== "string") throw new Error("Expected interaction message JSON");
			const data: Record<string, unknown> = JSON.parse(init.body);
			expect(data).not.toHaveProperty("flags");
			interactionResponses.set(interactionMatch[1]!, data);
			return Response.json({ id: "test-interaction-message" });
		}
		if (url === messageUrl && method === "POST") {
			if (typeof init?.body !== "string") throw new Error("Expected message JSON");
			messageRequests.push(init.body);
			const response = await api.beforeMessage?.();
			if (response) return response;
			const body: { nonce?: string; enforce_nonce?: boolean } = JSON.parse(init.body);
			if (body.enforce_nonce && body.nonce) {
				if (receivedNonces.has(body.nonce)) return Response.json({ id: "test-message" });
				receivedNonces.add(body.nonce);
			}
			messages.push(init.body);
			await api.afterMessage?.();
			return Response.json({ id: "test-message" });
		}
		throw new Error(`Unexpected fetch: ${method} ${url}`);
	});
	api.fetchMock = fetchMock;
	return api;
}

async function fetchWorker(request: Request, environment: Env): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request.clone(), environment, ctx);
	if (new URL(request.url).pathname !== "/interactions" || response.status !== 200) {
		await waitOnExecutionContext(ctx);
		return response;
	}
	const initial: { type: number } = await response.clone().json();
	await waitOnExecutionContext(ctx);
	if (initial.type !== 5) return response;
	const interaction: { token: string } = await request.json();
	const data = interactionResponses.get(interaction.token);
	if (!data) throw new Error("Expected a completed deferred interaction response");
	return Response.json({ type: 4, data });
}

async function linkByCallback(githubId: number, discordId: string): Promise<Response> {
	const state = crypto.randomUUID();
	const { generation } =
		await testEnv.CONTRIBUTOR_LINKS.getByName("global").getLinkContext(discordId);
	await storeOAuthState(testEnv.KV, state, {
		discord_id: discordId,
		discord_username: `discord-${discordId}`,
		link_generation: generation,
	});
	return fetchWorker(
		new Request(`https://worker.test/callback/github?code=${githubId}&state=${state}`),
		testEnv,
	);
}

async function pendingOAuthState(discordId: string): Promise<string> {
	const response = await fetchWorker(await signedCommandRequest(discordId, "link"), testEnv);
	const result: { data?: { components?: { components?: { url?: string }[] }[] } } =
		await response.json();
	const authUrl = result.data?.components?.[0]?.components?.[0]?.url;
	if (!authUrl) throw new Error("Expected GitHub OAuth URL");
	const state = new URL(authUrl).searchParams.get("state");
	if (!state) throw new Error("Expected OAuth state");
	return state;
}

async function linkButtonLabel(discordId: string): Promise<string | undefined> {
	const response = await fetchWorker(await signedCommandRequest(discordId, "link"), testEnv);
	const result: { data?: { components?: { components?: { label?: string }[] }[] } } =
		await response.json();
	return result.data?.components?.[0]?.components?.[0]?.label;
}

async function signedUnlinkRequest(discordId: string): Promise<Request> {
	return signedCommandRequest(discordId, "unlink");
}

async function signedCommandRequest(
	discordId: string,
	name: string,
	guild = guildId,
	timestamp = String(Math.floor(Date.now() / 1000)),
): Promise<Request> {
	const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
	const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
	testEnv.DISCORD_PUBLIC_KEY = toHex(publicKey);
	const body = JSON.stringify({
		type: 2,
		id: crypto.randomUUID(),
		token: crypto.randomUUID(),
		application_id: "test-application",
		guild_id: guild,
		member: { user: { id: discordId, username: "test-member" }, roles: [] },
		data: { name },
	});
	const signature = new Uint8Array(
		await crypto.subtle.sign(
			"Ed25519",
			pair.privateKey,
			new TextEncoder().encode(timestamp + body),
		),
	);
	return new Request("https://worker.test/interactions", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Signature-Ed25519": toHex(signature),
			"X-Signature-Timestamp": timestamp,
		},
		body,
	});
}

function linkRecord(githubId: number, discordId: string) {
	return {
		github_id: githubId,
		github_login: "contributor",
		discord_id: discordId,
		discord_username: `discord-${discordId}`,
		linked_at: new Date().toISOString(),
	};
}

function randomGithubId(): number {
	return Number.parseInt(crypto.randomUUID().replaceAll("-", "").slice(0, 12), 16);
}

function randomDiscordId(): string {
	return String(500000000000000000n + BigInt(randomGithubId()));
}

function untilAborted(signal?: AbortSignal | null): Promise<never> {
	if (!signal) return Promise.reject(new Error("Expected an abort signal"));
	return new Promise((_resolve, reject) => {
		if (signal.aborted) reject(signal.reason);
		else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
	return init?.method ?? (input instanceof Request ? input.method : "GET");
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
