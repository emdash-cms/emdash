// Optional review model settings. Production sets the AI_GATEWAY_* secrets to
// review with the gateway models; REVIEW_EVAL and REVIEW_MODEL are for local
// evaluation only.
interface ReviewEvalEnv {
	REVIEW_MODEL?: string;
	REVIEW_EVAL?: string;
	REVIEW_MODELS?: string;
	REVIEW_MERGE_MODEL?: string;
	REVIEW_FOLLOWUP_MODELS?: string;
	REVIEW_FOLLOWUP_MAX_LINES?: string;
	REVIEW_MAX_SUGGESTIONS?: string;
	REVIEW_AUTO_REREVIEW_LIMIT?: string;
	AI_GATEWAY_ACCOUNT_ID?: string;
	AI_GATEWAY_NAME?: string;
	AI_GATEWAY_TOKEN?: string;
}
declare namespace Cloudflare {
	interface Env extends ReviewEvalEnv {}
}
interface Env extends ReviewEvalEnv {}
