import { useState, type FormEvent } from 'react';
import type { Locale } from '@/i18n';
import './SearchBar.css';

interface SearchBarProps {
  locale: Locale;
  placeholder: string;
}

export default function SearchBar({ locale, placeholder }: SearchBarProps) {
  const [query, setQuery] = useState('');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (query.trim()) {
      const basePath = locale === 'en' ? '/en' : '';
      window.location.href = `${basePath}/search?q=${encodeURIComponent(query.trim())}`;
    }
  }

  return (
    <form className="search-bar" onSubmit={handleSubmit} role="search">
      <input
        className="search-bar__input"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
      <button className="search-bar__btn" type="submit" aria-label="Search">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
      </button>
    </form>
  );
}
