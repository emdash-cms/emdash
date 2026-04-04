# Design System -- EmDash

## Product Context
- **What this is:** Full-stack TypeScript CMS built on Astro + Cloudflare. The WordPress alternative for developers.
- **Who it's for:** Developers migrating from WordPress who want modern tooling without losing the full-site experience.
- **Space/industry:** CMS (peers: Ghost, Payload, Strapi, WordPress)
- **Project type:** Web app (admin dashboard + content editor + visual editing)

## Aesthetic Direction
- **Direction:** Industrial-Editorial
- **Decoration level:** Minimal (typography and spacing do all the work)
- **Mood:** A creative writing tool that takes itself seriously. Dense when you need data (content lists, settings), spacious when you need focus (editor, preview). Not playful. Not corporate. Somewhere between a well-designed newspaper and a high-end developer tool.
- **Reference products:** Linear (keyboard-first speed), Ghost (writing focus), Notion (simplicity)

## Typography
- **Display/Hero:** Instrument Serif -- warm, editorial feel for post titles and headings. Says "we care about typography."
- **Body:** Geist -- clean, modern, excellent readability. MIT licensed, self-hosted.
- **UI/Labels:** Geist (same as body, keeps it clean)
- **Data/Tables:** Geist with `font-variant-numeric: tabular-nums`
- **Code:** Geist Mono
- **Loading:** Google Fonts for Instrument Serif, self-host Geist (MIT licensed, via CDN or local)
- **Scale:**
  - Display: 42px (Instrument Serif)
  - Heading: 20px / 600 weight
  - Editor Body: 17px / 1.8 line-height
  - Body: 16px / 1.6 line-height
  - UI: 14px
  - Small: 13px
  - Label: 11px / uppercase / 1.5px letter-spacing

## Color
- **Approach:** Restrained (color is rare and meaningful, it means "this needs your attention")
- **Primary/Accent:** `#E85D3A` (warm coral-orange, distinctive, not the usual CMS blue)
- **Accent hover:** `#D14E2E`
- **Background (light):** `#FAFAF9` (warm off-white, reduces eye fatigue for long writing sessions)
- **Background (dark):** `#1A1A1A` (true dark)
- **Surface (light):** `#FFFFFF`
- **Surface (dark):** `#242424`
- **Text (light):** `#1A1A1A`
- **Text (dark):** `#EDEDEC`
- **Text muted (light):** `#6B6B6B`
- **Text muted (dark):** `#8B8B8B`
- **Border (light):** `#E5E5E3`
- **Border (dark):** `#333333`
- **Semantic:** success `#2D8A4E`, warning `#D4A017`, error `#DC3545`, info `#4A90D9`
- **Dark mode:** First-class citizen. Reduce saturation 10-20% for semantic colors. CMS users work late.

## Spacing
- **Base unit:** 4px
- **Density:** Comfortable
- **Scale:** 2xs(2) xs(4) sm(8) md(16) lg(24) xl(32) 2xl(48) 3xl(64)
- **Content list rows:** 48px height (dense but readable)
- **Editor body:** 24px line-height (generous for long-form writing)
- **Sidebar items:** 36px height
- **Focus mode max-width:** 680px (centered)

## Layout
- **Approach:** Hybrid (grid-disciplined for admin, creative-editorial for editor)
- **Admin grid:** Sidebar (220px fixed) + Content area (fluid)
- **Breakpoints:** Desktop (1280px+), Tablet (768-1279px), Mobile (<768px)
- **Max content width:** 1200px for admin pages, 680px for editor focus mode
- **Border radius:** sm: 4px, md: 8px, lg: 12px, full: 9999px (badges/pills)

## Motion
- **Approach:** Minimal-functional (only transitions that aid comprehension)
- **Easing:** enter(ease-out) exit(ease-in) move(ease-in-out)
- **Duration:** micro(50-100ms) short(150ms) medium(200ms)
- **Specific:**
  - Focus mode toggle: 200ms ease-out
  - Command palette appear: 150ms scale-in
  - Content list selection: 0ms (keyboard-first = zero delay)
  - Page transitions: 100ms fade
  - Sidebar collapse: 200ms ease-in-out

## Component Patterns
- **Buttons:** Primary (coral accent, white text), Secondary (border, no fill), Ghost (text only)
- **Status badges:** Pill-shaped (border-radius: full). Published (green bg/text), Draft (gray), Scheduled (blue)
- **Inputs:** 1px border, 4px radius, accent focus ring (2px, 15% opacity)
- **Cards:** 1px border, 8px radius, white/surface background. No shadows, no decorative borders.
- **Dialogs:** Use existing ConfirmDialog and DialogError patterns. Center-aligned, 520px max width.
- **Command palette:** Center-aligned modal, 520px wide, sections with uppercase labels, keyboard shortcut hints right-aligned
- **Slash menu:** Left-aligned dropdown, 220px wide, icon + label per item, hover/active state

## Anti-Patterns (never do these)
- Purple/blue accent (every CMS does this)
- Decorative gradients or shadows on cards
- Icons in colored circles
- 3-column feature grids
- Generic "Welcome to EmDash" copy
- Centered everything
- Uniform border-radius on all elements
- Default font stacks (Inter, Roboto, Arial, system)

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-04 | Initial design system created | Created by /design-consultation. Industrial-editorial aesthetic targeting WordPress refugees. |
| 2026-04-04 | Warm coral accent #E85D3A | Differentiates from blue-default CMS space. Says "creative tool" not "enterprise." |
| 2026-04-04 | Instrument Serif for display | Editorial feel for post titles. CMS admins never use serifs, this is the differentiator. |
| 2026-04-04 | Warm off-white #FAFAF9 background | Reduces eye fatigue for long writing sessions. The "iA Writer trick." |
| 2026-04-04 | Geist for body/UI | Clean, modern, MIT licensed. Tabular nums for data. Not overused in CMS space. |
