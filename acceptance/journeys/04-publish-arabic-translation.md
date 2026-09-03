---
id: publish-arabic-translation
site: multilingual-editorial
target: node
status: needs-profile
requires:
  - Arabic Editor session
  - Published English source without an Arabic translation
  - Arabic content, taxonomy, and menu locales
---

# Publish an Arabic translation

This journey tests content locale, admin language, translation relationships, right-to-left interaction, and independent publication state together.

## Bootstrap requirements

Provide an Editor whose admin language is Arabic. The English article **Visitor information** must be published with no Arabic translation. Configure English and Arabic content locales, localized navigation, and localized taxonomy definitions. Capture the English entry and its public response before dispatch.

## Tester brief

### Persona

You are an Arabic-speaking localization editor responsible for publishing translated visitor information.

### Goal

Publish the supplied Arabic translation of **Visitor information** using the slug `معلومات-الزوار`. Keep the English article unchanged and publicly available.

### Starting knowledge

The English article is complete. You need to create its Arabic counterpart rather than replace the English content.

### Supplied material

Use this title:

> معلومات الزوار

Use this body:

> يفتح المركز أبوابه من الثلاثاء إلى الأحد، من الساعة العاشرة صباحًا حتى السادسة مساءً.

## Coordinator checks

- The English and Arabic entries share one translation group.
- The Arabic entry uses locale `ar`, the supplied title, body, and slug, and is published.
- The English entry's data, slug, and publication state are unchanged.
- Both locale-specific public URLs return successful responses with the expected language.

## Areas to observe

- Can the tester distinguish admin language from content locale?
- Is the current content locale continuously visible and understandable?
- Can the tester create a related translation rather than an unrelated entry?
- Is per-locale publication clear?
- Does the workflow remain usable and visually coherent in a right-to-left interface?
