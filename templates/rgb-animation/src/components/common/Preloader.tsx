import { useState, useEffect, useRef } from 'react';
import './Preloader.css';

export default function Preloader() {
  const [count, setCount] = useState(0);
  const [isComplete, setIsComplete] = useState(false);
  const [isHidden, setIsHidden] = useState(false);
  const rafRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);

  const DURATION = 2200;

  useEffect(() => {
    // Skip on revisit within same session
    if (sessionStorage.getItem('rgb-preloader-done')) {
      setIsHidden(true);
      return;
    }

    startTimeRef.current = performance.now();

    function animate(now: number) {
      const elapsed = now - startTimeRef.current;
      const progress = Math.min(elapsed / DURATION, 1);
      // easeOutCubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setCount(Math.floor(eased * 100));

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      } else {
        setCount(100);
        setIsComplete(true);
        sessionStorage.setItem('rgb-preloader-done', '1');
        setTimeout(() => setIsHidden(true), 700);
      }
    }

    rafRef.current = requestAnimationFrame(animate);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  if (isHidden) return null;

  return (
    <div
      className={`preloader${isComplete ? ' preloader--fade-out' : ''}`}
      aria-hidden="true"
      aria-label="Loading"
    >
      <div className="preloader__content">
        <div className="preloader__logo">
          <span className="preloader__logo-rgb">RGB</span>
          <span className="preloader__logo-anim">Animation</span>
        </div>

        <div className="preloader__counter">
          <span className="preloader__number">{count}</span>
          <span className="preloader__percent">%</span>
        </div>

        <div className="preloader__bar-track">
          <div
            className="preloader__bar-fill"
            style={{ width: `${count}%` }}
          />
        </div>
      </div>
    </div>
  );
}
