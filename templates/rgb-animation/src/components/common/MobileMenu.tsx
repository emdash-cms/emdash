import { useState, useEffect, useCallback } from 'react';
import './MobileMenu.css';

interface NavLink {
  label: string;
  href: string;
}

interface MobileMenuProps {
  locale: string;
  categories: NavLink[];
  secondary: NavLink[];
  menuLabel: string;
  closeLabel: string;
}

export default function MobileMenu({
  categories,
  secondary,
  menuLabel,
  closeLabel,
}: MobileMenuProps) {
  const [isOpen, setIsOpen] = useState(false);

  const close = useCallback(() => setIsOpen(false), []);

  // Close on Escape key
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && isOpen) close();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, close]);

  // Lock body scroll when open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  return (
    <>
      {/* Hamburger toggle — visible on mobile only */}
      <button
        className="mobile-menu__toggle"
        onClick={() => setIsOpen(!isOpen)}
        aria-label={isOpen ? closeLabel : menuLabel}
        aria-expanded={isOpen}
      >
        <span className={`mobile-menu__icon ${isOpen ? 'mobile-menu__icon--open' : ''}`}>
          <span />
          <span />
          <span />
        </span>
      </button>

      {/* Overlay menu */}
      {isOpen && (
        <div className="mobile-menu__overlay" onClick={close}>
          <nav
            className="mobile-menu__panel"
            onClick={(e) => e.stopPropagation()}
            aria-label="Mobile navigation"
          >
            <button
              className="mobile-menu__close"
              onClick={close}
              aria-label={closeLabel}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>

            <div className="mobile-menu__section">
              {categories.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  className="mobile-menu__link mobile-menu__link--primary"
                  onClick={close}
                >
                  {item.label}
                </a>
              ))}
            </div>

            <div className="mobile-menu__divider" />

            <div className="mobile-menu__section">
              {secondary.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  className="mobile-menu__link mobile-menu__link--secondary"
                  onClick={close}
                >
                  {item.label}
                </a>
              ))}
            </div>
          </nav>
        </div>
      )}
    </>
  );
}
