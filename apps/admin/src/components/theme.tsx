'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { cn } from '@flt/ui';

/**
 * Theme handling.
 *
 * Three states, not two: light, dark, and following the operating system. The
 * third is the default, because someone who has set their machine to switch at
 * sunset has already expressed a preference and we should not override it.
 */

type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'flt-admin-theme';

/**
 * Applies the stored theme before first paint.
 *
 * Inlined into <head> deliberately: run any later and a dark-mode user gets a
 * white flash on every navigation. `suppressHydrationWarning` on <html> covers
 * the attribute this adds before React hydrates.
 */
export function ThemeScript() {
  const script = `
    (function () {
      try {
        var stored = localStorage.getItem('${STORAGE_KEY}');
        var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        var theme = stored === 'light' || stored === 'dark' ? stored : (prefersDark ? 'dark' : 'light');
        document.documentElement.setAttribute('data-theme', theme);
      } catch (e) {
        document.documentElement.setAttribute('data-theme', 'light');
      }
    })();
  `;

  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}

function applyTheme(theme: Theme): void {
  const resolved =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;

  document.documentElement.setAttribute('data-theme', resolved);
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>('system');

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    setThemeState(stored === 'light' || stored === 'dark' ? stored : 'system');
  }, []);

  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'system') return;

    // Follow the system in real time while set to "system", so the interface
    // changes with the OS rather than only on reload.
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    if (next === 'system') {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, next);
    }
  }, []);

  return { theme, setTheme };
}

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const options: { value: Theme; icon: typeof Sun; label: string }[] = [
    { value: 'light', icon: Sun, label: 'Light' },
    { value: 'dark', icon: Moon, label: 'Dark' },
    { value: 'system', icon: Monitor, label: 'System' },
  ];

  return (
    <div
      className={cn(
        'inline-flex items-center gap-0.5 rounded-[var(--radius-md)]',
        'border border-[var(--border)] bg-[var(--surface-sunken)] p-0.5',
        className,
      )}
      role="group"
      aria-label="Colour theme"
    >
      {options.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          type="button"
          onClick={() => setTheme(value)}
          // Before mount the stored value is unknown, so nothing is marked
          // active rather than briefly marking the wrong one.
          aria-pressed={mounted ? theme === value : false}
          title={label}
          className={cn(
            'rounded-[var(--radius-sm)] p-1.5 transition-colors',
            mounted && theme === value
              ? 'bg-[var(--surface-raised)] text-[var(--text)] shadow-[var(--shadow-sm)]'
              : 'text-[var(--text-subtle)] hover:text-[var(--text)]',
          )}
        >
          <Icon className="size-3.5" />
          <span className="sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
}
