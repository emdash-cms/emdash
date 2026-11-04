import type { CanonicalReleaseModerationInput } from "@emdash-cms/registry-moderation";

import type { CanonicalAssessmentInput } from "./canonical.js";
import type { AssessmentVersionSet } from "./types.js";

export async function createModerationFingerprint(
	canonical: CanonicalAssessmentInput,
	versions: AssessmentVersionSet,
): Promise<string> {
	const input =
		canonical.kind === "profile" ? canonical.input : withoutContentReferences(canonical.input);
	const encoded = stableJson({
		schemaVersion: 1,
		input,
		policyVersion: versions.policyVersion,
		parserVersion: versions.parserVersion,
		textModelId: versions.textModelId,
		textPromptHash: versions.textPromptHash,
		imageModelId: versions.imageModelId,
		imagePromptHash: versions.imagePromptHash,
	});
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded)),
	);
	return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function withoutContentReferences(
	input: CanonicalReleaseModerationInput,
): CanonicalReleaseModerationInput {
	return {
		...input,
		media: input.media.map((descriptor) => ({
			...descriptor,
			verified: descriptor.verified
				? {
						...descriptor.verified,
						contentRef: "verified-content",
					}
				: undefined,
		})),
	};
}

function stableJson(value: unknown): string {
	return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, entry]) => entry !== undefined)
			.toSorted(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, sortValue(entry)]),
	);
}
