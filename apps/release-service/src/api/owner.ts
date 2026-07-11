import type { AuthenticatedActor } from "./auth.js";
import { ApiError } from "./errors.js";

export function requireOwner(actor: AuthenticatedActor, ownerDid: string): AuthenticatedActor {
	if (actor.subjectDid !== ownerDid) {
		throw new ApiError("FORBIDDEN", 403, "Not authorized for this resource");
	}
	return actor;
}

export function requireOwnerOr(
	actor: AuthenticatedActor,
	ownerDid: string,
	isAuthorized: (actor: AuthenticatedActor) => boolean,
): AuthenticatedActor {
	if (actor.subjectDid !== ownerDid && !isAuthorized(actor)) {
		throw new ApiError("FORBIDDEN", 403, "Not authorized for this resource");
	}
	return actor;
}
