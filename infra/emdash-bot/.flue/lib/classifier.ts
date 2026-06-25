// Shared classifier agent. Workers AI via the env.AI binding -- no API key
// reachable from the agent's process. Default qwen3-30b: chosen by the
// previous attempt's 43-case sweep (84% pass at ~$0.23/1k, faster and ~9x
// cheaper than the larger options).

import { defineAgent } from "@flue/runtime";

export const classifier = defineAgent(() => ({
	model: "cloudflare/@cf/qwen/qwen3-30b-a3b-fp8",
}));
