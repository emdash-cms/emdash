import {
	verifyDiscordSignature,
	interactionResponse,
	interactionResponseWithButton,
	addRole,
	hasRole,
	postMessage,
} from "./discord.js";
import { verifyGitHubSignature, githubAuthUrl, exchangeGitHubCode } from "./github.js";
import {
	findByGitHubId,
	findByDiscordId,
	storeLink,
	storeOAuthState,
	consumeOAuthState,
	isDeliveryProcessed,
	markDeliveryProcessed,
	recordContributor,
	hasContributed,
} from "./kv.js";
import type { DiscordInteraction, GitHubPRPayload } from "./types.js";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		switch (url.pathname) {
			case "/interactions":
				return handleInteraction(request, env);
			case "/callback/github":
				return handleGitHubCallback(request, env);
			case "/webhook/github":
				return handleGitHubWebhook(request, env);
			default:
				return new Response("Not found", { status: 404 });
		}
	},
} satisfies ExportedHandler<Env>;

// ─── Discord Interaction Handler ─────────────────────────────────

async function handleInteraction(request: Request, env: Env): Promise<Response> {
	if (request.method !== "POST") {
		return new Response("Method not allowed", { status: 405 });
	}

	const isValid = await verifyDiscordSignature(request, env.DISCORD_PUBLIC_KEY);
	if (!isValid) {
		return new Response("Invalid signature", { status: 401 });
	}

	const interaction: DiscordInteraction = await request.json();

	// Discord PING verification
	if (interaction.type === 1) {
		return Response.json({ type: 1 });
	}

	// Slash command
	if (interaction.type === 2 && interaction.data?.name === "link") {
		return handleLinkCommand(interaction, env);
	}

	return interactionResponse("Unknown command.", true);
}

async function handleLinkCommand(interaction: DiscordInteraction, env: Env): Promise<Response> {
	const user = interaction.member?.user;
	if (!user) {
		return interactionResponse("This command can only be used in a server.", true);
	}

	// Generate state token and store it
	const state = crypto.randomUUID();
	await storeOAuthState(env.KV, state, {
		discord_id: user.id,
		discord_username: user.username,
	});

	const authUrl = githubAuthUrl(env, state);

	const existing = await findByDiscordId(env.KV, user.id);
	if (existing) {
		return interactionResponseWithButton(
			`Your Discord account is linked to GitHub user **${existing.github_login}**. ` +
				`Click below to relink to a different account.`,
			"Relink GitHub Account",
			authUrl,
		);
	}

	return interactionResponseWithButton(
		"Click the button below to link your GitHub account. " +
			"This will verify your identity so we can grant you the Contributor role when your PRs are merged.",
		"Link GitHub Account",
		authUrl,
	);
}

// ─── GitHub OAuth Callback ───────────────────────────────────────

async function handleGitHubCallback(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");

	if (!code || !state) {
		return htmlResponse("Missing code or state parameter.", 400);
	}

	// Validate and consume the state token
	const oauthState = await consumeOAuthState(env.KV, state);
	if (!oauthState) {
		return htmlResponse("Invalid or expired link. Please run /link in Discord again.", 400);
	}

	// Exchange code for GitHub identity
	const githubUser = await exchangeGitHubCode(env, code);
	if (!githubUser) {
		return htmlResponse("Failed to verify your GitHub account. Please try again.", 500);
	}

	// Store the bidirectional link
	const link = {
		github_id: githubUser.id,
		github_login: githubUser.login,
		discord_id: oauthState.discord_id,
		discord_username: oauthState.discord_username,
		linked_at: new Date().toISOString(),
	};
	await storeLink(env.KV, link);

	// If this GitHub user has had PRs merged, grant the contributor role now
	const contributed = await hasContributed(env.KV, githubUser.id);
	const alreadyHasRole = contributed
		? await hasRole(env, oauthState.discord_id, env.DISCORD_CONTRIBUTOR_ROLE_ID)
		: false;

	let roleGranted = false;
	if (contributed && !alreadyHasRole) {
		roleGranted = await addRole(env, oauthState.discord_id, env.DISCORD_CONTRIBUTOR_ROLE_ID);
		if (roleGranted) {
			await postMessage(
				env,
				env.DISCORD_CHANNEL_ID,
				pick(welcomeMessages, {
					user: `<@${oauthState.discord_id}>`,
					login: githubUser.login,
				}),
				[oauthState.discord_id],
			);
		}
	}

	let statusMessage: string;
	if (roleGranted) {
		statusMessage =
			`Successfully linked! GitHub user <strong>${escapeHtml(githubUser.login)}</strong> ` +
			`is now connected to your Discord account. ` +
			`You've been granted the <strong>Contributor</strong> role! You can close this tab.`;
	} else if (contributed) {
		statusMessage =
			`Successfully linked! GitHub user <strong>${escapeHtml(githubUser.login)}</strong> ` +
			`is now connected to your Discord account. You can close this tab.`;
	} else {
		statusMessage =
			`Successfully linked! GitHub user <strong>${escapeHtml(githubUser.login)}</strong> ` +
			`is now connected to your Discord account. ` +
			`You'll get the Contributor role once you have a PR merged. You can close this tab.`;
	}

	return htmlResponse(statusMessage, 200);
}

// ─── GitHub Webhook Handler ──────────────────────────────────────

