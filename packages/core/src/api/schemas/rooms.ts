import { z } from "zod";

export const roomJoinBody = z
	.object({
		fingerprint: z.object({ version: z.string(), commit: z.string(), hash: z.string() }).meta({
			description:
				"The `version` and `commit` the client's admin was built with, and the manifest `hash` its editor was built from",
		}),
		singleEditor: z.boolean().optional().meta({
			description:
				"Join in single-editor mode, for a client whose WebSockets can't open. The room forgets the caller's unused tokens.",
		}),
		takeover: z.boolean().optional().meta({
			description:
				"Delete another user's edit lock on the entry and join. Needs edit access to the entry.",
		}),
	})
	.meta({ id: "RoomJoinBody" });

export const recoveryRevisionBody = z
	.object({
		data: z.record(z.string(), z.unknown()),
		slug: z.string().nullable(),
	})
	.meta({ id: "RecoveryRevisionBody" });

export type RoomJoinBody = z.infer<typeof roomJoinBody>;
