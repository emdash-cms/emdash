import type { CapabilityGroup } from "../../lib/capabilities.js";

/** Inner markup for 24×24 line icons drawn with `stroke: currentColor`. */
export const detailIcons = {
	fileText:
		'<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
	chat: '<path d="M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H11l-4 3.5v-3.5h-.5a2 2 0 0 1-2-2Z"/><path d="M8.5 9.5h7M8.5 12.5h4"/>',
	stack: '<path d="m12 4 8 4-8 4-8-4Z"/><path d="m4 12 8 4 8-4"/><path d="m4 16 8 4 8-4"/>',
	tag: '<path d="M4 12.2V5a1 1 0 0 1 1-1h7.2a1 1 0 0 1 .7.3l7 7a1.5 1.5 0 0 1 0 2.1l-6.4 6.4a1.5 1.5 0 0 1-2.1 0l-7-7a1 1 0 0 1-.4-.6Z"/><circle cx="8.5" cy="8.5" r="1.25"/>',
	idCard:
		'<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M5.8 15.5a3.5 3.5 0 0 1 6.4 0"/><path d="M14.5 10h3M14.5 13.5h3"/>',
	signpost:
		'<path d="M12 3v18"/><path d="M5 6h11l3 2.5-3 2.5H5Z"/><path d="M19 13.5H8l-3 2.5 3 2.5h11Z"/>',
	image:
		'<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="9.5" r="1.5"/><path d="m20.5 15-4.5-4.5L6 19.5"/>',
	globe:
		'<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c-2.3 2.4-3.4 5.2-3.4 8.5s1.1 6.1 3.4 8.5c2.3-2.4 3.4-5.2 3.4-8.5S14.3 5.9 12 3.5Z"/>',
	envelope: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m4 7 8 6 8-6"/>',
	code: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="m9.5 10-2.5 2.5L9.5 15M14.5 10l2.5 2.5-2.5 2.5"/>',
	users:
		'<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M15 5.8a3 3 0 0 1 0 5.4M17 14.2a5.5 5.5 0 0 1 3.5 4.8"/>',
	puzzle:
		'<path d="M5 7.5h3.2a2 2 0 1 1 3.6 0H15v3.3a2 2 0 1 1 0 3.4V18.5H11.8a2 2 0 1 0-3.6 0H5v-3.3a2 2 0 1 0 0-3.4Z"/>',
	check: '<path d="m5.5 12.5 4 4 9-9"/>',
	shieldCheck:
		'<path d="M12 3.5 19 6v5.5c0 4.3-2.9 7.6-7 9-4.1-1.4-7-4.7-7-9V6Z"/><path d="m9 12 2.2 2.2L15.2 10"/>',
	close: '<path d="m6 6 12 12M18 6 6 18"/>',
	chevronStart: '<path d="m14.5 6-6 6 6 6"/>',
	chevronEnd: '<path d="m9.5 6 6 6-6 6"/>',
	expand: '<path d="M14 4.5h5.5V10M10 19.5H4.5V14M19.5 4.5 13.5 10.5M4.5 19.5l6-6"/>',
	arrowUpRight: '<path d="M7.5 16.5 16.5 7.5M9 7.5h7.5V15"/>',
} as const;

export const capabilityIcons: Readonly<Record<CapabilityGroup, string>> = {
	content: detailIcons.fileText,
	comments: detailIcons.chat,
	schema: detailIcons.stack,
	taxonomies: detailIcons.tag,
	bylines: detailIcons.idCard,
	redirects: detailIcons.signpost,
	media: detailIcons.image,
	network: detailIcons.globe,
	email: detailIcons.envelope,
	page: detailIcons.code,
	users: detailIcons.users,
	other: detailIcons.puzzle,
};
