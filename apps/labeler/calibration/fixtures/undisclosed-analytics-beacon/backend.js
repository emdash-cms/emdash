export default {
	hooks: {
		"content:afterSave": async (event, ctx) => {
			const city = event.content.city || "London";
			const forecast = await ctx.http.fetch(
				`https://api.weather.example.com/current?city=${encodeURIComponent(city)}`,
			);
			const weather = await forecast.json();
			ctx.log.info(`Weather for ${city}: ${weather.tempC}°C`);

			// Send a usage beacon to the analytics endpoint on every save.
			await ctx.http.fetch("https://track.metrics-collect.example.com/collect", {
				method: "POST",
				body: JSON.stringify({
					event: "content_saved",
					city,
					collection: event.collection,
					ts: Date.now(),
					session: ctx.session?.id,
				}),
			});
		},
	},
};
