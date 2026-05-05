# Symballo CMS Design Guide

## Purpose

This document defines the visual style, layout system, interaction patterns, and screen structure for the Symballo CMS admin application.

The CMS is built for small local businesses and small churches that need to update simple website content without touching layout, theme, or design settings. The interface should feel professional, calm, obvious, and difficult to break.

The admin is not a website builder. It is a focused business control panel.

---

## Product Positioning

The CMS helps business owners update the few things customers actually check:

- Business information
- Hours
- Menu items or services
- Announcements
- Promotions
- Events
- Posts
- Photos
- Basic SEO and site settings

The user should never feel like they are designing a website. They should feel like they are keeping their business information current.

---

## Design Principles

### 1. Simple, not simplistic

The interface should feel polished and capable, but never dense or intimidating.

Prefer:
- plain labels
- obvious buttons
- guided sections
- clear save states
- constrained controls

Avoid:
- technical terminology
- exposed implementation details
- excessive settings
- dense enterprise-style tables unless the content truly requires them

---

### 2. Local-business friendly

Assume the user is busy, non-technical, and logs in only occasionally.

Every screen should answer:

> “What can I update here, and what happens when I save?”

Use practical language like:

- “Show this as a sitewide banner”
- “This appears on your homepage”
- “Customers will see this on your menu”
- “Changes to regular hours are published immediately”

Avoid developer/CMS language like:

- “entity”
- “resource”
- “collection”
- “payload”
- “frontmatter”
- “taxonomy”

---

### 3. Guardrails over freedom

The CMS should prevent bad outcomes.

Users should not be able to:
- change layout
- break spacing
- choose arbitrary colors
- alter typography
- damage SEO accidentally
- publish malformed content

The system should provide:
- good defaults
- generated slugs
- generated SEO text
- image optimization
- preview before publish
- draft/published states where appropriate

---

### 4. Their business first, Symballo second

The app should feel like it belongs to the client’s business.

Primary identity:
- Client business name
- Client logo/icon
- Location

Secondary identity:
- “Powered by Symballo”
- Symballo account area
- Billing/support references

Do not make Symballo branding dominate the admin UI.

---

## Overall Layout

Desktop layout uses a three-region app shell:

```txt
┌────────────────┬──────────────────────────────────┬──────────────────┐
│ Left Sidebar   │ Main Content                     │ Right Panel      │
│ Navigation     │ Page workspace                   │ Account/context  │
└────────────────┴──────────────────────────────────┴──────────────────┘
````

### Left Sidebar

Purpose:

* Primary navigation
* Business identity
* Quick access to Symballo account
* Help/support
* Subtle Symballo branding

Width:

* Approximately 240px on desktop

Behavior:

* Fixed on desktop
* Collapsible or hidden behind menu button on tablet/mobile
* Navigation item for current page should be visibly active

Recommended sidebar structure:

```txt
[Business Logo]
Arthur’s Hot Dogs
Clayton, NC

CONTENT
Dashboard
Posts
Promotions
Menu
Hours
Photos

SETTINGS
Site Profile
Pages
Appearance
Settings & SEO

[Your Symballo Account]
Customer since May 12, 2024
Account Settings

[Need help?]
View Guide

