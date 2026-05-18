# Symballo CMS Design Guide

## Product Feel

Symballo CMS is a calm, premium, local-business admin tool.

It should feel like:

- modern neutral SaaS
- soft enterprise
- structured but approachable
- complete, not experimental
- easy for non-technical owners

Reference feel:

- Linear for crisp hierarchy
- Stripe Dashboard for restrained polish
- modern Notion for simplicity
- softened for local-business friendliness

Avoid:

- Bootstrap defaults
- Material Design defaults
- IBM Carbon austerity
- playful startup dashboards
- heavy shadows
- glossy gradients
- overly rounded mobile-app styling

---

## Core Layout

Use a persistent left sidebar and a main workspace.

```txt
┌──────────────┬────────────────────────────────────┐
│ Sidebar      │ Main workspace                     │
│ Navigation   │ Page header + content/forms/cards  │
└──────────────┴────────────────────────────────────┘
```

### Sidebar

Sidebar contains:

```txt
[Business Name]

Dashboard

CONTENT
Posts
Promotions
Menu
Hours

SITE
Site Profile
Pages
Appearance
Media Library
Settings & SEO

WORKSPACE
Account
Guide
Support
Open site

[Your Symballo Account]
Account Settings
```

Rules:

- Business identity is primary.
- Symballo branding is secondary.
- Active nav item uses a subtle rounded rectangle.
- Sidebar background is slightly different from the main workspace.
- Icons should be simple outline icons.

---

## Visual Language

The interface should be:

- white-space driven
- typography-forward
- restrained
- low-noise
- consistent
- trustworthy

Use subtle borders instead of heavy shadows.

Surfaces should layer clearly:

1. app shell background
2. sidebar
3. main workspace
4. cards / panels
5. form controls

---

## Color Tokens

```txt
Shell background:   #F3F5F7
Sidebar background: #F1F5F9
Workspace surface:  #FFFFFF
Card surface:       #FFFFFF
Muted surface:      #F8FAFC

Border:             #D9E1EA
Border subtle:      #E5EAF0

Text primary:       #0F172A
Text secondary:     #64748B
Text muted:         #94A3B8

Primary action:     #1E3A66
Primary hover:      #172E52

Success:            #059669
Success surface:    #ECFDF5

Danger:             #DC2626
Danger surface:     #FEF2F2
```

Color should support hierarchy, not decorate the UI.

---

## Typography

Use:

- **Inter** for interface text
- **Onest** for page titles and business identity

Inter:

- labels
- inputs
- buttons
- navigation
- metrics
- tables
- helper text

Onest:

- app/page titles
- business name
- major section headings only

Suggested sizes:

```txt
Page title:       30–34px / 700
Section title:    18–22px / 600–700
Nav item:         15–16px / 500–600
Label:            14px / 500–600
Body:             15–16px / 400–500
Helper text:      13–14px / 400
Button:           14–15px / 600
```

---

## Radius System

Use consistent geometry.

```txt
Small controls:   8px
Buttons:          10px
Inputs:           10px
Textareas:        12px
Cards/panels:     14px
Large panels:     16px
Badges/chips:     999px
```

Rules:

- Do not make primary buttons pill-shaped.
- Active nav items are rounded rectangles, not bubbles.
- Badges may be fully rounded.
- Keep geometry disciplined and consistent.

---

## Buttons

Primary buttons:

```txt
height: 40–44px
radius: 10px
padding-x: 16–18px
font-weight: 600
background: primary action
```

Secondary buttons:

```txt
same height/radius
white or transparent background
subtle border
```

Danger buttons:

```txt
subtle red outline or text
not large filled red unless confirming destructive action
```

Button labels should be clear:

- Save Changes
- New Post
- Preview
- Publish
- Replace
- Remove

Avoid vague labels like “Submit.”

---

## Inputs and Forms

Inputs:

```txt
height: 44px
radius: 10px
border: subtle neutral
padding-x: 14–16px
```

Textareas:

```txt
radius: 12px
min-height: 120px
padding: 14–16px
```

Rules:

- Use visible labels.
- Helper text goes below fields.
- Validation errors appear near the field.
- Forms should feel spacious, not dense.
- Prefer two-column forms on desktop.
- Collapse to one column on mobile.

