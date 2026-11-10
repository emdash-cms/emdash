---
title: Generated user avatars
type: feature-plan
status: proposed
authors:
  - Noah Pham (@khoinguyenpham04)
discussion: null
created: 2026-11-04
---

# Generated user avatars

## Problem and user case

EmDash users have no way to set a profile picture. A user gets one only when a GitHub or Google sign-in creates their account, through self-signup or an invite, which copies the provider's picture into `users.avatar_url`. Linking GitHub or Google to an existing account sets nothing. Accounts created through a passkey, a magic link, Microsoft, atproto or Cloudflare Access have none.

Without a picture, the admin shows the first letter of the user's name, or of their email when they have no name, on a flat tint. Three places draw this separately: the header's user menu button at 20 px, the **Users** list at 32 px, and the user detail panel at 64 px. The header uses a brand tint and the other two a neutral one, but within each place every user looks the same, so people are hard to tell apart at a glance. Real-time co-editing will show several people's avatars side by side ([Real-time co-editing](real-time-co-editing.md)), which makes the problem more visible.

## Proposed behavior

Every user without a picture gets a generated avatar: a circle split by a blurred wave into two colors of one palette, with their initials on top. The [interactive prototype](https://emdash-user-avatars-prototype.gifted-market-6ca.workers.dev/) shows it at every size, in both themes, and for the cases below. The prototype also offers flat and outline styles for comparison, and mockups of Revisions and co-editing that only illustrate where avatars could appear later. This plan ships only the gradient style in the three places above.

- **The user ID chooses the look.** A hash of the user ID picks one of 12 color pairs, one of 8 waves, an angle between −12° and 12°, and whether the wave is mirrored. The same user looks the same in every browser, tab and admin screen. Renaming a user changes their initials but not their colors.
- **Initials.** The first letter of the first word and of the last word: "Noah Pham" shows NP, and "María José de la Cruz" shows MC. A one-word name shows one letter. Leading symbols and emoji are ignored, so "🚀 Rocket Team" shows RT.
- **One character for uncased starts.** When the first character has no upper and lower case, such as a digit, a Chinese character or an Arabic letter, only that character shows. Two joined Arabic letters would read as a word. A name that mixes scripts, such as "Noah 陈伟", shows N陈.
- **No name.** A user with no name shows the gradient alone, without letters. The email no longer stands in, because its first letter usually says nothing about the person.
- **A picture wins.** A user with `avatar_url` shows the generated avatar until the picture loads, then the picture. If it fails to load, the generated avatar stays.
- **Small sizes.** Below 24 px, only the first initial shows, as the header shows one letter today.

### Palette

Each pair is a light top color over a deeper bottom color. The pairs started from OKLCH targets, so the set reads as one family: lightness 0.93 and chroma 0.085 for every top color, and lightness 0.6 and chroma 0.17 for every bottom color. Ember, Apricot and Meadow got slightly more lightness or chroma, so their bottoms don't look brown. Colors outside sRGB were reduced in chroma until they fit, so the hex values below are the specification, not the targets. Ten pairs use neighboring hues. Dusk and Twilight put a warm top over a cool bottom.

| Pair     | OKLCH hues, top / bottom | Top       | Bottom    | White initials on the 85% mix |
| -------- | ------------------------ | --------- | --------- | ----------------------------- |
| Ember    | 80° / 32°                | `#fee4b9` | `#e14c33` | 3.4:1                         |
| Apricot  | 88° / 48°                | `#ffe6aa` | `#dd6301` | 3.0:1                         |
| Meadow   | 115° / 148°              | `#e5efae` | `#009b3c` | 3.1:1                         |
| Jade     | 140° / 175°              | `#caf7c1` | `#07957c` | 3.1:1                         |
| Lagoon   | 180° / 222°              | `#a7fbea` | `#058eaf` | 3.2:1                         |
| Sky      | 205° / 248°              | `#aff6fe` | `#0584da` | 3.3:1                         |
| Indigo   | 240° / 272°              | `#d3ecff` | `#5f74e4` | 3.4:1                         |
| Iris     | 330° / 295°              | `#ffdbfa` | `#8a66d9` | 3.4:1                         |
| Orchid   | 0° / 325°                | `#fedee7` | `#b156b7` | 3.5:1                         |
| Rose     | 45° / 10°                | `#fee1d4` | `#d04a69` | 3.6:1                         |
| Dusk     | 40° / 262°               | `#ffe0d6` | `#447be4` | 3.4:1                         |
| Twilight | 85° / 305°               | `#fee5b0` | `#9860d0` | 3.5:1                         |

The wave edge runs through the top of the initials, so the initials sit mostly, not entirely, on the bottom color. The ratios are measured against an sRGB mix of 85% bottom and 15% top, the color behind most of the letters, without the letter shadow. Every pair keeps at least 3:1 against that mix. The initials are decorative wherever the avatar appears, so this is a design floor, not a WCAG conformance claim.

### Rendering

The avatar is one inline SVG on a 100 by 100 view box, clipped to a circle. Its layers, from the back:

1. The top color, filling the circle.
2. The wave in an sRGB mix of 45% bottom and 55% top, moved up 10 units, blurred with a 12-unit Gaussian blur, at 70% opacity.
3. The wave in the bottom color, blurred with a 5-unit Gaussian blur.
4. A white radial highlight centered at 30% across and 18% down, with radius 62%, from 50% opacity to clear.
5. A black radial shade centered at 72% across and 104% down, with radius 70%, from 16% opacity to clear.
6. A ring at radius 49.5 in the theme's hairline color, 8% black in light and 10% white in dark, `max(1, 100 / size)` units wide.
7. The initials, white, centered at the middle of the view box with a 0.35 em downward offset. They are 38 units for two letters and 44 for one, in the admin's sans-serif font at weight 600. Two drop shadows lift them: 1.6 units down with a 1.4-unit blur, in the bottom color mixed 55% toward black at 55% opacity, and a 5-unit blur with no offset, in the bottom color mixed 35% toward black at 35% opacity.

Each wave's top edge follows `y = base + a · sin(2πx/100 · f + p) + a2 · sin(2πx/100 · 2f + p)`, sampled every 10 units from x = −40 to 140 and drawn as a Catmull-Rom curve converted to cubic Béziers. The shape then closes below the circle. Its transform is `rotate(angle 50 50)`, followed for mirrored users by `translate(100 0) scale(-1 1)`, so the wave is mirrored before it is rotated.

| Wave | `base` | `a` | `f`  | `p` | `a2` |
| ---- | ------ | --- | ---- | --- | ---- |
| 1    | 44     | 6   | 0.5  | 0.3 | 0    |
| 2    | 42     | 7   | 1    | 0   | 0    |
| 3    | 46     | 7   | 1    | π   | 0    |
| 4    | 41     | 5   | 1.5  | 0.6 | 0    |
| 5    | 45     | 8   | 0.75 | 1.2 | 0    |
| 6    | 43     | 6   | 1.25 | 2.4 | 0    |
| 7    | 47     | 6   | 1    | π/2 | 2.5  |
| 8    | 40     | 4   | 2    | 0.2 | 0    |

### Choosing a variant

The user ID is hashed with cyrb53, which returns two unsigned 32-bit halves, `h1` and `h2`:

- palette: `h1 % 12`, indexing the palette table in order;
- wave: `(h1 >>> 8) % 8`, indexing the wave table in order;
- angle: `(h2 % 25) − 12` degrees;
- mirrored: bit 7 of `h2`.

The hash, both tables, their order and their lengths are fixed. Adding a palette or a wave changes the modulus and gives almost every existing user a new avatar, so it would need its own decision.

## Goals

- Give every user a distinct avatar without asking them to upload anything.
- Show each user the same avatar everywhere in the admin, with nothing stored and no network request.
- Keep the picture from GitHub or Google when a user has one.
- Draw every user avatar in the admin with one component.
- Work in light and dark themes, in right-to-left languages, in forced-colors mode, and at every size the admin uses.

## Non-goals

- Uploading, changing or removing a picture, or importing one when a provider is linked later.
- Letting users choose their own palette or style.
- Showing avatars in places that don't show one today, such as the content list, Revisions or comments.
- Cursor and selection colors for co-editing, which the co-editing implementation decides.
- Byline avatars, which are author credits with their own media field, and plugin avatars in the marketplace.
- The author colors in **Revisions**, which keep their four badge colors, assigned per list ([Readable revision history](readable-revision-history.md)).
- Avatars on the public site.

## Interfaces and compatibility

None public. There is no API, configuration or stored-data change, and no migration. The current user and the users list already return `id`, `name` and `avatarUrl`.

In the admin, a `UserAvatar` component takes a user's `id`, `name` and `avatarUrl`, a size in pixels, and an optional `label`. Without `label`, the avatar is decorative and hidden from screen readers. With `label`, it is an image with that accessible name. It replaces the three separate avatars in the header, the **Users** list and the user detail panel, which all show the user's name beside the avatar, so all three use the decorative form. The header hides its name on phones, which the next paragraph covers.

The header button hides its name below the `sm` breakpoint. Today the initial is the button's only accessible name there, so the button gets `aria-label` set to the displayed name, the user's name or else their email.

## Errors and edge cases

- **Empty or whitespace-only names,** and names without any letter or digit, count as no name.
- **Case.** Initials are uppercased without the admin's locale, so a user's initials are the same in every admin language.
- **Right-to-left.** Initials are centered, so text direction doesn't move them, and the wave isn't mirrored in right-to-left layouts. Chinese and Arabic glyphs can sit slightly off center vertically, because the offset centers Latin capitals.
- **A broken or blocked picture URL** keeps the generated avatar, with no retry.
- **Shared colors.** Any two users share a palette 1 time in 12. In a group of 4, two people share one about 43% of the time, and in a group of 5 about 62%. Their wave, angle and mirror usually differ but can match too, so names stay beside every avatar.
- **Forced colors.** The SVG sets `forced-color-adjust: none`, so Windows high-contrast mode keeps its colors instead of replacing the fills, strokes and shadows. The name beside it carries the meaning.

## Verification

Unit tests cover these cases.

- Initials for one, two and many words; a hyphenated first name; Cyrillic; Chinese; Arabic; a leading digit; a leading emoji; a mixed-script name; and empty, whitespace-only and symbol-only names. A Turkish "i" gives "I" under a Turkish locale.
- Four fixed user IDs map to pinned palette names, wave numbers, angles and mirrors, so a change to the hash, or to either table's order or length, fails.
- A fixed, generated set of 1,000 IDs reaches every palette and every wave.
- White initials keep at least 3:1 against every palette's 85% mix.

Component tests cover these cases.

- A user with a picture shows the generated avatar until the picture loads, then the picture. A picture that fails to load leaves the generated avatar.
- A user without a name shows no letters, and below 24 px only one letter shows.
- Without `label`, the avatar is hidden from screen readers. With `label`, it has that accessible name.
- At phone width, the header button's accessible name is the user's name.

Check the header, the **Users** list and the user detail panel by hand in light and dark themes, in Arabic, in forced-colors mode and at phone width, and attach before-and-after screenshots to the implementation pull request.