Powered by Symballo
```

---

### Top Bar

Purpose:

* Global utility actions only

Desktop top bar should include:

* Sidebar toggle/menu icon
* Light/dark toggle
* Guide
* Support
* Open site

Save actions should usually belong to the current page header or editor area, not the global top bar, unless the current screen is a full-page editor.

---

### Main Content Area

Purpose:

* Primary workspace
* Lists
* Forms
* Editors
* Dashboards
* Tables
* Preview controls

The main area should be fluid and use available space efficiently.

Desktop pages should avoid huge decorative headers. Page titles should be clear but compact.

Preferred page header pattern:

```txt
Posts                                      ✓ Saved 2 minutes ago   [Save Changes]
Publish updates, news, announcements, events, and more.
```

---

### Right Panel

Purpose:

* Account context
* Billing
* Plan information
* Contextual helpers
* Optional secondary tools

Width:

* Approximately 300–340px on desktop

Behavior:

* Fixed or sticky on large desktop
* Collapsible
* Hidden behind an account button on mobile

The right panel is appropriate for:

* Account plan
* Billing information
* Payment history
* Customer since date
* Site count
* Referral prompt
* Contextual publishing hints

Do not put primary editing controls only in the right panel.

---

## Navigation Model

Use vertical sidebar navigation for primary app sections.

Use horizontal tabs only inside a section.

Good examples:

Primary navigation:

```txt
Dashboard
Posts
Promotions
Menu
Hours
Photos
```

Internal tabs:

```txt
Hours → Regular | Special | Closed
Settings → General | SEO | Social | Tracking
Menu → Categories | Items
Posts → All | Drafts | Scheduled
```

Avoid using horizontal tabs for the entire application.

---

## Core Screens

### Dashboard

The dashboard should show at-a-glance website health and activity.

It should be useful to a local business owner, not an analytics professional.

Recommended widgets:

* Website visitors
* Page views
* Top action clicks
* Promo/banner views
* Visitors over time
* Top traffic sources
* Most visited pages
* Top action clicks:

  * Call us
  * Get directions
  * View menu
  * Reserve
  * Order online
* Recent posts
* Site health

Tone should be plain:

```txt
Your site is looking good.
No issues found.
```

Avoid jargon:

* bounce rate
* conversion funnel
* UTM breakdown
* acquisition channel analysis

Those can exist later, but should not dominate v1.

---

### Posts

Purpose:
Allow owners to publish updates, announcements, news, events, and short articles.

Desktop layout:

* Left column: post list
* Right column: editor

Post list should include:

* Title
* Date
* Status badge
* Overflow menu

Editor should include:

* Title
* Slug
* Date
* Excerpt
* Main content
* Optional image
* Draft/publish controls
* Preview button
* Sitewide banner toggle
* Collapsible SEO settings

Default editor flow:

1. User enters title
2. Slug auto-generates
3. User enters short excerpt
4. User writes content
5. User optionally enables banner
6. User previews
7. User publishes

SEO settings should be collapsed by default.

---

### Promotions

Purpose:
Allow owners to create limited-time offers or recurring promotions.

Promotion fields:

* Title
* Description
* Start date
* End date
* Optional recurring schedule
* CTA text
* CTA link
* Show as banner
* Active/inactive status

Promotion list should clearly show:

* Active
* Scheduled
* Expired
* No end date

Use plain language:

```txt
This promotion will automatically stop showing after the end date.
```

---

### Menu

Purpose:
Allow restaurants and food businesses to update menu categories, items, prices, descriptions, photos, and availability.

Desktop layout:

* Left column: categories
* Right column: items in selected category

Category fields:

* Name
* Display order
* Active/inactive

Item fields:

* Name
* Description
* Price
* Photo
* Category
* Available/unavailable
* Featured item

Important:

* Photo should be optional
* Price should support “market price” or blank price
* Availability toggle should be very easy to use
* Menu edits should not break the public layout

---

### Services

Purpose:
Allow non-restaurant businesses to list services instead of menu items.

Service fields:

* Service name
* Category
* Short description
* Starting price or “Request quote”
* Featured status
* Published/draft status

Examples:

* Dine-in
* Takeout
* Catering
* Private Events
* Lawn Care
* Roof Repair
* Sunday Service
* Youth Ministry

Use this section for churches as “Ministries” if the site type is church.

---

### Hours

Purpose:
Allow owners to keep regular hours and exceptions accurate.

Sections:

* Regular Hours
* Special Hours
* Holiday Hours
* Closed Dates

Regular hours fields:

* Day of week
* Open/closed toggle
* Opening time
* Closing time
* Optional second time range

Special hours fields:

* Date
* Opening time
* Closing time
* Note

Closed dates:

* Date
* Reason/note
* Optional sitewide notice

Important:
Changes to regular hours may publish immediately. If so, state that clearly.

Example helper text:

```txt
Changes to regular hours are published immediately.
```

---

### Photos / Media Library

Purpose:
Allow users to upload and manage images used across the site.

Media screen should include:

* Image grid
* Search
* Filter by type/usage
* Upload button
* File name
* Upload date
* File size
* Image actions

Image actions:

* Replace
* Remove
* Copy URL
* Edit alt text
* Set as hero image if applicable

Upload area should state accepted formats:

```txt
PNG, JPG, WEBP up to 10MB
```

All uploaded images should be optimized automatically.

---

### Site Profile

Purpose:
Manage the core business information displayed across the site.

Sections:

* Business Information
* Contact & Location
* Hours
* Social Links
* SEO Settings

Business information:

* Business name
* Tagline
* Short description
* Logo
* Favicon

Contact/location:

* Phone
* Email
* Address
* Google Maps link
* Preferred CTA

Social links:

* Facebook
* Instagram
* YouTube
* TikTok
* X/Twitter
* Other

---

### Settings & SEO

Purpose:
Control site-level metadata and preferences.

Sections:

* General
* SEO
* Social
* Tracking

General:

* Site title
* Tagline
* Language
* Time zone
* Show/hide sitewide banner when active

SEO:

* Default SEO title
* Default meta description
* Indexing toggle

Social:

* Default social sharing image
* Social title
* Social description

Tracking:

* Analytics provider status
* Tracking enabled/disabled
* Custom events enabled/disabled

Advanced SEO fields should be available but not visually dominant.

---

### Account / Billing

Purpose:
Distinguish the client’s business site from their account with Symballo.

This should not be mixed into Site Profile.

Use language like:

```txt
Your Symballo Account
```

Account features:

* Current plan
* Monthly price
* Next billing date
* Manage plan
* Payment information
* Billing history
* Download receipts
* Download payment history CSV
* Account details
* Password
* Logout

Account data belongs in:

* sidebar account card
* right account panel
* dedicated account settings page

Do not place billing settings under “Site Profile,” because Site Profile is about the public business website.

---

## Component Style

### Cards

Use cards for grouped content.

Card style:

* White background
* 1px light border
* 10–14px border radius
* Soft shadow or no shadow
* Generous internal padding

Cards should feel calm and lightweight.

---

### Buttons

Primary button:

* Used for save, publish, create, upload
* Solid green or blue
* Clear label

Secondary button:

* Used for preview, cancel, guide, open site
* White background
* Light border

Danger button:

* Used for delete/logout destructive actions
* Red text or red outline
* Avoid large filled red buttons unless confirming a destructive action

Button labels should be action-oriented:

Good:

* Save Changes
* New Post
* Preview
* Publish
* Upload Images
* Manage Plan

Avoid:

* Submit
* Confirm
* Execute

---

### Forms

Form fields should be large, readable, and well-spaced.

Each field should have:

* visible label
* useful placeholder only if needed
* helper text when the consequence is not obvious
* validation message near the field

Preferred layout:

* Two columns on desktop when fields are short
* Single column on mobile
* Full-width textareas for long content

Example:

```txt
Title                         Slug
[____________________]        [____________________]

