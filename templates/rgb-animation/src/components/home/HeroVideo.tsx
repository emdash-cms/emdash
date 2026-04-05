import { useState, useRef, useEffect, useCallback } from 'react';
import './HeroVideo.css';

interface HeroVideoProps {
  src?: string;
  poster?: string;
  title: string;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function HeroVideo({ src, poster, title }: HeroVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const seekBarRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [isLoaded, setIsLoaded] = useState(false);

  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setShowControls(false), 3000);
  }, []);

  const handleMouseMove = useCallback(() => {
    setShowControls(true);
    if (isPlaying) scheduleHide();
  }, [isPlaying, scheduleHide]);

  useEffect(() => () => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current); }, []);

  // Fullscreen change listener
  useEffect(() => {
    function onFsChange() {
      setIsFullscreen(!!document.fullscreenElement);
    }
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      void v.play();
      setIsPlaying(true);
      scheduleHide();
    } else {
      v.pause();
      setIsPlaying(false);
      setShowControls(true);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    }
  }

  function toggleMute() {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setIsMuted(v.muted);
  }

  function toggleFullscreen() {
    const container = videoRef.current?.closest('.hero-video');
    if (!container) return;
    if (!document.fullscreenElement) {
      void container.requestFullscreen();
    } else {
      void document.exitFullscreen();
    }
  }

  function handleSeek(e: React.MouseEvent<HTMLDivElement>) {
    const bar = seekBarRef.current;
    const v = videoRef.current;
    if (!bar || !v || !duration) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    v.currentTime = ratio * duration;
    setCurrentTime(v.currentTime);
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <section
      className={`hero-video${showControls ? ' hero-video--show-controls' : ''}`}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => isPlaying && scheduleHide()}
    >
      {/* Video element */}
      {src ? (
        <video
          ref={videoRef}
          className="hero-video__video"
          poster={poster}
          muted
          playsInline
          preload="metadata"
          onLoadedMetadata={(e) => {
            setDuration((e.target as HTMLVideoElement).duration);
            setIsLoaded(true);
          }}
          onTimeUpdate={(e) => setCurrentTime((e.target as HTMLVideoElement).currentTime)}
          onEnded={() => { setIsPlaying(false); setShowControls(true); }}
          aria-label={title}
        >
          <source src={src} type="video/mp4" />
        </video>
      ) : (
        /* Placeholder when no video src */
        <div className="hero-video__placeholder" aria-label={title}>
          <img
            src={poster ?? '/images/hero-poster.svg'}
            alt={title}
            className="hero-video__poster"
          />
        </div>
      )}

      {/* Click-to-play overlay (only when paused) */}
      {!isPlaying && (
        <button
          className="hero-video__play-overlay"
          onClick={togglePlay}
          aria-label="Play video"
        >
          <span className="hero-video__play-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5,3 19,12 5,21" />
            </svg>
          </span>
        </button>
      )}

      {/* Controls bar */}
      <div className="hero-video__controls" role="group" aria-label="Video controls">
        {/* Seek bar */}
        <div
          ref={seekBarRef}
          className="hero-video__seek"
          onClick={handleSeek}
          role="slider"
          aria-label="Seek"
          aria-valuenow={Math.floor(currentTime)}
          aria-valuemin={0}
          aria-valuemax={Math.floor(duration)}
          tabIndex={0}
          onKeyDown={(e) => {
            const v = videoRef.current;
            if (!v) return;
            if (e.key === 'ArrowRight') v.currentTime = Math.min(duration, v.currentTime + 5);
            if (e.key === 'ArrowLeft') v.currentTime = Math.max(0, v.currentTime - 5);
          }}
        >
          <div className="hero-video__seek-track">
            <div className="hero-video__seek-fill" style={{ width: `${progress}%` }} />
            <div className="hero-video__seek-thumb" style={{ left: `${progress}%` }} />
          </div>
        </div>

        <div className="hero-video__controls-row">
          {/* Play/Pause */}
          <button
            className="hero-video__btn"
            onClick={togglePlay}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="4" width="4" height="16" />
                <rect x="14" y="4" width="4" height="16" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5,3 19,12 5,21" />
              </svg>
            )}
          </button>

          {/* Time display */}
          <span className="hero-video__time">
            {formatTime(currentTime)}
            <span className="hero-video__time-sep"> / </span>
            {formatTime(duration)}
          </span>

          <div className="hero-video__controls-spacer" />

          {/* Mute toggle */}
          <button
            className="hero-video__btn"
            onClick={toggleMute}
            aria-label={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="11,5 6,9 2,9 2,15 6,15 11,19" />
                <line x1="23" y1="9" x2="17" y2="15" />
                <line x1="17" y1="9" x2="23" y2="15" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="11,5 6,9 2,9 2,15 6,15 11,19" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
              </svg>
            )}
          </button>

          {/* Fullscreen */}
          <button
            className="hero-video__btn"
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {isFullscreen ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 3v3a2 2 0 0 1-2 2H3" />
                <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
                <path d="M3 16h3a2 2 0 0 1 2 2v3" />
                <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 3H5a2 2 0 0 0-2 2v3" />
                <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
                <path d="M3 16v3a2 2 0 0 0 2 2h3" />
                <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </section>
  );
}
