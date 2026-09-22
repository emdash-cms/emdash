import { DurableObject } from "cloudflare:workers";

import { mintInstallationToken, readAppCreds } from "./github.js";

const STATE_KEY = "installation-rate-limit";
const TOKEN_KEY = "installation-token";
const TOKEN_TTL_MS = 55 * 60_000;
const FALLBACK_BACKOFF_MS = 60_000;
const RESET_JITTER_MAX_MS = 5_000;
const MIN_REQUEST_SPACING_MS = 100;

export interface RateLimitState {
	readonly backoffUntil: number;
	readonly nextPermitAt: number;
	readonly limit: number | null;
	readonly remaining: number | null;
	readonly resetAt: number | null;
}

export interface GitHubPermit {
	readonly allowed: boolean;
	readonly retryAt: number;
}

export interface GitHubResponseMetadata {
	readonly status: number;
	readonly limit: number | null;
	readonly remaining: number | null;
	readonly resetAt: number | null;
	readonly retryAfterAt: number | null;
}

export interface GitHubRateLimitGate {
	permit(category: string, consumer: string): Promise<GitHubPermit>;
	record(category: string, consumer: string, metadata: GitHubResponseMetadata): Promise<void>;
	inspect(): Promise<RateLimitState | null>;
	getInstallationToken(): Promise<string>;
}

interface CachedToken {
	readonly token: string;
	readonly expiresAt: number;
}

function finiteHeader(value: string | null): number | null {
	if (value === null) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function parseGitHubResponseMetadata(
	response: Response,
	now = Date.now(),
): GitHubResponseMetadata {
	const resetSeconds = finiteHeader(response.headers.get("x-ratelimit-reset"));
	const retryAfter = response.headers.get("retry-after")?.trim() ?? "";
	let retryAfterAt: number | null = null;
	if (retryAfter) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds) && seconds >= 0) retryAfterAt = now + seconds * 1_000;
		else {
			const parsed = Date.parse(retryAfter);
			if (Number.isFinite(parsed)) retryAfterAt = parsed;
		}
	}
	return {
		status: response.status,
		limit: finiteHeader(response.headers.get("x-ratelimit-limit")),
		remaining: finiteHeader(response.headers.get("x-ratelimit-remaining")),
		resetAt: resetSeconds === null ? null : resetSeconds * 1_000,
		retryAfterAt,
	};
}

function randomJitter(): number {
	const value = new Uint32Array(1);
	crypto.getRandomValues(value);
	return Math.floor(((value[0] ?? 0) / 0xffffffff) * RESET_JITTER_MAX_MS);
}

function nullableNumber(value: unknown): number | null {
	return typeof value === "number" ? value : null;
}

function requestSpacing(remaining: number | null, resetAt: number | null, now: number): number {
	if (remaining === 0 && resetAt !== null && resetAt > now) return resetAt - now;
	if (remaining === null || remaining < 1 || resetAt === null || resetAt <= now) {
		return MIN_REQUEST_SPACING_MS;
	}
	return Math.max(MIN_REQUEST_SPACING_MS, Math.ceil((resetAt - now) / remaining));
}

export class GitHubRateLimitDO extends DurableObject<Env> implements GitHubRateLimitGate {
	private tokenPromise: Promise<string> | undefined;

	override async fetch(request: Request): Promise<Response> {
		if (new URL(request.url).pathname === "/token") {
			return Response.json({ token: await this.getInstallationToken() });
		}
		const payload = await request.json<unknown>().catch(() => null);
		if (!payload || typeof payload !== "object")
			return new Response("invalid request", { status: 400 });
		const input = Object.fromEntries(Object.entries(payload));
		const category = typeof input.category === "string" ? input.category : null;
		const consumer = typeof input.consumer === "string" ? input.consumer : null;
		if (!category || !consumer) return new Response("invalid request", { status: 400 });
		if (new URL(request.url).pathname === "/permit") {
			return Response.json(await this.permit(category, consumer));
		}
		if (new URL(request.url).pathname === "/record") {
			const metadata = input.metadata;
			if (!metadata || typeof metadata !== "object") {
				return new Response("invalid request", { status: 400 });
			}
			const record = Object.fromEntries(Object.entries(metadata));
			if (typeof record.status !== "number")
				return new Response("invalid request", { status: 400 });
			await this.record(category, consumer, {
				status: record.status,
				limit: nullableNumber(record.limit),
				remaining: nullableNumber(record.remaining),
				resetAt: nullableNumber(record.resetAt),
				retryAfterAt: nullableNumber(record.retryAfterAt),
			});
			return new Response(null, { status: 204 });
		}
		return new Response("not found", { status: 404 });
	}

