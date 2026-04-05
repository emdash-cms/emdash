import { useState, useRef, useEffect, useCallback } from 'react';
import type { CarouselImage } from '@/lib/types';
import type { Locale } from '@/i18n';
import './ProjectCarousel.css';

interface ProjectCarouselProps {
  images: CarouselImage[];
  locale: Locale;
  title: string;
  subtitle: string;
}

const AUTOPLAY_MS = 4500;

export default function ProjectCarousel({ images, locale, title, subtitle }: ProjectCarouselProps) {
  const [current, setCurrent] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartX = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval>>();
  const total = images.length;

  const goTo = useCallback(
    (index: number) => setCurrent(((index % total) + total) % total),
    [total],
  );
  const goNext = useCallback(() => goTo(current + 1), [current, goTo]);
  const goPrev = useCallback(() => goTo(current - 1), [current, goTo]);

  // Autoplay
  useEffect(() => {
    if (isPaused) return;
    intervalRef.current = setInterval(goNext, AUTOPLAY_MS);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [goNext, isPaused]);

  // Touch / drag swipe
  function onPointerDown(e: React.PointerEvent) {
    dragStartX.current = e.clientX;
    setIsDragging(true);
    setIsPaused(true);
  }

  function onPointerUp(e: React.PointerEvent) {
    if (!isDragging) return;
    setIsDragging(false);
    const delta = e.clientX - dragStartX.current;
    if (Math.abs(delta) > 50) {
      delta < 0 ? goNext() : goPrev();
    }
    setTimeout(() => setIsPaused(false), 2000);
  }

  return (
    <section className="carousel" id="carousel">
      <div className="container">
        <div className="section__header fade-in">
          <h2 className="section__title carousel__title">{title}</h2>
          <div className="section__divider line-draw" />
          <p className="section__subtitle carousel__subtitle">{subtitle}</p>
        </div>
      </div>

      <div
        className="carousel__viewport"
        onMouseEnter={() => setIsPaused(true)}
        onMouseLeave={() => setIsPaused(false)}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setIsDragging(false)}
        role="region"
        aria-label={title}
        aria-roledescription="carousel"
      >
        {/* Track */}
        <div
          className="carousel__track"
          style={{ transform: `translateX(-${current * 100}%)` }}
          aria-live="polite"
        >
          {images.map((img, i) => (
            <div
              key={img.id}
              className="carousel__slide"
              role="group"
              aria-roledescription="slide"
              aria-label={`${i + 1} / ${total}`}
              aria-hidden={i !== current}
            >
              <img
                src={img.src}
                alt={locale === 'en' ? img.altEn : img.alt}
                className="carousel__image"
                loading={i === 0 ? 'eager' : 'lazy'}
                draggable="false"
              />
            </div>
          ))}
        </div>

        {/* Prev arrow */}
        <button
          className="carousel__arrow carousel__arrow--prev"
          onClick={goPrev}
          aria-label="Previous slide"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>

        {/* Next arrow */}
        <button
          className="carousel__arrow carousel__arrow--next"
          onClick={goNext}
          aria-label="Next slide"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>

        {/* Dots */}
        <div className="carousel__dots" role="tablist" aria-label="Slides">
          {images.map((_, i) => (
            <button
              key={i}
              className={`carousel__dot${i === current ? ' carousel__dot--active' : ''}`}
              onClick={() => { goTo(i); setIsPaused(true); setTimeout(() => setIsPaused(false), 3000); }}
              role="tab"
              aria-selected={i === current}
              aria-label={`Go to slide ${i + 1}`}
            />
          ))}
        </div>

        {/* Progress bar */}
        <div className="carousel__progress">
          <div
            className={`carousel__progress-fill${isPaused ? '' : ' carousel__progress-fill--animated'}`}
            key={`${current}-${isPaused}`}
            style={{ animationDuration: `${AUTOPLAY_MS}ms` }}
          />
        </div>
      </div>
    </section>
  );
}
