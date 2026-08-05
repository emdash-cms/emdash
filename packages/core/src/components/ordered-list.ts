import { OrderedList } from "@tiptap/extension-list";

export const EmDashOrderedList = OrderedList.extend({
	addAttributes() {
		return {
			...this.parent?.(),
			listId: {
				default: null,
				rendered: false,
			},
			listStart: {
				default: null,
				rendered: false,
			},
		};
	},
});
