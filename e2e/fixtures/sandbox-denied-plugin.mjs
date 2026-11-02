async function denialCode(operation) {
	try {
		await operation();
		return "GRANTED";
	} catch (error) {
		return typeof error === "object" && error !== null && "code" in error
			? String(error.code)
			: "UNAVAILABLE";
	}
}

async function authorityProbe(ctx) {
	return {
		content: await denialCode(() => ctx.content.list("posts", { limit: 1 })),
		media: await denialCode(() => ctx.media.list({ limit: 1 })),
		taxonomies: await denialCode(() => ctx.taxonomies.getAll()),
		comments: ctx.comments === undefined ? "UNAVAILABLE" : "GRANTED",
		redirects: ctx.redirects === undefined ? "UNAVAILABLE" : "GRANTED",
		schema: ctx.schema === undefined ? "UNAVAILABLE" : "GRANTED",
		users: ctx.users === undefined ? "UNAVAILABLE" : "GRANTED",
	};
}

const plugin = {
	routes: {
		admin: {
			permission: "plugins:manage",
			handler: async (_route, ctx) => {
				const authority = await authorityProbe(ctx);
				return {
					blocks: [
						{ type: "header", text: "Denied authority probe" },
						{
							type: "fields",
							fields: [
								{ label: "Content", value: authority.content },
								{ label: "Media", value: authority.media },
								{ label: "Taxonomies", value: authority.taxonomies },
							],
						},
					],
				};
			},
		},
		"authority-probe": {
			permission: "plugins:manage",
			handler: async (_route, ctx) => authorityProbe(ctx),
		},
	},
};

export default plugin;
