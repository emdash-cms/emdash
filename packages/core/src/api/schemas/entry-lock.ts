import { z } from "zod";

export const entryLockAcquireBody = z
	.object({
		takeover: z.boolean().optional().meta({
			description:
				"Take the lock from whoever holds it. Their next heartbeat or save reports the new holder.",
		}),
		token: z.string().min(1).max(128).optional().meta({
			description:
				"Identifies the caller's editing session. Send the same value on DELETE so a release from one tab does not drop a lock another tab of the same account still relies on.",
		}),
	})
	.meta({ id: "EntryLockAcquireBody" });

export const entryLockHolderSchema = z
	.object({
		userId: z.string(),
		userName: z.string().nullable(),
		acquiredAt: z.string(),
		expiresAt: z.string(),
	})
	.meta({ id: "EntryLockHolder" });

export const entryLockStatusSchema = z
	.object({
		enabled: z.boolean().meta({
			description: "Whether the collection takes edit locks at all",
		}),
		holder: entryLockHolderSchema.nullable(),
		heldByCaller: z.boolean(),
	})
	.meta({ id: "EntryLockStatus" });

export const entryLockReleaseResponseSchema = z
	.object({ released: z.boolean() })
	.meta({ id: "EntryLockReleaseResponse" });

export const entryLockConflictSchema = z.object({
	success: z.literal(false),
	error: z.object({
		code: z.literal("ENTRY_LOCKED"),
		message: z.string(),
		details: entryLockHolderSchema,
	}),
});

export type EntryLockAcquireBody = z.infer<typeof entryLockAcquireBody>;
