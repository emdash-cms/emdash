import { useState, useMemo } from 'react';
import type { OutsourcedItem } from '@/lib/types';
import type { Locale } from '@/i18n';
import './OutsourcedGallery.css';

interface OutsourcedGalleryProps {
  items: OutsourcedItem[];
  locale: Locale;
  title: string;
  subtitle: string;
}

const ALL = 'All';

export default function OutsourcedGallery({ items, locale, title, subtitle }: OutsourcedGalleryProps) {
  const categories = useMemo(() => {
    const cats = new Set(items.map((i) => i.category));
    return [ALL, ...Array.from(cats)];
  }, [items]);

  const [active, setActive] = useState(ALL);

  const filtered = useMemo(
    () => (active === ALL ? items : items.filter((i) => i.category === active)),
    [items, active],
  );

  return (
    <section className="outsourced" id="outsourced">
      <div className="container">
        <div className="section__header fade-in">
          <h2 className="section__title outsourced__title">{title}</h2>
          <div className="section__divider line-draw" />
          <p className="section__subtitle outsourced__subtitle">{subtitle}</p>
        </div>

        {/* Category filter */}
        <div className="outsourced__filters" role="tablist" aria-label="Filter by category">
          {categories.map((cat) => (
            <button
              key={cat}
              className={`outsourced__filter-btn${active === cat ? ' outsourced__filter-btn--active' : ''}`}
              onClick={() => setActive(cat)}
              role="tab"
              aria-selected={active === cat}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* CSS Masonry (columns) */}
        <div className="outsourced__masonry">
          {filtered.map((item) => {
            const itemTitle = locale === 'en' ? item.titleEn : item.title;
            return (
              <div
                key={item.id}
                className={`outsourced__item outsourced__item--${item.aspectRatio}`}
              >
                <div className="outsourced__item-inner">
                  <img
                    src={item.src}
                    alt={itemTitle}
                    className="outsourced__item-img"
                    loading="lazy"
                  />
                  <div className="outsourced__item-overlay">
                    <span className="outsourced__item-cat">{item.category}</span>
                    <h3 className="outsourced__item-title">{itemTitle}</h3>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
