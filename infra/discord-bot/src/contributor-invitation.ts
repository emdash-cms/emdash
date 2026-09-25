import { DurableObject } from "cloudflare:workers";

import { postPullRequestComment } from "./github.js";

interface InviteInput {
	githubId: number;
	githubLogin: string;
	prNumber: number;
}

interface InvitationRecord extends InviteInput {
	invitedAt: string;
}

type InviteResult = { invited: true } | { invited: false; record?: InvitationRecord };

const INVITATION_KEY = "invitation";

export class ContributorInvitation extends DurableObject<Env> {
	async invite(input: InviteInput): Promise<InviteResult> {
		const linked = await this.env.KV.get(`github:${input.githubId}`);
		if (linked) return { invited: false };

		const record: InvitationRecord = {
			...input,
			invitedAt: new Date().toISOString(),
		};
		const existing = await this.ctx.storage.transaction(async (transaction) => {
			const stored = await transaction.get<InvitationRecord>(INVITATION_KEY);
			if (stored) return stored;
			await transaction.put(INVITATION_KEY, record);
			return null;
		});

		if (existing) return { invited: false, record: existing };

		try {
			await postPullRequestComment(
				this.env,
				input.prNumber,
				contributorInvitationComment(this.env.DISCORD_INVITE_URL),
			);
		} catch (error) {
			await this.ctx.storage.delete(INVITATION_KEY);
			throw error;
		}

		return { invited: true };
	}
}

function contributorInvitationComment(discordInviteUrl: string): string {
	return (
		"Thanks for contributing to EmDash! 🎉\n\n" +
		`Join the [EmDash Discord](${discordInviteUrl}), then run \`/link\` to connect your ` +
		"GitHub account and claim the **Contributor** role."
	);
}
