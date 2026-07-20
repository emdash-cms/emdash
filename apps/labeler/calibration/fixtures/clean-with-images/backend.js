export default {
	hooks: {
		"content:afterSave": async (event, ctx) => {
			const images = event.content.images ?? [];
			await ctx.storage.gallery.put(event.content.id, {
				count: images.length,
				updatedAt: new Date().toISOString(),
			});
		},
	},
};
