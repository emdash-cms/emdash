import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import worker from "../src/index.js";
import { isDeliveryProcessed, storeLink } from "../src/kv.js";

const testEnv = env as Env;
const guildId = "123456789";
const roleId = "987654321";
const channelId = "555555555";
const webhookSecret = "test-webhook-secret";

beforeEach(() => {
	testEnv.DISCORD_GUILD_ID = guildId;
	testEnv.DISCORD_CONTRIBUTOR_ROLE_ID = roleId;
	testEnv.DISCORD_CHANNEL_ID = channelId;
	testEnv.DISCORD_BOT_TOKEN = "test-bot-token";
	testEnv.GITHUB_WEBHOOK_SECRET = webhookSecret;
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("linked contributor's first merged PR", () => {
	test("grants Contributor once and only announces subsequent merges", async () => {
		const { githubId, roleUrl, memberUrl, channelUrl } = await linkedContributor();
		const deliveryId = crypto.randomUUID();
		const fetchMock = discordFetch({ roleUrl, memberUrl, channelUrl, deliveryId, roleStatus: 204 });
		vi.stubGlobal("fetch", fetchMock);

		const response = await worker.fetch(
			await mergedPrRequest(githubId, deliveryId),
			testEnv,
			createExecutionContext(),
		);

		expect(response.status).toBe(200);
		expect(
			fetchMock.mock.calls.some(
				([input, init]) => requestUrl(input) === roleUrl && init?.method === "PUT",
			),
		).toBe(true);
		expect(await isDeliveryProcessed(testEnv.KV, deliveryId)).toBe(true);
		expect(await testEnv.KV.get(`contributor:${githubId}`)).toBe("regression-contributor");
		expect(
			fetchMock.mock.calls.some(
				([input, init]) => requestUrl(input) === channelUrl && init?.method === "POST",
			),
		).toBe(true);

		const nextDeliveryId = crypto.randomUUID();
		const nextFetch = discordFetch({
			roleUrl,
			memberUrl,
			channelUrl,
			deliveryId: nextDeliveryId,
			roleStatus: 204,
		});
		vi.stubGlobal("fetch", nextFetch);
		const nextResponse = await worker.fetch(
			await mergedPrRequest(githubId, nextDeliveryId),
			testEnv,
			createExecutionContext(),
		);
		expect(nextResponse.status).toBe(200);
		expect(nextFetch.mock.calls.some(([input]) => requestUrl(input) === memberUrl)).toBe(false);
		expect(nextFetch.mock.calls.some(([input]) => requestUrl(input) === roleUrl)).toBe(false);
		expect(nextFetch.mock.calls.some(([input]) => requestUrl(input) === channelUrl)).toBe(true);
	});

	test("confirms an existing Contributor role once without granting it again", async () => {
		const { githubId, roleUrl, memberUrl, channelUrl } = await linkedContributor();
		const deliveryId = crypto.randomUUID();
		const fetchMock = discordFetch({
			roleUrl,
			memberUrl,
			channelUrl,
			deliveryId,
			roleStatus: 204,
			memberRoles: [roleId],
		});
		vi.stubGlobal("fetch", fetchMock);

		const response = await worker.fetch(
			await mergedPrRequest(githubId, deliveryId),
			testEnv,
			createExecutionContext(),
		);
		expect(response.status).toBe(200);
		expect(fetchMock.mock.calls.some(([input]) => requestUrl(input) === memberUrl)).toBe(true);
		expect(fetchMock.mock.calls.some(([input]) => requestUrl(input) === roleUrl)).toBe(false);

		fetchMock.mockClear();
		await worker.fetch(
			await mergedPrRequest(githubId, crypto.randomUUID()),
			testEnv,
			createExecutionContext(),
		);
		expect(fetchMock.mock.calls.some(([input]) => requestUrl(input) === memberUrl)).toBe(false);
		expect(fetchMock.mock.calls.some(([input]) => requestUrl(input) === roleUrl)).toBe(false);
	});

	test("leaves the delivery retryable when Discord rejects the role grant", async () => {
		const { githubId, roleUrl, memberUrl, channelUrl } = await linkedContributor();
		const deliveryId = crypto.randomUUID();
		const fetchMock = discordFetch({ roleUrl, memberUrl, channelUrl, deliveryId, roleStatus: 503 });
		vi.stubGlobal("fetch", fetchMock);

		const status = await worker
			.fetch(await mergedPrRequest(githubId, deliveryId), testEnv, createExecutionContext())
			.then(
				(response) => response.status,
				() => 500,
			);

		expect(
			fetchMock.mock.calls.some(
				([input, init]) => requestUrl(input) === roleUrl && init?.method === "PUT",
			),
		).toBe(true);
		expect(status).toBeGreaterThanOrEqual(500);
		expect(await isDeliveryProcessed(testEnv.KV, deliveryId)).toBe(false);

		const retryMock = discordFetch({ roleUrl, memberUrl, channelUrl, deliveryId, roleStatus: 204 });
		vi.stubGlobal("fetch", retryMock);
		const retryResponse = await worker.fetch(
			await mergedPrRequest(githubId, deliveryId),
			testEnv,
			createExecutionContext(),
		);
		expect(retryResponse.status).toBe(200);
		expect(await isDeliveryProcessed(testEnv.KV, deliveryId)).toBe(true);
		expect(
			retryMock.mock.calls.some(
				([input, init]) => requestUrl(input) === roleUrl && init?.method === "PUT",
			),
		).toBe(true);
		expect(
			retryMock.mock.calls.some(
				([input, init]) => requestUrl(input) === channelUrl && init?.method === "POST",
			),
		).toBe(true);

		const callsAfterRetry = retryMock.mock.calls.length;
		const duplicateResponse = await worker.fetch(
			await mergedPrRequest(githubId, deliveryId),
			testEnv,
			createExecutionContext(),
		);
		expect(duplicateResponse.status).toBe(200);
		expect(retryMock.mock.calls).toHaveLength(callsAfterRetry);
	});

	test("keeps a departed member's merge retryable when the announcement is rejected", async () => {
		const { githubId, roleUrl, memberUrl, channelUrl } = await linkedContributor();
		const deliveryId = crypto.randomUUID();
		const options = {
			roleUrl,
			memberUrl,
			channelUrl,
			deliveryId,
			roleStatus: 204,
			memberStatus: 404,
		};
		const rejectedFetch = discordFetch({ ...options, channelStatus: 503 });
		vi.stubGlobal("fetch", rejectedFetch);

		await expect(
			worker.fetch(await mergedPrRequest(githubId, deliveryId), testEnv, createExecutionContext()),
		).rejects.toThrow("Discord rejected merge announcement");
		expect(await isDeliveryProcessed(testEnv.KV, deliveryId)).toBe(false);

		const retryFetch = discordFetch(options);
		vi.stubGlobal("fetch", retryFetch);
		const response = await worker.fetch(
			await mergedPrRequest(githubId, deliveryId),
			testEnv,
			createExecutionContext(),
		);
		expect(response.status).toBe(200);
		expect(await isDeliveryProcessed(testEnv.KV, deliveryId)).toBe(true);
		expect(
			retryFetch.mock.calls.filter(([input]) => requestUrl(input) === channelUrl),
		).toHaveLength(1);
	});

	test("announces a merge without mentioning or inviting a linked member who left the guild", async () => {
		const { githubId, discordId, roleUrl, memberUrl, channelUrl } = await linkedContributor();
		const deliveryId = crypto.randomUUID();
		const fetchMock = discordFetch({
			roleUrl,
			memberUrl,
			channelUrl,
			deliveryId,
			roleStatus: 204,
			memberStatus: 404,
		});
		vi.stubGlobal("fetch", fetchMock);

		const response = await worker.fetch(
			await mergedPrRequest(githubId, deliveryId),
			testEnv,
			createExecutionContext(),
		);

		expect(response.status).toBe(200);
		expect(await isDeliveryProcessed(testEnv.KV, deliveryId)).toBe(true);
		expect(
			fetchMock.mock.calls.some(
				([input, init]) => requestUrl(input) === roleUrl && init?.method === "PUT",
			),
		).toBe(false);
		const announcements = fetchMock.mock.calls.filter(
			([input, init]) => requestUrl(input) === channelUrl && init?.method === "POST",
		);
		expect(announcements).toHaveLength(1);
		const body = announcements[0]?.[1]?.body;
		if (typeof body !== "string") throw new Error("Expected message JSON");
		const message = JSON.parse(body);
		expect(message.content).toContain("regression-contributor");
		expect(message.content).toContain("[#42 A regression test PR](<https://example.test/pull/42>)");
		expect(message.content).not.toContain("<@");
		expect(message.content).not.toContain("/link");
		expect(message.allowed_mentions).toEqual({ parse: [], users: [] });
		expect(fetchMock.mock.calls).toHaveLength(2);
		expect(
			await testEnv.CONTRIBUTOR_LINKS.getByName("global").getByGitHubId(githubId),
		).toMatchObject({ github_id: githubId, discord_id: discordId });

		const duplicateResponse = await worker.fetch(
			await mergedPrRequest(githubId, deliveryId),
			testEnv,
			createExecutionContext(),
		);
		expect(duplicateResponse.status).toBe(200);
		expect(await duplicateResponse.text()).toBe("Already processed");
		expect(fetchMock.mock.calls).toHaveLength(2);
	});
});

async function linkedContributor() {
	const githubId = Number.parseInt(crypto.randomUUID().replaceAll("-", "").slice(0, 12), 16);
	const discordId = String(500000000000000000n + BigInt(githubId));
	await storeLink(testEnv.KV, {
		github_id: githubId,
		github_login: "regression-contributor",
		discord_id: discordId,
		discord_username: "regression-discord",
		linked_at: new Date().toISOString(),
	});
	return {
		githubId,
		discordId,
		roleUrl: `https://discord.com/api/v10/guilds/${guildId}/members/${discordId}/roles/${roleId}`,
		memberUrl: `https://discord.com/api/v10/guilds/${guildId}/members/${discordId}`,
		channelUrl: `https://discord.com/api/v10/channels/${channelId}/messages`,
	};
}

function discordFetch({
	roleUrl,
	memberUrl,
	channelUrl,
	deliveryId,
	roleStatus,
	memberStatus = 200,
	memberRoles = [],
	channelStatus = 200,
}: {
	roleUrl: string;
	memberUrl: string;
	channelUrl: string;
	deliveryId: string;
	roleStatus: number;
	memberStatus?: number;
	memberRoles?: string[];
	channelStatus?: number;
}) {
	return vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
		const url = requestUrl(input);
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");
		if (url === memberUrl && method === "GET") {
			return memberStatus === 200
				? Response.json({ roles: memberRoles })
				: new Response(null, { status: memberStatus });
		}
		if (url === roleUrl && method === "PUT") {
			expect(await isDeliveryProcessed(testEnv.KV, deliveryId)).toBe(false);
			return new Response(null, { status: roleStatus });
		}
		if (url === channelUrl && method === "POST") {
			return Response.json({ id: "test-message" }, { status: channelStatus });
		}
		throw new Error(`Unexpected fetch: ${method} ${url}`);
	});
}

async function mergedPrRequest(githubId: number, deliveryId: string): Promise<Request> {
	const body = JSON.stringify({
		action: "closed",
		number: 42,
		pull_request: {
			merged: true,
			title: "A regression test PR",
			html_url: "https://example.test/pull/42",
			user: { id: githubId, login: "regression-contributor", type: "User" },
		},
		repository: { full_name: "emdash-cms/emdash" },
	});
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(webhookSecret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
	const hex = Array.from(new Uint8Array(signature), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return new Request("https://worker.test/webhook/github", {
		method: "POST",
		headers: {
			"X-GitHub-Event": "pull_request",
			"X-GitHub-Delivery": deliveryId,
			"X-Hub-Signature-256": `sha256=${hex}`,
		},
		body,
	});
}

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}
