import type { AuthAdapter, User } from "./types.js";

/**
 * Mark `user`'s address verified when `provenEmail` is still that address.
 * A failed write is logged and the user is returned unverified, so it never
 * blocks the sign-in that proved the address.
 */
export async function markEmailVerified(
	adapter: AuthAdapter,
	user: User,
	provenEmail: string,
): Promise<User> {
	if (user.emailVerified || provenEmail.toLowerCase() !== user.email.toLowerCase()) {
		return user;
	}
	try {
		if (adapter.markEmailVerified) {
			if (!(await adapter.markEmailVerified(user.id, provenEmail))) return user;
		} else {
			await adapter.updateUser(user.id, { emailVerified: true });
		}
		return { ...user, emailVerified: true };
	} catch (error) {
		console.error("[auth] failed to mark email verified:", error);
		return user;
	}
}
