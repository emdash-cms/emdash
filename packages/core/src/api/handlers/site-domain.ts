/**
 * Site domain handlers
 *
 * Changing the site's domain stores the new origin as the Site URL, which
 * links in emails and plugins, sitemaps, and absolute URLs in search and
 * social metadata use. Before it is stored, EmDash fetches a one-time token
 * from the new domain to prove the domain serves this site.
 */

import type { Kysely } from "kysely";

import { OptionsRepository } from "../../database/repositories/options.js";
import type { Database } from "../../database/types.js";
import { resolveAndValidateExternalUrl } from "../../security/ssrf.js";
import { setSiteSettings } from "../../settings/index.js";
import { encodeBase64url } from "../../utils/base64.js";
import type { ApiResult } from "../types.js";

export const DOMAIN_PROOF_PATH = "/_emdash/api/site/domain-proof";

const PROOF_OPTION = "emdash:domain_proof";
const PROOF_TTL_MS = 60_000;
const CHECK_TIMEOUT_MS = 10_000;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

interface DomainProof {
	token: string;
	expiresAt: number;
}

/**
 * Parse a bare hostname or an `https://` origin into an origin. Paths,
 * ports, credentials, IP addresses, and single-label hosts are rejected.
 */
export function parseSiteDomain(input: string): string | undefined {
	const trimmed = input.trim();
	const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
	if (!URL.canParse(candidate)) return undefined;
	const url = new URL(candidate);
	if (url.protocol !== "https:") return undefined;
	if (url.username || url.password || url.port || url.search || url.hash) return undefined;
	if (url.pathname !== "/") return undefined;
	const host = url.hostname;
	if (!host.includes(".") || host.endsWith(".") || host.startsWith("[") || IPV4_RE.test(host)) {
		return undefined;
	}
	return url.origin;
}

function checkFailed(message: string): ApiResult<never> {
	return { success: false, error: { code: "DOMAIN_CHECK_FAILED", message } };
}

/**
 * Verify that `input` serves this site and store it as the Site URL.
 */
export async function handleSiteDomainChange(
	db: Kysely<Database>,
	input: string,
): Promise<ApiResult<{ url: string }>> {
	const origin = parseSiteDomain(input);
	if (!origin) {
		return {
			success: false,
			error: {
				code: "VALIDATION_ERROR",
				message: "Enter a domain such as example.com, without a path or port",
			},
		};
	}

	const options = new OptionsRepository(db);
	const token = encodeBase64url(crypto.getRandomValues(new Uint8Array(24)));
	const proof: DomainProof = { token, expiresAt: Date.now() + PROOF_TTL_MS };
	const revision = await options.setVersioned(PROOF_OPTION, proof);

	try {
		const proofUrl = `${origin}${DOMAIN_PROOF_PATH}`;
		try {
			await resolveAndValidateExternalUrl(proofUrl);
		} catch {
			return checkFailed(`${new URL(origin).hostname} does not resolve to a public address`);
		}

		let response: Response;
		try {
			response = await fetch(proofUrl, {
				method: "POST",
				redirect: "manual",
				headers: { Accept: "application/json", "X-EmDash-Request": "1" },
				signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
			});
		} catch {
			return checkFailed(`Could not reach ${origin}`);
		}

		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("Location");
			const target =
				location && URL.canParse(location, proofUrl) ? new URL(location, proofUrl) : null;
			return checkFailed(
				target
					? `${origin} redirects to ${target.origin}. Enter that address instead.`
					: `${origin} redirects elsewhere`,
			);
		}

		const body: unknown = response.ok ? await response.json().catch(() => null) : null;
		const received =
			body &&
			typeof body === "object" &&
			"data" in body &&
			body.data &&
			typeof body.data === "object"
				? (body.data as { token?: unknown }).token
				: undefined;
		if (received !== token) {
			return checkFailed(`${origin} does not serve this site yet`);
		}

		await setSiteSettings({ url: origin }, db);
		return { success: true, data: { url: origin } };
	} finally {
		await db
			.deleteFrom("options")
			.where("name", "=", PROOF_OPTION)
			.where("revision", "=", revision)
			.execute();
	}
}

/**
 * Return the pending domain proof token, if a check is in progress.
 */
export async function handleDomainProof(
	db: Kysely<Database>,
): Promise<ApiResult<{ token: string }>> {
	const proof = await new OptionsRepository(db).get<DomainProof>(PROOF_OPTION);
	if (!proof || typeof proof.token !== "string" || proof.expiresAt < Date.now()) {
		return { success: false, error: { code: "NOT_FOUND", message: "No domain check in progress" } };
	}
	return { success: true, data: { token: proof.token } };
}
