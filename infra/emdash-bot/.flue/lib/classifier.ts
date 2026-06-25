// Shared classifier agent. Workers AI via the env.AI binding -- no API key
// reachable from the agent's process. Default qwen3-30b: chosen by the
// previous attempt's 43-case sweep (84% pass at ~$0.23/1k, faster and ~9x
// cheaper than the larger options). Override per run via FLUE_CLASSIFIER_MODEL.

import { defineAgent } from "@flue/runtime";

export const classifier = defineAgent(() => ({
	model: process.env.FLUE_CLASSIFIER_MODEL ?? "cloudflare/@cf/qwen/qwen3-30b-a3b-fp8",
}));