---

## Cards and Panels

Cards:

```txt
background: white
border: 1px solid subtle border
radius: 14px
shadow: none or very subtle
padding: 16–24px
```

Avoid excessive nested borders.

Cards should group related work, not decorate the page.

---

## Tabs

Use tabs for local sections only.

Good:

```txt
Business Identity | Hours
Regular | Special | Closed
General | SEO | Social | Tracking
```

Tabs should have:

- clear active underline or subtle active state
- no heavy pill styling unless using segmented controls intentionally

---

## Badges and Status

Use badges for system state.

Examples:

- Saved
- Draft
- Published
- Scheduled
- Active
- Expired

Saved badge:

```txt
green text
soft green background
subtle border
fully rounded
```

Save states:

- Saved
- Saving…
- Unsaved changes
- Failed to save changes

Users should never wonder whether their changes are live.

---

## Sidebar Rules

Navigation grouping:

```txt
Dashboard

CONTENT
Posts
Promotions
Menu
Hours

SITE
Site Profile
Pages
Appearance
Media Library
Settings & SEO

WORKSPACE
Account
Guide
Support
Open site
```

Rules:

- Keep labels short.
- Keep icons muted.
- Active item uses subtle background and border.
- Do not over-brand Symballo.
- Client business name should remain visually prominent.

---

## Content vs Site vs Workspace

Use these meanings consistently.

### Content

Things customers directly see and that owners update often:

- Posts
- Promotions
- Menu / Services
- Hours

### Site

Foundational site setup:

- Site Profile
- Pages
- Appearance
- Media Library
- Settings & SEO

### Workspace

Relationship with Symballo:

- Account
- Guide
- Support
- Open site

---

## Page Header Pattern

Use compact headers.

```txt
Site Profile                         [View Guide] [+ New]
Update your business information
```

Avoid duplicating the page title inside the page body.

---

## Save Actions

Primary save action should be easy to find.

For long forms:

- place Save Changes at bottom-right
- consider sticky save bar later
- show save status near the form or button

Avoid floating save indicators disconnected from the current form.

---

## Media / Assets

Media cards should feel clean and lightweight.

Use:

```txt
[preview/avatar]
filename.png
120 KB

[Replace] [Remove]
```

Rules:

- media upload is handled through Media Library or inline selectors
- logo/favicon references belong in Site Profile or Appearance
- content images belong to their content module

---

## Dashboard Design

Dashboard should show what a local business owner cares about:

- visitors
- page views
- top pages
- call clicks
- direction clicks
- menu views
- promo views
- recent posts
- site health

Avoid analytics jargon.

Do not prioritize:

- bounce rate
- funnel analysis
- UTM breakdowns
- cohort analysis

---

## Mobile Behavior

Desktop can use sidebar + two-column forms.

Mobile should become:

```txt
top header
single-column content
list → detail flows
large touch targets
bottom or drawer navigation
```

Minimum touch target:

```txt
44px x 44px
```

Do not force desktop split panes onto mobile.

---

## Accessibility

Follow WCAG 2.1 AA.

Requirements:

- visible focus states
- keyboard navigation
- real labels for inputs
- real buttons for actions
- real links for navigation
- sufficient contrast
- destructive actions require confirmation
- status changes should be announced where appropriate

---

## AI Agent Implementation Rules

When generating UI:

1. Preserve the existing app shell.
2. Preserve the current color palette unless explicitly told otherwise.
3. Do not redesign layout during a refinement task.
4. Use existing components before creating new ones.
5. Keep radii consistent with this document.
6. Avoid pill-shaped buttons except badges/chips.
7. Use Inter for UI text.
8. Use Onest only for titles and brand identity.
9. Keep advanced settings collapsed where possible.
10. Do not expose visual page-builder controls.
11. Do not hardcode demo business content into reusable components.
12. All screens must include loading, empty, error, and saved states where relevant.

---

## Success Criteria

The CMS feels successful when a non-technical business owner can:

- understand where they are
- update business information
- update hours
- create a post
- create a promotion
- update menu items
- upload/select images
- save confidently
- avoid breaking the public website

The product should feel like:

> “This is my business control panel, and I can’t mess it up.”