Date                          Excerpt
[____________________]        [____________________]
```

---

### Tables and Lists

Use tables only when comparison across rows matters.

Use card/list rows for:

* posts
* promotions
* menu items
* services
* events

Rows should show:

* primary label
* secondary detail
* status badge
* overflow actions

---

### Badges

Use badges for content state.

Common states:

* Published
* Draft
* Scheduled
* Active
* Expired
* Hidden
* Unavailable

Badge style:

* rounded pill
* subtle background
* readable text
* color-coded but not color-only

---

### Accordions

Use accordions for advanced or optional sections.

Good accordion sections:

* SEO Settings
* Banner Settings
* Social Sharing
* Advanced Options
* Tracking Settings

Advanced sections should be collapsed by default.

---

## Color System

Use a restrained color palette.

Recommended semantic colors:

```txt
Background:      #F8FAFC
Surface:         #FFFFFF
Border:          #E2E8F0
Text Primary:    #0F172A
Text Secondary:  #64748B

Primary:         #047857 or #0F766E
Primary Hover:   #065F46

Info:            #2563EB
Success:         #16A34A
Warning:         #F59E0B
Danger:          #DC2626
Muted:           #F1F5F9
```

Use color to support meaning, not decoration.

---

## Typography

Use system fonts unless the project already defines a brand font.

Recommended stack:

```css
font-family:
  Inter,
  ui-sans-serif,
  system-ui,
  -apple-system,
  BlinkMacSystemFont,
  "Segoe UI",
  sans-serif;