	async permit(category: string, consumer: string): Promise<GitHubPermit> {
		const now = Date.now();
		const state = await this.ctx.storage.get<RateLimitState>(STATE_KEY);
		const retryAt = Math.max(state?.backoffUntil ?? 0, state?.nextPermitAt ?? 0);
		if (retryAt > now) {
			console.info(
				JSON.stringify({
					message: "github request suppressed",
					category,
					consumer,
					retryAt,
				}),
			);
			return { allowed: false, retryAt };
		}

		const remaining = state?.remaining ?? null;
		const resetAt = state?.resetAt ?? null;
		const spacing = requestSpacing(remaining, resetAt, now);
		await this.ctx.storage.put<RateLimitState>(STATE_KEY, {
			backoffUntil: 0,
			nextPermitAt: now + spacing,
			limit: state?.limit ?? null,
			remaining: remaining === null ? null : Math.max(0, remaining - 1),
			resetAt,
		});
		return { allowed: true, retryAt: now };
	}

	async record(
		category: string,
		consumer: string,
		metadata: GitHubResponseMetadata,
	): Promise<void> {
		const now = Date.now();
		const current = await this.ctx.storage.get<RateLimitState>(STATE_KEY);
		const rateLimited =
			metadata.status === 429 ||
			(metadata.status === 403 && (metadata.remaining === 0 || metadata.retryAfterAt !== null));
		const resetBoundary =
			metadata.remaining === 0
				? Math.max(metadata.retryAfterAt ?? 0, metadata.resetAt ?? 0, now + FALLBACK_BACKOFF_MS)
				: (metadata.retryAfterAt ?? (rateLimited ? now + FALLBACK_BACKOFF_MS : 0));
		const backoffUntil = rateLimited
			? Math.max(current?.backoffUntil ?? 0, resetBoundary)
			: current?.backoffUntil && current.backoffUntil > now
				? current.backoffUntil
				: 0;
		const remaining = metadata.remaining ?? current?.remaining ?? null;
		const resetAt = metadata.resetAt ?? current?.resetAt ?? null;
		const nextPermitAt = rateLimited
			? Math.max(current?.nextPermitAt ?? 0, backoffUntil + randomJitter())
			: Math.max(current?.nextPermitAt ?? 0, now + requestSpacing(remaining, resetAt, now));
		await this.ctx.storage.put<RateLimitState>(STATE_KEY, {
			backoffUntil,
			nextPermitAt,
			limit: metadata.limit ?? current?.limit ?? null,
			remaining,
			resetAt,
		});
		console.info(
			JSON.stringify({
				message: "github response budget",
				category,
				consumer,
				status: metadata.status,
				limit: metadata.limit,
				remaining: metadata.remaining,
				resetAt: metadata.resetAt,
				backoffUntil,
			}),
		);
	}

	async inspect(): Promise<RateLimitState | null> {
		return (await this.ctx.storage.get<RateLimitState>(STATE_KEY)) ?? null;
	}

	async getInstallationToken(): Promise<string> {
		if (this.tokenPromise) return this.tokenPromise;
		this.tokenPromise = this.loadInstallationToken();
		try {
			return await this.tokenPromise;
		} finally {
			this.tokenPromise = undefined;
		}
	}

	private async loadInstallationToken(): Promise<string> {
		const cached = await this.ctx.storage.get<CachedToken>(TOKEN_KEY);
		if (cached && cached.expiresAt > Date.now()) return cached.token;
		const creds = readAppCreds(this.env);
		if (!creds) throw new Error("GitHub App credentials are not configured");
		const token = await mintInstallationToken(creds);
		await this.ctx.storage.put<CachedToken>(TOKEN_KEY, {
			token,
			expiresAt: Date.now() + TOKEN_TTL_MS,
		});
		return token;
	}

	async debugSetInstallationToken(token: string, expiresAt: number): Promise<void> {
		await this.ctx.storage.put<CachedToken>(TOKEN_KEY, { token, expiresAt });
	}
}

export function githubRateLimitGate(env: Env): GitHubRateLimitGate {
	return env.GITHUB_RATE_LIMIT.getByName(`installation:${env.GITHUB_APP_INSTALLATION_ID}`);
}
