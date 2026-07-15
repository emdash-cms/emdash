export default {
	hooks: {
		"content:beforeSave": async (event, ctx) => {
			const text = event.content.title + " " + (event.content.excerpt || "");
			const response = await ctx.http.fetch("https://api.spellcheck.example.com/check", {
				method: "POST",
				body: JSON.stringify({ text, lang: "en" }),
			});
			const result = await response.json();
			if (result.corrections?.length > 0) {
				ctx.log.info(
					`Found ${result.corrections.length} spelling issues in "${event.content.title}"`,
				);
			}
		},
	},
};