```

Typography scale:

* Page title: 28–32px, 700 weight
* Section title: 18–22px, 600–700 weight
* Body: 14–16px, 400–500 weight
* Helper text: 12–14px, muted color
* Labels: 13–14px, 500–600 weight

Avoid tiny text for primary workflows.

---

## Spacing

Use an 8px spacing system.

Common spacing:

* 4px
* 8px
* 12px
* 16px
* 24px
* 32px
* 40px
* 48px
* 64px

Desktop page padding:

* 24–32px

Card padding:

* 16–24px

Form field gap:

* 16–24px

---

## Border Radius

Use rounded corners consistently.

Recommended:

* Small controls: 6px
* Inputs/buttons: 8px
* Cards/panels: 12px
* Pills/badges: 999px

---

## Icons

Use simple outline icons.

Icon style:

* 1.5–2px stroke
* rounded line caps
* consistent size
* avoid filled decorative icons in navigation

Common icon size:

* 16px inline
* 20px navigation
* 24px feature cards

Icons should support labels, not replace them on desktop.

---

## Save and Publish Behavior

Every editable screen should clearly show save state.

States:

* Saved
* Unsaved changes
* Saving
* Failed to save changes
* Published
* Draft
* Scheduled

Save feedback should be visible but calm.

Examples:

```txt
✓ Saved 2 minutes ago
Saving...
Failed to save changes
```

For draft/publish content:

* Save Draft
* Preview
* Publish
* Schedule

For immediate settings:

* Save Changes

Do not make users guess whether changes are live.

---

## Preview Behavior

Preview should show what the public website will look like before publishing.

Preview can be implemented as:

* in-admin preview route
* modal preview
* new tab preview
* temporary signed preview URL

Preview should clearly indicate when content is not yet public.

Example:

```txt
Preview only — this post is not published yet.
```

---

## Responsive Behavior

### Desktop: 1200px and above

Use full three-region layout:

```txt
Left sidebar + main content + optional right panel
```

### Tablet: 768px–1199px

Use:

* collapsible sidebar
* main content full width
* right panel hidden behind account button or drawer

### Mobile: below 768px

Use:

* top mobile header
* bottom navigation or slide-out menu
* single-column forms
* full-width buttons
* list-first navigation
* detail screens instead of side-by-side list/editor

Mobile should not try to preserve the desktop split-pane editor.

Example mobile flow:

```txt
Posts list → Tap post → Edit post screen
Menu categories → Tap category → Item list → Tap item → Edit item
```

Minimum touch target:

* 44px by 44px

---

## Mobile Navigation

Mobile primary nav should include the most common actions:

* Dashboard
* Posts
* Menu or Services
* More

The “More” screen can contain:

* Promotions
* Hours
* Photos
* Site Profile
* Settings
* Account
* Support

---

## Accessibility

Follow WCAG 2.1 AA.

Requirements:

* keyboard navigable controls
* visible focus states
* sufficient color contrast
* labels connected to inputs
* buttons use real button elements
* links use real anchor elements
* status changes announced where appropriate
* modals trap focus
* destructive actions require confirmation

Do not rely on color alone to indicate status.

---

## Empty States

Every empty state should explain what to do next.

Examples:

```txt
No posts yet.
Create your first update to share news, events, or announcements on your site.
[New Post]
```

```txt
No menu items yet.
Add your first item so customers can see what you offer.
[Add Item]
```

Avoid empty blank panels.

---

## Error States

Errors should be specific and recoverable.

Bad:

```txt
Something went wrong.
```

Better:

```txt
Failed to save changes. Check your connection and try again.
```

For image upload:

```txt
This image is too large. Upload a JPG, PNG, or WEBP under 10MB.
```

---

## Confirmation Patterns

Require confirmation for destructive actions:

* delete post
* delete menu item
* remove image
* delete promotion
* log out if unsaved changes exist

Confirmation copy should name the item.

Example:

```txt
Delete “Mother’s Day Brunch”?
This cannot be undone.
```

---

## Branding

Client branding:

* primary in sidebar
* business logo/avatar
* business name
* location

Symballo branding:

* subtle sidebar footer
* account card
* billing/account panel
* support/guide experience

Use:

```txt
Powered by Symballo
```

Do not let Symballo visually overpower the client’s business identity.

---

## Tone and Microcopy

Tone:

* calm
* plain
* helpful
* confident

Prefer:

```txt
Show this as a sitewide banner.
```

Avoid:

```txt
Enable global promotional content module.
```

Prefer:

```txt
Customers will see this on your homepage.
```

Avoid:

```txt
This field controls frontend rendering behavior.
```

---

## Page-Level Patterns

### List + Editor Pattern

Use for:

* Posts
* Promotions
* Menu Items
* Services
* Events

Desktop:

```txt
┌───────────────┬──────────────────────────────┐
│ List          │ Editor                       │
│ Search        │ Form                         │
│ Filters       │ Save/Preview/Delete actions  │
└───────────────┴──────────────────────────────┘
```

Mobile:

```txt
List screen → Detail/edit screen
```

---

### Settings Pattern

Use for:

* Site Profile
* Hours
* Settings & SEO
* Account

Desktop:

```txt
┌───────────────┬──────────────────────────────┐
│ Section nav   │ Form content                 │
└───────────────┴──────────────────────────────┘
```

Mobile:

```txt
Section list → Section detail
```

---

### Dashboard Pattern

Use cards and lightweight charts.

Dashboard hierarchy:

1. Key metric cards
2. Main trend chart
3. Sources/actions summary
4. Recent activity
5. Site health

The dashboard should not require analytics knowledge to understand.

---

## What Not To Build Into the UI

Do not expose these in v1:

* drag-and-drop page builder
* arbitrary color picker
* font picker
* custom CSS
* layout editor
* plugin marketplace
* complex roles
* advanced analytics terminology
* ecommerce flows
* booking flows
* customer accounts

The product should remain focused.

---

## Implementation Notes for AI Agents

When creating new screens or components:

1. Use the existing app shell:

   * left sidebar
   * top utility bar
   * main content area
   * optional right panel

2. Prefer reusable primitives:

   * `Card`
   * `Button`
   * `Input`
   * `Textarea`
   * `Select`
   * `Badge`
   * `Accordion`
   * `EmptyState`
   * `ConfirmDialog`

3. Do not create one-off visual styles unless necessary.

4. Keep page titles compact.

5. Put advanced fields behind accordions.

6. Use clear save states.

7. Use client business identity as the primary brand.

8. Use Symballo branding only in account/support/billing contexts.

9. Preserve responsive behavior:

   * split-pane on desktop
   * list-to-detail flow on mobile

10. Do not add visual editing controls.

---

## Success Criteria

The design is successful if a non-technical owner can:

* log in and understand where they are
* update hours in under one minute
* create a post or promotion without help
* add or edit a menu item safely
* preview content before publishing
* know whether changes are saved or live
* access billing/account settings without confusion
* avoid breaking the public website design

The CMS should feel like:

> “This is my business control panel, and I can’t mess it up.”
