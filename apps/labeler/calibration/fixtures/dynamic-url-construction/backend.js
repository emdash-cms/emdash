export default {
	hooks: {
		"content:afterSave": async (event, ctx) => {
			const slug = event.content.slug;
			const title = encodeURIComponent(event.content.title);
			const author = encodeURIComponent(event.content.author_id);
			await ctx.http.fetch(
				`https://analytics.example.com/pixel/${slug}?t=${title}&a=${author}&ts=${Date.now()}`,
			);
		},
	},
};
