// How a blocks field draws text and controls, in one place, so a block, a list item and the
// fields inside them use the same sizes and line up on the same edges whether open or closed.

// A row's name keeps its size and weight whether the row is open or closed. A block's name heads
// everything inside it, so it reads a weight above its items' names and its fields' labels.
/** A block's name. */
export const BLOCK_TITLE = "text-base font-semibold text-kumo-default";

/** A list item's name. */
export const ITEM_TITLE = "text-base font-medium text-kumo-default";

/** A closed row's one-line summary, after its name. */
export const ROW_SUMMARY = "text-base text-kumo-subtle";

/**
 * The summary takes only the width the row's name leaves, so the name truncates last, and it hides
 * rather than show a stub too narrow to read. `SUMMARY_TEXT` goes on the summary's text inside it.
 */
export const SUMMARY_SLOT = "@container/summary min-w-0 flex-1 basis-0 overflow-hidden";
export const SUMMARY_TEXT = "inline-block max-w-full truncate align-top @max-[6rem]/summary:hidden";

/** A field's label above its control, and a settings row's when the row stacks. */
export const LABEL = "text-xs leading-4 font-medium text-kumo-subtle";

/**
 * The space between stacked fields. An open block's gaps grow with the level they separate, so
 * the levels read at a glance.
 */
export const FIELD_GAP = { block: "gap-y-4", item: "gap-y-3" } as const;

/**
 * A note on a field's label line: a list's item count, a field's count while it has focus, and its
 * problem once that shows. The line is there whether a note shows or not, so a note moves
 * nothing and covers nothing.
 */
export const NOTE = "text-xs leading-4";

/** A note shown while its field has focus fades in. Out of focus it isn't drawn, so it goes at once. */
export const NOTE_ON_FOCUS =
	"transition-opacity duration-150 ease-emdash starting:opacity-0 motion-reduce:transition-none";

/**
 * A caret or type icon before a row's 14px text. A glyph centered on the line reads high next to
 * the text's capitals, so it sits 1px lower.
 */
export const GLYPH_NUDGE = "translate-y-px";

// A `dir="auto"` value aligns to the start of its own text. Quiet values line up with their labels
// instead, so a value whose direction differs from its container's aligns to its own end.
// An invalid control is drawn like any other. Its problem shows on its label's line, or, for a
// control with no label line, as its red placeholder when that says the problem. Kumo's
// placeholder color is unlayered, so only an important utility recolors it.
const QUIET_CONTROL =
	"w-full rounded-md bg-transparent px-2 shadow-none ring-transparent [:dir(ltr)>&:dir(rtl)]:text-end [:dir(rtl)>&:dir(ltr)]:text-end enabled:hover:bg-emdash-hover focus:bg-kumo-control focus:ring-1 focus:ring-kumo-focus/50 data-empty-issue:placeholder:text-kumo-danger!";

/** A one-line control with no box until it's hovered or focused. Its text sits on the field's text edge. */
export const QUIET_INPUT = `${QUIET_CONTROL} h-8 text-ellipsis`;

/**
 * A text area that grows with its text, drawn like a quiet input. An inline text area would sit
 * on its line's baseline and leave a gap under it.
 */
export const QUIET_TEXTAREA = `${QUIET_CONTROL} block min-h-8 resize-none overflow-hidden py-1.5`;

// The editor's field column sets input text to text-base and font-normal, which only `!` outranks.
/**
 * The block's headline: the one larger size inside a block. It's content, not structure, so it
 * stays a weight under the block's name.
 */
export const QUIET_HEADING = "h-9 text-lg! leading-6 font-medium!";

// Its chevron follows the value, and like the date's calendar shows only when the control is reached for.
// Kumo's hover tint carries a `not-disabled:` variant, which only the same variant replaces.
// On a coarse pointer it reaches 44px tall, except where its row sits beside its label, 2px from
// the next row, which it reaches only halfway to.
export const QUIET_SELECT =
	"h-8 w-full justify-start gap-1.5 rounded-md bg-transparent px-2 font-normal shadow-none ring-transparent not-disabled:hover:bg-emdash-hover focus-visible:bg-kumo-control focus-visible:ring-1 focus-visible:ring-kumo-focus/50 data-[popup-open]:bg-emdash-hover data-[popup-open]:ring-0 [&>span:last-child]:opacity-0 hover:[&>span:last-child]:opacity-100 focus-visible:[&>span:last-child]:opacity-100 data-[popup-open]:[&>span:last-child]:opacity-100 pointer-coarse:[&>span:last-child]:opacity-100 relative pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-1.5 pointer-coarse:@min-[440px]/blocks:after:-inset-y-px";

/**
 * An option in a quiet select's popup: as tall as the trigger, or taller for a label that wraps,
 * highlighted with the hover wash instead of a ring. `emdash-block-option` lets styles.css size
 * the popup, which takes no class.
 */
export const QUIET_OPTION =
	"emdash-block-option min-h-8 py-[5.5px] focus-visible:ring-0 data-highlighted:bg-emdash-hover";

