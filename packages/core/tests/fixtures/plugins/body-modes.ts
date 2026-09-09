import { z } from "zod";

export default {
	routes: {
		text: {
			body: "text",
			input: z.string().regex(/^\d+$/).transform(Number),
			handler: async ({ input }: { input: number }) => input + 1,
		},
		bytes: {
			body: "bytes",
			input: z
				.instanceof(Uint8Array)
				.refine((value) => value.length > 0)
				.transform((value) => value.length),
			handler: async ({ input }: { input: number }) => input + 1,
		},
		json: {
			input: z.object({ amount: z.number().int().positive() }),
			handler: async ({ input }: { input: { amount: number } }) => input.amount + 1,
		},
		echo: async ({ input }: { input: unknown }) => input,
	},
};
