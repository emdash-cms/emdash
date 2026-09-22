import type { SandboxedPlugin } from "emdash/plugin";
import { z } from "zod";

const echoInput = z.object({
	message: z.string().min(1).max(200),
});

const echoOutput = z.object({
	message: z.string(),
	length: z.number().int().nonnegative(),
});

export default {
	routes: {
		echo: {
			permission: "content:read",
			input: echoInput,
			handler: async (routeCtx) => {
				const { message } = echoInput.parse(routeCtx.input);
				return { message, length: message.length };
			},
		},
	},
	mcp: {
		tools: {
			echo: {
				description: "Echo a short message to verify plugin MCP connectivity.",
				route: "echo",
				input: echoInput,
				output: echoOutput,
				destructive: false,
			},
		},
	},
} satisfies SandboxedPlugin;
