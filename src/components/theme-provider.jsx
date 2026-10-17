import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

const ThemeContext = createContext(null);

const ACCENTS = [
  { id: 'neutral', label: '墨白 · 冷静' },
  { id: 'green', label: '苔绿 · 沉静' },
  { id: 'blue', label: '晴蓝 · 利落' },
  { id: 'orange', label: '琥珀 · 暖意' },
  { id: 'rose', label: '玫雾 · 柔和' },
];

const LOCALES = [
  { id: 'zh-CN', label: '简体中文' },
  { id: 'en', label: 'English' },
  { id: 'ja', label: '日本語' },
];

function withThemeTransition(apply) {
  if (typeof document !== 'undefined' && typeof document.startViewTransition === 'function') {
    document.startViewTransition(apply);
    return;
  }
  apply();
}

export function ThemeProvider({ children }) {
  const [mode, setMode] = useState(() => localStorage.getItem('daylight-mode') || 'light');
  const [accent, setAccent] = useState(() => localStorage.getItem('daylight-accent') || 'neutral');
  const [locale, setLocale] = useState(() => localStorage.getItem('daylight-locale') || 'zh-CN');

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('theme-ready');
    root.classList.toggle('dark', mode === 'dark');
    if (accent === 'neutral') delete root.dataset.accent;
    else root.dataset.accent = accent;
    localStorage.setItem('daylight-mode', mode);
    localStorage.setItem('daylight-accent', accent);
    localStorage.setItem('daylight-locale', locale);
    root.lang = locale;
  }, [mode, accent, locale]);

  const value = useMemo(() => ({
    mode,
    setMode,
    toggleMode: () => {
      withThemeTransition(() => setMode((current) => (current === 'dark' ? 'light' : 'dark')));
    },
    accent,
    setAccent: (next) => {
      withThemeTransition(() => setAccent(next));
    },
    accents: ACCENTS,
    locale,
    setLocale,
    locales: LOCALES,
  }), [mode, accent, locale]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used within ThemeProvider');
  return value;
}