async function handleGitHubWebhook(request: Request, env: Env): Promise<Response> {
	if (request.method !== "POST") {
		return new Response("Method not allowed", { status: 405 });
	}

	const event = request.headers.get("X-GitHub-Event");
	if (event !== "pull_request") {
		return new Response("Ignored event", { status: 200 });
	}

	const body = await request.text();
	const signature = request.headers.get("X-Hub-Signature-256");

	const isValid = await verifyGitHubSignature(body, signature, env.GITHUB_WEBHOOK_SECRET);
	if (!isValid) {
		return new Response("Invalid signature", { status: 401 });
	}

	// Deduplicate retries
	const deliveryId = request.headers.get("X-GitHub-Delivery");
	if (deliveryId && (await isDeliveryProcessed(env.KV, deliveryId))) {
		return new Response("Already processed", { status: 200 });
	}

	const payload: GitHubPRPayload = JSON.parse(body);

	// Verify this is from the expected repository
	if (payload.repository.full_name !== env.GITHUB_REPO) {
		return new Response("Wrong repository", { status: 200 });
	}

	// Only care about merged PRs
	if (payload.action !== "closed" || !payload.pull_request.merged) {
		return new Response("Not a merge", { status: 200 });
	}

	const githubLogin = payload.pull_request.user.login;
	const githubId = payload.pull_request.user.id;
	const prNumber = payload.number;
	const prTitle = payload.pull_request.title;
	const prUrl = payload.pull_request.html_url;

	// Skip bots and the repo owner
	if (
		payload.pull_request.user.login === env.GITHUB_OWNER_LOGIN ||
		payload.pull_request.user.login.endsWith("[bot]")
	) {
		return new Response("Skipped owner/bot", { status: 200 });
	}

	// Record this contributor (for retroactive role grant at /link time)
	await recordContributor(env.KV, githubId, githubLogin);

	// Check if user has a linked Discord account
	const link = await findByGitHubId(env.KV, githubId);

	const prLink = `[#${prNumber} ${prTitle}](${prUrl})`;

	if (link) {
		await postMessage(
			env,
			env.DISCORD_CHANNEL_ID,
			pick(linkedMergeMessages, {
				user: `<@${link.discord_id}>`,
				login: githubLogin,
				pr: prLink,
			}),
			[link.discord_id],
		);
	} else {
		await postMessage(
			env,
			env.DISCORD_CHANNEL_ID,
			pick(unlinkedMergeMessages, { login: githubLogin, pr: prLink }),
		);
	}

	// Mark delivery processed after all side effects succeed
	if (deliveryId) {
		await markDeliveryProcessed(env.KV, deliveryId);
	}

	return new Response("OK", { status: 200 });
}

// ─── Message Templates ───────────────────────────────────────────

type Vars = Record<string, string>;

const PLACEHOLDER_RE = /\{(\w+)\}/g;

/** Pick a random template and substitute {key} placeholders. */
function pick(templates: string[], vars: Vars): string {
	const template = templates[Math.floor(Math.random() * templates.length)]!;
	return template.replace(PLACEHOLDER_RE, (_, key: string) => vars[key] ?? `{${key}}`);
}

const linkedMergeMessages = [
	"PR merged! {user} (**{login}**): {pr}",
	"Nice one {user}! Your PR just landed: {pr}",
	"{user}'s PR is in: {pr}",
	"Shipped! {pr} by {user} (**{login}**)",
	"Another one from {user}: {pr}",
];

const unlinkedMergeMessages = [
	"PR merged by **{login}**: {pr}\nIs this you? Use `/link` to connect your GitHub account and get the Contributor role!",
	"**{login}** just got a PR merged: {pr}\nIf you're **{login}** on GitHub, use `/link` to claim your Contributor role!",
	"Fresh merge from **{login}**: {pr}\nAre you **{login}**? `/link` your GitHub to get the Contributor role.",
	"**{login}**'s PR just shipped: {pr}\nHey **{login}**, use `/link` to connect your GitHub and get recognized!",
];

const welcomeMessages = [
	"Welcome {user} to the contributor team! They just linked their GitHub account (**{login}**) and already have merged PRs. Thanks for contributing to EmDash!",
	"Big welcome to {user} (**{login}** on GitHub)! They've already been shipping PRs and just linked their account. Contributor role granted!",
	"{user} just linked their GitHub (**{login}**) and they're already a contributor! Welcome to the team!",
	"Say hello to {user}! They linked as **{login}** on GitHub, and they've already got merged PRs. Contributor role well earned!",
];

// ─── Helpers ─────────────────────────────────────────────────────

function htmlResponse(body: string, status: number): Response {
	return new Response(
		`<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>EmDash Discord Link</title>
	<style>
		body { font-family: system-ui, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 20px; color: #222; }
		h1 { font-size: 1.2rem; }
	</style>
</head>
<body>
	<h1>EmDash Discord Bot</h1>
	<p>${body}</p>
</body>
</html>`,
		{
			status,
			headers: { "Content-Type": "text/html;charset=utf-8" },
		},
	);
}

const AMP_RE = /&/g;
const LT_RE = /</g;
const GT_RE = />/g;
const QUOT_RE = /"/g;

function escapeHtml(str: string): string {
	return str
		.replace(AMP_RE, "&amp;")
		.replace(LT_RE, "&lt;")
		.replace(GT_RE, "&gt;")
		.replace(QUOT_RE, "&quot;");
}