/** Options are inset 6px in their popup, so it starts that far before the trigger to line their text up with its value. */
export const QUIET_SELECT_ALIGN_OFFSET = -6;

export const QUIET_DATE = `${QUIET_INPUT} [&::-webkit-calendar-picker-indicator]:opacity-0 hover:[&::-webkit-calendar-picker-indicator]:opacity-100 focus:[&::-webkit-calendar-picker-indicator]:opacity-100 pointer-coarse:[&::-webkit-calendar-picker-indicator]:opacity-100`;

/**
 * A photo's edge: a faint line inside the image, which reads as the photo's own edge rather than
 * a frame around it.
 */
export const IMAGE_EDGE =
	"outline outline-1 -outline-offset-1 outline-[color:light-dark(oklch(0%_0_0/0.1),oklch(100%_0_0/0.1))]";

/** A row's hover wash, painted over its background so a pinned header or a lifted row stays opaque. */
export const ROW_HOVER =
	"hover:bg-[image:linear-gradient(var(--color-emdash-hover),var(--color-emdash-hover))]";

/**
 * A row's head while its toggle has keyboard focus: washed, with a faint inset ring. A block's
 * toggle is `[data-block-toggle]`, a list item's `[data-item-focus]`.
 */
export const HEAD_FOCUS =
	"has-[:is([data-block-toggle],[data-item-focus]):focus-visible]:bg-[image:linear-gradient(var(--color-emdash-hover),var(--color-emdash-hover))] has-[:is([data-block-toggle],[data-item-focus]):focus-visible]:ring-1 has-[:is([data-block-toggle],[data-item-focus]):focus-visible]:ring-kumo-focus/50 has-[:is([data-block-toggle],[data-item-focus]):focus-visible]:ring-inset";

/** Pressing a row's toggle deepens its head's wash at once, before the click commits. */
export const HEAD_PRESSED =
	"has-[:is([data-block-toggle],[data-item-focus]):active]:bg-[image:linear-gradient(var(--color-emdash-hover),var(--color-emdash-hover)),linear-gradient(var(--color-emdash-hover),var(--color-emdash-hover))]";

/**
 * The curve of everything that moves rows: a panel opening or closing, a row added, removed or
 * moved. It starts gently enough that no frame carries the rows below more than about a quarter
 * of the way. `--ease-emdash-disclosure` in styles.css is the same curve.
 */
export const DISCLOSURE_CURVE = [0.33, 1, 0.68, 1] as const;
export const DISCLOSURE_EASE = `cubic-bezier(${DISCLOSURE_CURVE.join(", ")})`;
/** How long a row or panel takes to grow open and to shrink closed. */
export const DISCLOSURE_MS = { open: 200, close: 160 } as const;

/** The curve of everything else that moves or fades. `--ease-emdash` in styles.css is the same curve. */
export const EASE_EMDASH = "cubic-bezier(0.22, 1, 0.36, 1)";

/** A block or list item being dragged, or settling into its slot after the drop, lifts off the list. */
export const DRAGGING = "relative z-30 rounded-md bg-kumo-base";

/**
 * A row's lifted shadow, drawn by a layer of its own so it can fade in on pickup and out as the
 * dropped row settles. `LIFTED` shows it.
 */
export const LIFT_SHADOW =
	"after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:shadow-lg after:ring after:ring-kumo-line after:opacity-0 after:transition-opacity after:duration-150 after:ease-emdash motion-reduce:after:transition-none";
export const LIFTED = "after:opacity-100";

/** How the rows a dragged row passes move aside: the same ease-out as the panels. */
export const SORT_TRANSITION = { duration: 200, easing: DISCLOSURE_EASE };

/**
 * A menu, picker or select popup opens from its first frame and closes at once, since the choice
 * made is the feedback.
 */
export const POPUP_MOTION =
	"origin-(--transform-origin) duration-0 data-open:animate-emdash-popup-in motion-reduce:data-open:animate-none";

/** A block's 26px menu button takes a 44px square on a coarse pointer, at the same size. */
export const TOUCH_TARGET =
	"relative pointer-coarse:after:absolute pointer-coarse:after:-inset-[9px]";

/** A 26px-tall button that reaches 44px tall on a coarse pointer, at the same size. */
export const TOUCH_HEIGHT =
	"relative pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-[9px]";

/** A menu's items are 44px tall on a coarse pointer. */
export const MENU_TOUCH = "pointer-coarse:[&_[role=menuitem]]:min-h-11";

/** A list row's menu button: 44px wide on a coarse pointer, and no taller than the shortest row. */
export const ROW_TOUCH_TARGET =
	"relative pointer-coarse:after:absolute pointer-coarse:after:-inset-x-[9px] pointer-coarse:after:-inset-y-[3px]";

/**
 * A ghost button in a blocks field row, washed while hovered or while the menu it opened is open.
 * Kumo's ghost buttons inherit their parent's background, which would paint a row's translucent
 * hover twice.
 */
export const ROW_BUTTON = "bg-transparent hover:bg-emdash-hover aria-expanded:bg-emdash-hover";
