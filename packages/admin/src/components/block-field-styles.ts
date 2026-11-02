// How a blocks field draws text and controls, in one place, so a block, a list item and the
// fields inside them use the same sizes and line up on the same edges whether open or closed.

/** A block's or a list item's name, the same size and weight whether its row is open or closed. */
export const ROW_TITLE = "text-base font-medium text-kumo-default";

/** A closed row's one-line summary, after its name. */
export const ROW_SUMMARY = "text-base text-kumo-subtle";

/** A field's label, a list's, and the Advanced row. */
export const LABEL = "text-xs leading-4 font-medium text-kumo-subtle";

/**
 * A hint or count shown while a control has focus. It floats over the rows below, so focusing a
 * control moves nothing. Its parent is `relative` and names the group that shows it. It layers above
 * a rich text toolbar (z-20) and under the block's pinned header (z-30).
 */
export const FLOATING_NOTE =
	"pointer-events-none invisible absolute top-full z-[25] mt-1 max-w-full rounded-md bg-kumo-overlay px-2 py-1 text-xs leading-4 text-kumo-subtle opacity-0 shadow-sm ring ring-kumo-line transition-[opacity,translate,visibility] duration-150 ease-emdash -translate-y-0.5 motion-reduce:transition-none";

// A `dir="auto"` value aligns to the start of its own text. Quiet values line up with their labels
// instead, so a value whose direction differs from its container's aligns to its own end.
// Kumo's placeholder color is unlayered, so only an important utility recolors it.
const QUIET_CONTROL =
	"w-full rounded-md bg-transparent px-2 shadow-none ring-transparent [:dir(ltr)>&:dir(rtl)]:text-end [:dir(rtl)>&:dir(ltr)]:text-end enabled:hover:bg-emdash-hover focus:bg-kumo-control focus:ring-1 focus:ring-kumo-focus/50 aria-invalid:ring-kumo-danger aria-invalid:placeholder:text-kumo-danger! aria-invalid:focus:ring-kumo-danger";

/** A one-line control with no box until it's hovered or focused. Its text sits on the field's text edge. */
export const QUIET_INPUT = `${QUIET_CONTROL} h-8 text-ellipsis`;

/** A text area that grows with its text, drawn like a quiet input. */
export const QUIET_TEXTAREA = `${QUIET_CONTROL} min-h-8 resize-none overflow-hidden py-1.5`;

// The editor's field column sets input text to text-base and font-normal, which only `!` outranks.
/** The block's headline: the one larger size inside a block. */
export const QUIET_HEADING = "h-9 text-lg! leading-6 font-semibold!";

// Its chevron follows the value, and like the date's calendar shows only when the control is reached for.
export const QUIET_SELECT =
	"h-8 w-full justify-start gap-1.5 rounded-md bg-transparent px-2 font-normal shadow-none ring-transparent hover:bg-emdash-hover focus-visible:bg-kumo-control focus-visible:ring-1 focus-visible:ring-kumo-focus/50 data-[popup-open]:bg-kumo-control data-[popup-open]:ring-1 data-[popup-open]:ring-kumo-focus/50 [&>span:last-child]:opacity-0 hover:[&>span:last-child]:opacity-100 focus-visible:[&>span:last-child]:opacity-100 data-[popup-open]:[&>span:last-child]:opacity-100 pointer-coarse:[&>span:last-child]:opacity-100";

export const QUIET_DATE = `${QUIET_INPUT} [&::-webkit-calendar-picker-indicator]:opacity-0 hover:[&::-webkit-calendar-picker-indicator]:opacity-100 focus:[&::-webkit-calendar-picker-indicator]:opacity-100 pointer-coarse:[&::-webkit-calendar-picker-indicator]:opacity-100`;

/** A row's hover wash, painted over its background so a pinned header or a lifted row stays opaque. */
export const ROW_HOVER =
	"hover:bg-[image:linear-gradient(var(--color-emdash-hover),var(--color-emdash-hover))]";

/** A block or list item being dragged lifts off the list. */
export const DRAGGING = "relative z-30 rounded-md bg-kumo-base shadow-lg ring ring-kumo-line";

/** How the rows a dragged row passes move aside: the same ease-out as the panels. */
export const SORT_TRANSITION = { duration: 200, easing: "cubic-bezier(0.22, 1, 0.36, 1)" };

/**
 * A ghost button in a blocks field row. Kumo's ghost buttons inherit their parent's background,
 * which would paint a row's translucent hover twice.
 */
export const ROW_BUTTON = "bg-transparent hover:bg-emdash-hover";
