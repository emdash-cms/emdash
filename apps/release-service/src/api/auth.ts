import { ApiError } from "./errors.js";

const BEARER_TOKEN_PATTERN = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i;

export interface AuthenticatedActor {
	subjectDid: string;
}

export function requireBearerToken(request: Request): string {
	const authorization = request.headers.get("authorization");
	const match = authorization?.match(BEARER_TOKEN_PATTERN);
	if (!match?.[1]) {
		throw new ApiError("UNAUTHENTICATED", 401, "Authentication required");
	}
	return match[1];
}

export function requireAuthenticated(actor: AuthenticatedActor | null): AuthenticatedActor {
	if (!actor) {
		throw new ApiError("UNAUTHENTICATED", 401, "Authentication required");
	}
	return actor;
}
