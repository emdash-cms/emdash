export default {
	hooks: {
		"content:afterSave": async (event, ctx) => {
			const data = new Uint8Array(1024);
			for (let i = 0; i < 100000; i++) {
				const hash = await crypto.subtle.digest("SHA-256", data);
				data.set(new Uint8Array(hash));
			}
			await ctx.storage.index.put(event.content.id, {
				hash: Array.from(data, (b) => b.toString(16)).join(""),
			});
		},
	},
};
