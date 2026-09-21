import { DurableObject } from "cloudflare:workers";

const STATE_KEY = "installation-rate-limit";
const FALLBACK_BACKOFF_MS = 60_000;
const RESET_JITTER_MAX_MS = 5_000;
const MIN_REQUEST_SPACING_MS = 100;
const MAX_REQUEST_SPACING_MS = 5_000;

interface RateLimitState {
	readonly backoffUntil: number;
	readonly nextPermitAt: number;
	readonly releaseUntil?: number;
	readonly leaseConsumer?: string;
	readonly leaseUntil?: number;
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

export class GitHubRateLimitDO extends DurableObject<Env> implements GitHubRateLimitGate {
	override async fetch(request: Request): Promise<Response> {
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
		const leaseEligible = consumer.includes(":");
		if (leaseEligible && (state?.leaseUntil ?? 0) > now && state?.leaseConsumer === consumer) {
			return { allowed: true, retryAt: now };
		}
		const releasing = (state?.releaseUntil ?? 0) > now;
		const retryAt = Math.max(state?.backoffUntil ?? 0, releasing ? (state?.nextPermitAt ?? 0) : 0);
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

		if (!releasing && (state?.backoffUntil ?? 0) === 0) return { allowed: true, retryAt: now };
		const remaining = state?.remaining ?? null;
		const resetAt = state?.resetAt ?? null;
		const spacing = Math.min(
			MAX_REQUEST_SPACING_MS,
			Math.max(
				MIN_REQUEST_SPACING_MS,
				remaining !== null && remaining > 0 && resetAt !== null && resetAt > now
					? Math.ceil((resetAt - now) / remaining)
					: 1_000,
			),
		);
		await this.ctx.storage.put<RateLimitState>(STATE_KEY, {
			backoffUntil: 0,
			nextPermitAt: now + spacing,
			releaseUntil: state?.releaseUntil ?? now + 30_000,
			leaseConsumer: leaseEligible ? consumer : undefined,
			leaseUntil: leaseEligible ? now + 2_000 : undefined,
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
		const resetBoundary = Math.max(
			metadata.retryAfterAt ?? 0,
			metadata.resetAt ?? 0,
			rateLimited ? now + FALLBACK_BACKOFF_MS : 0,
		);
		const backoffUntil = rateLimited
			? Math.max(current?.backoffUntil ?? 0, resetBoundary)
			: current?.backoffUntil && current.backoffUntil > now
				? current.backoffUntil
				: 0;
		const nextPermitAt = rateLimited
			? Math.max(current?.nextPermitAt ?? 0, backoffUntil + randomJitter())
			: (current?.nextPermitAt ?? 0);
		await this.ctx.storage.put<RateLimitState>(STATE_KEY, {
			backoffUntil,
			nextPermitAt,
			releaseUntil: rateLimited ? backoffUntil + 30_000 : current?.releaseUntil,
			leaseConsumer: rateLimited ? undefined : current?.leaseConsumer,
			leaseUntil: rateLimited ? undefined : current?.leaseUntil,
			limit: metadata.limit ?? current?.limit ?? null,
			remaining: metadata.remaining ?? current?.remaining ?? null,
			resetAt: metadata.resetAt ?? current?.resetAt ?? null,
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
}

export function githubRateLimitGate(env: Env): GitHubRateLimitGate {
	return env.GITHUB_RATE_LIMIT.getByName(`installation:${env.GITHUB_APP_INSTALLATION_ID}`);
}
