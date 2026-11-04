import type { CompactionConfig } from "@flue/runtime";

export const REVIEW_MODEL_CONTEXT_TOKENS = 262_144;
export const REVIEW_COMPACTION_RESERVE_TOKENS = 131_072;
export const REVIEW_COMPACTION_TRIGGER_TOKENS =
	REVIEW_MODEL_CONTEXT_TOKENS - REVIEW_COMPACTION_RESERVE_TOKENS;

export const REVIEW_COMPACTION = {
	reserveTokens: REVIEW_COMPACTION_RESERVE_TOKENS,
	keepRecentTokens: 8_000,
} satisfies CompactionConfig;
