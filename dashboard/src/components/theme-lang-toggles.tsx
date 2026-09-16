import { Sun, Moon, Languages } from 'lucide-react';
import { useI18n } from '../i18n/context.js';
import { useTheme } from '../lib/theme-context.js';

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const { lang } = useI18n();
  const isDark = theme === 'dark';

  return (
    <div
      className="sidebar-toggle-row"
      onClick={toggleTheme}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          toggleTheme();
        }
      }}
      title={isDark ? (lang === 'vi' ? 'Chuyển sang Giao diện Sáng' : 'Switch to Light Theme') : (lang === 'vi' ? 'Chuyển sang Giao diện Tối' : 'Switch to Dark Theme')}
      aria-label={isDark ? 'Dark Theme active' : 'Light Theme active'}
    >
      <div className="sidebar-toggle-info">
        {isDark ? <Moon size={16} className="sidebar-toggle-icon" /> : <Sun size={16} className="sidebar-toggle-icon" />}
        <span className="sidebar-toggle-text">
          {isDark ? (lang === 'vi' ? 'Giao diện Tối' : 'Dark Theme') : (lang === 'vi' ? 'Giao diện Sáng' : 'Light Theme')}
        </span>
      </div>

      <div className={`pill-switch ${isDark ? 'checked' : 'unchecked'}`} aria-hidden="true">
        <div className="pill-switch-track">
          <div className="pill-switch-thumb" />
        </div>
      </div>
    </div>
  );
}

export function LanguageToggle() {
  const { lang, setLang } = useI18n();
  const isEn = lang === 'en';

  const toggleLang = () => setLang(isEn ? 'vi' : 'en');

  return (
    <div
      className="sidebar-toggle-row"
      onClick={toggleLang}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          toggleLang();
        }
      }}
      title={lang === 'vi' ? 'Switch to English' : 'Chuyển sang Tiếng Việt'}
      aria-label={isEn ? 'English active' : 'Vietnamese active'}
    >
      <div className="sidebar-toggle-info">
        <Languages size={16} className="sidebar-toggle-icon" />
        <span className="sidebar-toggle-text">
          {isEn ? 'English (EN)' : 'Tiếng Việt (VI)'}
        </span>
      </div>

      <div className={`pill-switch ${isEn ? 'checked' : 'unchecked'}`} aria-hidden="true">
        <div className="pill-switch-track">
          <div className="pill-switch-thumb" />
        </div>
      </div>
    </div>
  );
}

export function PillSwitchButton({
  checked,
  onChange,
  ariaLabel,
  size = 'md',
}: {
  checked: boolean;
  onChange: () => void;
  ariaLabel: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div
      className={`pill-switch ${size === 'sm' ? 'pill-switch-sm' : ''} ${checked ? 'checked' : 'unchecked'}`}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          onChange();
        }
      }}
    >
      <div className="pill-switch-track">
        <div className="pill-switch-thumb" />
      </div>
    </div>
  );
}

export { PillSwitchButton as PillSwitch };
