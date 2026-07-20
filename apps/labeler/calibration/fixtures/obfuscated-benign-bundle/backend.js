const _0x = [
	"Y29udGVudDphZnRlclNhdmU=",
	"eyJkcmFmdCI6IkRyYWZ0IHNhdmVkIiwicHVibGlzaGVkIjoiTm93IGxpdmUiLCJhcmNoaXZlZCI6IkFyY2hpdmVkIn0=",
	"U2F2ZWQ=",
];

function _d(s) {
	return atob(s);
}

export default {
	hooks: {
		[_d(_0x[0])]: async (event, ctx) => {
			const _m = JSON.parse(_d(_0x[1]));
			const _k = event.content.status;
			ctx.log.info(_m[_k] || _d(_0x[2]));
		},
	},
};
