const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_TIMEOUT_MS = 5_000;

async function discordRequest<T>(
	url: string,
	init: RequestInit,
	readResponse: (response: Response) => T | Promise<T>,
	timeoutMs = DISCORD_TIMEOUT_MS,
): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(
		() => {
			controller.abort(new DOMException("Discord request timed out", "TimeoutError"));
		},
		Math.min(timeoutMs, DISCORD_TIMEOUT_MS),
	);
	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		return await readResponse(response);
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Verify Discord interaction signature using Ed25519.
 */
export async function verifyDiscordSignature(
	request: Request,
	publicKey: string,
): Promise<boolean> {
	const signature = request.headers.get("X-Signature-Ed25519");
	const timestamp = request.headers.get("X-Signature-Timestamp");
	if (!signature || !timestamp) return false;
	const timestampSeconds = Number(timestamp);
	if (
		!Number.isSafeInteger(timestampSeconds) ||
		Math.abs(Date.now() / 1000 - timestampSeconds) > 300
	) {
		return false;
	}

	const body = await request.clone().text();
	const encoder = new TextEncoder();

	const key = await crypto.subtle.importKey(
		"raw",
		hexToBytes(publicKey),
		{ name: "Ed25519", namedCurve: "Ed25519" },
		false,
		["verify"],
	);

	return crypto.subtle.verify(
		"Ed25519",
		key,
		hexToBytes(signature),
		encoder.encode(timestamp + body),
	);
}

/**
 * Add a role to a guild member.
 */
export async function addRole(env: Env, userId: string, roleId: string): Promise<boolean> {
	return discordRequest(
		`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${userId}/roles/${roleId}`,
		{
			method: "PUT",
			headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
		},
		(res) => res.ok,
	);
}

/**
 * Remove an existing role from a guild member.
 */
export async function removeRole(env: Env, userId: string, roleId: string): Promise<boolean> {
	return discordRequest(
		`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${userId}/roles/${roleId}`,
		{
			method: "DELETE",
			headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
		},
		(res) => res.ok,
	);
}

export type RoleState = "present" | "absent" | "member_missing";

/**
 * Check if a guild member has a specific role.
 */
export async function getRoleState(env: Env, userId: string, roleId: string): Promise<RoleState> {
	return discordRequest<RoleState>(
		`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${userId}`,
		{ headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } },
		async (res) => {
			if (res.status === 404) return "member_missing";
			if (!res.ok) throw new Error(`Discord member lookup failed with status ${res.status}`);
			const member: { roles: string[] } = await res.json();
			return member.roles.includes(roleId) ? "present" : "absent";
		},
	);
}

/**
 * Post a message to a channel. Only explicit user mentions are allowed;
 * @everyone, @here, and role mentions in content are suppressed.
 */
export async function postMessage(
	env: Env,
	channelId: string,
	content: string,
	mentionUserIds?: string[],
): Promise<boolean> {
	return discordRequest(
		`${DISCORD_API}/channels/${channelId}/messages`,
		{
			method: "POST",
			headers: {
				Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				content,
				allowed_mentions: {
					parse: [], // disable @everyone, @here, role mentions
					users: mentionUserIds ?? [], // only mention these user IDs
				},
			}),
		},
		(res) => res.ok,
	);
}

type MessageDeliveryResult =
	| { status: "sent"; messageId: string }
	| { status: "retry"; retryAfterMs: number }
	| { status: "rejected" };

export async function postMessageWithNonce(
	env: Env,
	channelId: string,
	content: string,
	mentionUserIds: string[],
	nonce: string,
	timeoutMs: number,
): Promise<MessageDeliveryResult> {
	try {
		return await discordRequest<MessageDeliveryResult>(
			`${DISCORD_API}/channels/${channelId}/messages`,
			{
				method: "POST",
				headers: {
					Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					content,
					allowed_mentions: { parse: [], users: mentionUserIds },
					nonce,
					enforce_nonce: true,
				}),
			},
			async (response) => {
				if (response.ok) {
					const message: { id?: unknown } = await response.json();
					if (typeof message.id === "string" && message.id.length > 0) {
						return { status: "sent", messageId: message.id };
					}
					return { status: "retry", retryAfterMs: 250 };
				}
				if (response.status === 429) {
					const header = response.headers.get("Retry-After");
					if (header !== null && header.trim() === "") return { status: "rejected" };
					let seconds: unknown = header === null ? undefined : Number(header);
					if (header === null) {
						const body = await response.json<{ retry_after?: unknown }>().catch(() => null);
						if (!body) return { status: "rejected" };
						seconds = body.retry_after;
					}
					return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
						? { status: "retry", retryAfterMs: Math.ceil(seconds * 1000) }
						: { status: "rejected" };
				}
				return response.status >= 500
					? { status: "retry", retryAfterMs: 250 }
					: { status: "rejected" };
			},
			timeoutMs,
		);
	} catch {
		// A lost response can follow an accepted message; retries must reuse the nonce.
		return { status: "retry", retryAfterMs: 250 };
	}
}

/**
 * Reply to an interaction (type 4 = channel message with source).
 */
export function interactionResponse(content: string, ephemeral = false): Response {
	return Response.json({
		type: 4,
		data: {
			content,
			flags: ephemeral ? 64 : 0,
		},
	});
}

export async function editInteractionResponse(
	env: Env,
	token: string,
	response: Response,
): Promise<void> {
	const { data }: { data: Record<string, unknown> } = await response.json();
	// The initial acknowledgement already set the response's visibility.
	delete data.flags;
	await discordRequest(
		`${DISCORD_API}/webhooks/${env.DISCORD_APP_ID}/${encodeURIComponent(token)}/messages/@original`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ...data, allowed_mentions: { parse: [] } }),
		},
		(result) => {
			if (!result.ok) {
				throw new Error(`Discord interaction response failed with status ${result.status}`);
			}
		},
	);
}

/**
 * Reply with a button component.
 */
export function interactionResponseWithButton(
	content: string,
	buttonLabel: string,
	url: string,
): Response {
	return Response.json({
		type: 4,
		data: {
			content,
			flags: 64, // ephemeral
			components: [
				{
					type: 1, // action row
					components: [
						{
							type: 2, // button
							style: 5, // link
							label: buttonLabel,
							url,
						},
					],
				},
			],
		},
	});
}

function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
	}
	return bytes;
}
