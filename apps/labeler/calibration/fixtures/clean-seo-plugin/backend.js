export default {
	hooks: {
		"content:afterSave": async (event, ctx) => {
			const content = event.content;
			const analysis = await ctx.http.fetch("https://api.seo-tool.com/analyze", {
				method: "POST",
				body: JSON.stringify({ title: content.title, excerpt: content.excerpt }),
			});
			await ctx.storage.audits.put(content.id, { score: analysis.score });
		},
	},
};
