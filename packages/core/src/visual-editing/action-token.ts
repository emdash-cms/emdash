import { generatePreviewToken, verifyPreviewToken } from "../preview/tokens.js";

const VISUAL_ACTION_SECRET_DOMAIN = "emdash:visual-editing-action:v1:";
export const VISUAL_ACTION_TOKEN_INVALID = "VISUAL_ACTION_TOKEN_INVALID";

function visualActionSecret(previewSecret: string): string {
	return `${VISUAL_ACTION_SECRET_DOMAIN}${previewSecret}`;
}

export function generateVisualEditingActionToken(
	previewSecret: string,
	userId: string,
): Promise<string> {
	return generatePreviewToken({
		contentId: `visual-editing:${userId}`,
		expiresIn: "5m",
		secret: visualActionSecret(previewSecret),
	});
}

export async function verifyVisualEditingActionToken(
	token: string,
	previewSecret: string,
	userId: string,
): Promise<boolean> {
	const verification = await verifyPreviewToken({
		token,
		secret: visualActionSecret(previewSecret),
	});
	return verification.valid && verification.payload.cid === `visual-editing:${userId}`;
}
