/**
 * Read counterpart of `guardMutation` (plan W9.3). Every `/admin/api/*` read
 * runs the same defense-in-depth chain as a mutation, minus the body/idempotency
 * machinery a GET has no use for: same-origin + CSRF-header transport checks
 * (reusing the mutation guard's asserts so the CSRF/origin semantics have one
 * source of truth), a fresh `verifyAccessRequest`, then a reviewer-role gate
 * (admin satisfies it by inheritance — spec §19.2/§12). Returns the verified
 * identity or throws a guard error the dispatcher renders via `toResponse`.
 *
 * Transport/auth rejections reuse `MutationGuardError` (`CROSS_ORIGIN`,
 * `CSRF_HEADER_MISSING`, `UNAUTHENTICATED`, `FORBIDDEN_ROLE`); the read-only
 * codes (`NOT_FOUND`, `INVALID_REQUEST`, `INVALID_CURSOR`, `METHOD_NOT_ALLOWED`)
 * live on `ReadGuardError`, which shares `MutationGuardError`'s wire shape.
 */

import {
	AccessAuthError,
	hasRole,
	verifyAccessRequest,
	type AccessAuthConfig,
	type AccessKeyResolver,
	type OperatorIdentity,
	type OperatorRole,
} from "./access-auth.js";
import { assertCsrfHeader, assertSameOrigin, MutationGuardError } from "./mutation-guard.js";

export type ReadGuardCode =
	| "NOT_FOUND"
	| "INVALID_REQUEST"
	| "INVALID_CURSOR"
	| "METHOD_NOT_ALLOWED";

const READ_GUARD_ERROR: Readonly<Record<ReadGuardCode, { status: number; message: string }>> = {
	NOT_FOUND: { status: 404, message: "Resource not found" },
	INVALID_REQUEST: { status: 400, message: "Request parameters are invalid" },
	INVALID_CURSOR: { status: 400, message: "Cursor is invalid or does not match the request" },
	METHOD_NOT_ALLOWED: { status: 405, message: "Method not allowed" },
};

/**
 * Read-side guard rejection. Messages are static per code — they never echo the
 * request, so `toResponse` cannot leak caller-supplied content. Same wire shape
 * as `MutationGuardError` / core's `apiError`.
 */
export class ReadGuardError extends Error {
	override readonly name = "ReadGuardError";
	readonly code: ReadGuardCode;
	readonly status: number;

	constructor(code: ReadGuardCode) {
		const { status, message } = READ_GUARD_ERROR[code];
		super(message);
		this.code = code;
		this.status = status;
	}

	toResponse(): Response {
		return Response.json(
			{ error: { code: this.code, message: this.message } },
			{ status: this.status },
		);
	}
}

export interface ReadGuardDeps {
	config: AccessAuthConfig;
	keys: AccessKeyResolver;
	/** Defaults to the request URL's origin; override for proxy edge cases. */
	expectedOrigin?: string;
}

export async function guardRead(
	request: Request,
	deps: ReadGuardDeps,
	options: { minRole: OperatorRole },
): Promise<OperatorIdentity> {
	assertSameOrigin(request, deps.expectedOrigin ?? new URL(request.url).origin);
	assertCsrfHeader(request);

	let identity: OperatorIdentity;
	try {
		identity = await verifyAccessRequest(request, deps.config, deps.keys);
	} catch (error) {
		if (error instanceof AccessAuthError) throw new MutationGuardError("UNAUTHENTICATED");
		throw error;
	}

	if (!hasRole(identity, options.minRole)) throw new MutationGuardError("FORBIDDEN_ROLE");
	return identity;
}
