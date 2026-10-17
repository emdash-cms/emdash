// Optional settings for local model evaluation. Production sets none of them.
interface ReviewEvalEnv {
	REVIEW_MODEL?: string;
	REVIEW_EVAL?: string;
	AI_GATEWAY_ACCOUNT_ID?: string;
	AI_GATEWAY_NAME?: string;
	AI_GATEWAY_TOKEN?: string;
}
declare namespace Cloudflare {
	interface Env extends ReviewEvalEnv {}
}
interface Env extends ReviewEvalEnv {}
