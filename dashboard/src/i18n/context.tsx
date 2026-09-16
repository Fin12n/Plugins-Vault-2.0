import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { en, type I18nDictionary } from './en.js';
import { setActiveLanguage, vi } from './vi.js';

export type Language = 'vi' | 'en';

type I18nContextType = {
  lang: Language;
  setLang: (lang: Language) => void;
  t: I18nDictionary;
};

const I18nContext = createContext<I18nContextType>({
  lang: 'vi',
  setLang: () => {},
  t: vi,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Language>(() => {
    try {
      const saved = localStorage.getItem('dashboard-lang') as Language | null;
      const initial = saved === 'en' || saved === 'vi' ? saved : 'vi';
      setActiveLanguage(initial);
      return initial;
    } catch {
      setActiveLanguage('vi');
      return 'vi';
    }
  });

  const setLang = (newLang: Language) => {
    setActiveLanguage(newLang);
    setLangState(newLang);
    try {
      localStorage.setItem('dashboard-lang', newLang);
      document.documentElement.lang = newLang;
    } catch {}
  };

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const dictionary = lang === 'en' ? en : vi;

  return (
    <I18nContext.Provider value={{ lang, setLang, t: dictionary }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
