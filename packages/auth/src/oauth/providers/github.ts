/**
 * GitHub OAuth provider
 */

import { z } from "zod";

import type { OAuthProvider, OAuthProfile } from "../types.js";

const gitHubUserSchema = z.object({
	id: z.number(),
	login: z.string(),
	name: z.string().nullable(),
	email: z.string().nullable(),
	avatar_url: z.string(),
});

const gitHubEmailSchema = z.object({
	email: z.string(),
	primary: z.boolean(),
	verified: z.boolean(),
});

export const github: OAuthProvider = {
	name: "github",
	authorizeUrl: "https://github.com/login/oauth/authorize",
	tokenUrl: "https://github.com/login/oauth/access_token",
	userInfoUrl: "https://api.github.com/user",
	scopes: ["read:user", "user:email"],

	parseProfile(data: unknown): OAuthProfile {
		const user = gitHubUserSchema.parse(data);
		return {
			id: String(user.id),
			email: user.email || "", // Will be fetched separately if needed
			name: user.name,
			avatarUrl: user.avatar_url,
			emailVerified: true, // GitHub verifies emails
		};
	},
};

/**
 * Fetch the user's primary email from GitHub
 * (needed because email may not be returned in the basic user endpoint)
 */
export async function fetchGitHubEmail(accessToken: string): Promise<string> {
	const response = await fetch("https://api.github.com/user/emails", {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "emdash-cms",
		},
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch GitHub emails: ${response.status}`);
	}

	const json: unknown = await response.json();
	const emails = z.array(gitHubEmailSchema).parse(json);
	const primary = emails.find((e) => e.primary && e.verified);

	if (!primary) {
		throw new Error("No verified primary email found on GitHub account");
	}

	return primary.email;
}
