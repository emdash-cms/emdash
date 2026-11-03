/** Inner markup for 24×24 line icons drawn with `stroke: currentColor`. */
export const heroIcons = {
	search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
	fileText:
		'<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
	globe:
		'<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c-2.3 2.4-3.4 5.2-3.4 8.5s1.1 6.1 3.4 8.5c2.3-2.4 3.4-5.2 3.4-8.5S14.3 5.9 12 3.5Z"/>',
	lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
	shieldCheck:
		'<path d="M12 3.5 19 6v5.5c0 4.3-2.9 7.6-7 9-4.1-1.4-7-4.7-7-9V6Z"/><path d="m9 12 2.2 2.2L15.2 10"/>',
	checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.3 2.4 2.4 4.6-4.9"/>',
	cube: '<path d="M12 3.5 19.5 7.7v8.6L12 20.5l-7.5-4.2V7.7Z"/><path d="m4.8 7.9 7.2 4.1 7.2-4.1M12 12v8.3"/>',
} as const;
