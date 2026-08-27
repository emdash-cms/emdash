export { EmDashPreviewDB } from "../../src/db/playground.js";

export default {
	fetch() {
		return new Response("Not found", { status: 404 });
	},
};
