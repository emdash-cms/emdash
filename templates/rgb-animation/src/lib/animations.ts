/**
 * Scroll-triggered animation observer.
 * Watches elements with animation classes and adds --visible
 * modifier when they enter the viewport.
 *
 * Usage: call initScrollAnimations() from a <script> tag in layout.
 */

const ANIMATION_CLASSES = [
  'fade-in',
  'fade-in-left',
  'fade-in-right',
  'scale-in',
  'line-draw',
  'image-reveal',
] as const;

const SELECTOR = ANIMATION_CLASSES.map((cls) => `.${cls}`).join(', ');

export function initScrollAnimations(): void {
  const animatedElements = document.querySelectorAll(SELECTOR);

  if (animatedElements.length === 0) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const el = entry.target;
          const baseClass = ANIMATION_CLASSES.find((cls) =>
            el.classList.contains(cls),
          );
          if (baseClass) {
            el.classList.add(`${baseClass}--visible`);
          }
          observer.unobserve(el);
        }
      });
    },
    {
      threshold: 0.1,
      rootMargin: '0px 0px -50px 0px',
    },
  );

  animatedElements.forEach((el) => observer.observe(el));
}
