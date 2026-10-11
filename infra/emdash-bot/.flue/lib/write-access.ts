// GitHub reports org members whose membership is private as CONTRIBUTOR to
// apps, so `author_association` alone treats those maintainers as outsiders.
// Anyone it doesn't already show as a maintainer is checked against their
// repository permission instead.

import { getCollaboratorPermission, type GitHubToken, type RepoContext } from "./github.js";

const MAINTAINER_ASSOCIATIONS: ReadonlySet<string> = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const WRITE_PERMISSIONS: ReadonlySet<string> = new Set(["admin", "write"]);
const DEFAULT_TTL_MS = 10 * 60_000;

/** True when GitHub's reported association already shows maintainer access. */
export function hasMaintainerAssociation(association: string | null | undefined): boolean {
	return !!association && MAINTAINER_ASSOCIATIONS.has(association.toUpperCase());
}

export interface WriteAccessResolver {
	/** The logins among `logins` that can push to the repository, lowercased. */
	writers(
		token: GitHubToken,
		ctx: RepoContext,
		logins: Iterable<string>,
		signal?: AbortSignal,
	): Promise<ReadonlySet<string>>;
}

export function createWriteAccessResolver(
	options: { ttlMs?: number; now?: () => number } = {},
): WriteAccessResolver {
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
	const now = options.now ?? Date.now;
	const cache = new Map<string, { writer: boolean; expiresAt: number }>();

	return {
		async writers(token, ctx, logins, signal) {
			const unique = new Set<string>();
			for (const login of logins) {
				const normalized = login.toLowerCase();
				if (normalized !== "" && !normalized.endsWith("[bot]")) unique.add(normalized);
			}
			const writers = new Set<string>();
			const pending: string[] = [];
			for (const login of unique) {
				const cached = cache.get(cacheKey(ctx, login));
				if (cached && cached.expiresAt > now()) {
					if (cached.writer) writers.add(login);
				} else {
					pending.push(login);
				}
			}
			await Promise.all(
				pending.map(async (login) => {
					try {
						const permission = await getCollaboratorPermission(token, ctx, login, signal);
						const writer = WRITE_PERMISSIONS.has(permission);
						cache.set(cacheKey(ctx, login), { writer, expiresAt: now() + ttlMs });
						if (writer) writers.add(login);
					} catch (error) {
						console.warn("[write-access] permission lookup failed", {
							login,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}),
			);
			return writers;
		},
	};
}

function cacheKey(ctx: RepoContext, login: string): string {
	return `${ctx.owner}/${ctx.repo}:${login}`.toLowerCase();
}

export const writeAccess = createWriteAccessResolver();
