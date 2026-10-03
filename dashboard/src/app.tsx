import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import './styles.css';
import {
  BarChart3,
  ClipboardCheck,
  Clock,
  Crown,
  Eye,
  EyeOff,
  Languages,
  LayoutDashboard,
  LogOut,
  Moon,
  Package,
  ScrollText,
  Settings,
  ShieldCheck,
  Sun,
  Tag,
  Trophy,
  UploadCloud,
  UserCheck,
  Wallet,
  Zap,
} from 'lucide-react';
import { ToastProvider, useToast } from './components/toast.js';
import { I18nProvider, useI18n } from './i18n/context.js';
import { LoadingScreen } from './components/loading-screen.js';
import { ThemeToggle, LanguageToggle } from './components/theme-lang-toggles.js';
import logoMark from './assets/ez-mark.png';
import logoFull from './assets/ez-studio.png';
import { api, ApiError, SESSION_EXPIRED_EVENT, type SessionResponse, type SessionUser } from './lib/api-client.js';
import { UserContext } from './lib/user-context.js';
import { ThemeProvider, useTheme } from './lib/theme-context.js';
import { useHashRoute } from './lib/use-hash-route.js';
import { LeaderboardPage } from './pages/leaderboard-page.js';
import { LogPage } from './pages/log-page.js';
import { OrdersPage } from './pages/orders-page.js';
import { OverviewPage } from './pages/overview-page.js';
import { PendingPage } from './pages/pending-page.js';
import { PluginsPage } from './pages/plugins-page.js';
import { SettingsPage } from './pages/settings-page.js';
import { SpigotAccountsPage } from './pages/spigot-accounts-page.js';
import { StatsPage } from './pages/stats-page.js';
import { UploadPage } from './pages/upload-page.js';
import { WalletPage } from './pages/wallet-page.js';
import { DiscountsPage } from './pages/discounts-page.js';

function DiscordMiniIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 127.14 96.36" fill="currentColor" style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}>
      <path d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,45.91,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,45.91,96.12,53,91.08,65.69,84.69,65.69Z" />
    </svg>
  );
}

const TABS = ['overview', 'upload', 'plugins', 'pending', 'spigot', 'orders', 'wallet', 'stats', 'leaderboard', 'discounts', 'log', 'settings'] as const;
type Tab = (typeof TABS)[number];

const TAB_ICONS: Record<Tab, React.ComponentType<{ className?: string }>> = {
  overview: LayoutDashboard,
  upload: UploadCloud,
  plugins: Package,
  pending: Clock,
  spigot: UserCheck,
  orders: ClipboardCheck,
  wallet: Wallet,
  stats: BarChart3,
  leaderboard: Trophy,
  discounts: Tag,
  log: ScrollText,
  settings: Settings,
};

const PAGES: Record<Tab, () => React.ReactElement> = {
  overview: OverviewPage,
  upload: UploadPage,
  plugins: PluginsPage,
  pending: PendingPage,
  spigot: SpigotAccountsPage,
  orders: OrdersPage,
  wallet: WalletPage,
  stats: StatsPage,
  leaderboard: LeaderboardPage,
  discounts: DiscountsPage,
  log: LogPage,
  settings: SettingsPage,
};

export function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <I18nProvider>
          <ToastProvider>
            <AuthGate />
          </ToastProvider>
        </I18nProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { message: string | null }> {
  state = { message: null as string | null };

  static getDerivedStateFromError(error: unknown): { message: string } {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Lỗi giao diện:', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.message === null) return this.props.children;
    return (
      <div className="login-wrap">
        <div className="panel login-card" role="alert">
          <h2>Giao diện gặp lỗi</h2>
          <p className="muted">{this.state.message}</p>
          <p className="hint">Tải lại trang là đủ trong hầu hết trường hợp. Dữ liệu trong kho không bị ảnh hưởng.</p>
          <button className="primary" style={{ width: '100%', marginTop: 16 }} onClick={() => window.location.reload()}>
            Tải lại trang
          </button>
        </div>
      </div>
    );
  }
}

function AuthGate() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [expired, setExpired] = useState(false);
  const everAuthed = useRef(false);

  const checkSession = async () => {
    try {
      const res = await api.get<SessionResponse>('/api/session');
      everAuthed.current = true;
      setUser(res.user);
      setAuthed(true);
    } catch {
      setUser(null);
      setAuthed(false);
    }
  };

  useEffect(() => {
    void checkSession();
  }, []);

  useEffect(() => {
    const onExpired = (): void => {
      setAuthed(false);
      setUser(null);
      if (everAuthed.current) setExpired(true);
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  if (authed === null) {
    return <LoadingScreen />;
  }
  if (!authed) {
    return (
      <LoginScreen
        expired={expired}
        onSuccess={() => {
          void checkSession();
          setExpired(false);
        }}
      />
    );
  }
  return (
    <UserContext.Provider value={user}>
      <Shell user={user} onSignedOut={() => { setUser(null); setAuthed(false); }} />
    </UserContext.Provider>
  );
}

function Shell({ user, onSignedOut }: { user: SessionUser | null; onSignedOut: () => void }) {
  const [tab, setTab] = useHashRoute<Tab>(TABS, 'overview');
  const { t, lang } = useI18n();
  const toast = useToast();
  const Page = PAGES[tab];

  const displayName = (user?.displayName || user?.username || (user?.role === 'owner' ? 'Chủ sở hữu' : 'Staff')).trim();
  const initialLetter = displayName.charAt(0).toUpperCase() || (user?.role === 'owner' ? 'C' : 'S');

  const NAV_GROUPS: { label: string; items: { key: Tab; label: string }[] }[] = [
    {
      label: lang === 'vi' ? 'Tổng quan' : 'Overview',
      items: [
        { key: 'overview', label: t.nav.overview },
      ],
    },
    {
      label: lang === 'vi' ? 'Kho' : 'Vault',
      items: [
        { key: 'upload', label: t.nav.upload },
        { key: 'plugins', label: t.nav.plugins },
        { key: 'pending', label: t.nav.pending },
      ],
    },
    {
      label: 'Spigot',
      items: [{ key: 'spigot', label: t.nav.spigot }],
    },
    {
      label: lang === 'vi' ? 'Tài chính' : 'Finance',
      items: [
        { key: 'orders', label: t.nav.orders },
        { key: 'wallet', label: t.nav.wallet },
        { key: 'stats', label: t.nav.stats },
        { key: 'leaderboard', label: t.nav.leaderboard },
        { key: 'discounts', label: t.nav.discounts },
      ],
    },
    {
      label: lang === 'vi' ? 'Hệ thống' : 'System',
      items: [
        { key: 'log', label: t.nav.log },
        { key: 'settings', label: t.nav.settings },
      ],
    },
  ];

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        {lang === 'vi' ? 'Tới nội dung' : 'Skip to main content'}
      </a>

      <aside className="sidebar">
        <h1 className="sidebar-brand" style={{ cursor: 'pointer' }} onClick={() => setTab('overview')} title="EZ Studio · Kho Plugin">
          <div className="brand-logo-wrap" aria-hidden="true">
            <img src={logoMark} alt="EZ Studio Logo" className="brand-logo-img" />
          </div>
          <div className="sidebar-brand-text">
            <span className="sidebar-brand-title">{t.appTitle}</span>
            <span className="sidebar-brand-subtitle">EZ Studio</span>
          </div>
        </h1>

        <nav aria-label="Điều hướng chính">
          {NAV_GROUPS.map((group) => (
            <div key={group.label}>
              <p className="nav-label">{group.label}</p>
              {group.items.map((item) => {
                const Icon = TAB_ICONS[item.key];
                return (
                  <button
                    key={item.key}
                    type="button"
                    aria-current={tab === item.key ? 'page' : undefined}
                    onClick={() => setTab(item.key)}
                  >
                    <Icon className="nav-icon" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          {/* User Profile Capsule (UI/UX Pro Max) */}
          {user && (
            <div
              className={`sidebar-user-capsule ${user.role === 'owner' ? 'is-owner' : 'is-staff'}`}
              title={`Đăng nhập qua ${user.authMethod === 'discord' ? 'Discord' : 'Mật khẩu'}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 11,
                padding: '9px 11px',
                width: '100%',
                boxSizing: 'border-box',
                overflow: 'hidden',
              }}
            >
              <div
                className={`user-capsule-avatar-wrap ${user.role === 'owner' ? 'owner-frame' : 'staff-frame'}`}
                style={{
                  position: 'relative',
                  width: 40,
                  height: 40,
                  minWidth: 40,
                  maxWidth: 40,
                  minHeight: 40,
                  maxHeight: 40,
                  flexShrink: 0,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxSizing: 'border-box',
                }}
              >
                {user.avatar ? (
                  <img
                    src={user.avatar}
                    alt={displayName}
                    className="user-capsule-avatar"
                    style={{
                      width: '100%',
                      height: '100%',
                      maxWidth: 36,
                      maxHeight: 36,
                      borderRadius: '50%',
                      objectFit: 'cover',
                      display: 'block',
                      flexShrink: 0,
                      backgroundColor: '#0f172a',
                    }}
                    onError={(e) => {
                      (e.currentTarget as HTMLElement).style.display = 'none';
                      const fallback = e.currentTarget.parentElement?.querySelector('.user-capsule-fallback') as HTMLElement | null;
                      if (fallback) fallback.style.display = 'flex';
                    }}
                  />
                ) : null}
                <div
                  className="user-capsule-fallback"
                  style={{
                    display: user.avatar ? 'none' : 'flex',
                    width: '100%',
                    height: '100%',
                    borderRadius: '50%',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {initialLetter}
                </div>
                <span className="user-online-dot" />
              </div>

              <div
                className="user-capsule-info"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  gap: 3,
                  minWidth: 0,
                  flex: 1,
                  overflow: 'hidden',
                }}
              >
                <span
                  className="user-capsule-name"
                  title={displayName}
                  style={{
                    fontSize: 13,
                    fontWeight: 750,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    display: 'block',
                    width: '100%',
                    lineHeight: 1.25,
                  }}
                >
                  {displayName}
                </span>
                <div
                  className="user-capsule-role-row"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    flexWrap: 'nowrap',
                    overflow: 'hidden',
                  }}
                >
                  <span className={`user-capsule-role ${user.role === 'owner' ? 'owner' : 'staff'}`}>
                    {user.role === 'owner' ? <Crown size={11} className="role-icon" /> : <ShieldCheck size={11} className="role-icon" />}
                    <span>{user.role === 'owner' ? (lang === 'vi' ? 'Chủ sở hữu' : 'Owner') : 'Staff'}</span>
                  </span>
                  {user.authMethod === 'discord' && (
                    <span className="user-auth-badge" title="Đã đăng nhập qua Discord">
                      <DiscordMiniIcon />
                      <span>Discord</span>
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Neumorphic Toggle Switchers */}
          <div className="sidebar-toggles">
            <ThemeToggle />
            <LanguageToggle />
          </div>

          <button
            type="button"
            className="sidebar-logout-btn"
            onClick={() => {
              void api
                .post('/api/logout')
                .then(onSignedOut)
                .catch(() => toast.error(lang === 'vi' ? 'Không đăng xuất được — thử lại' : 'Logout failed — try again'));
            }}
          >
            <LogOut size={16} />
            <span>{t.nav.logout}</span>
          </button>
        </div>
      </aside>

      {/* Animated Top Progress Bar on route change */}
      <div key={tab} className="top-route-bar" aria-hidden="true" />

      <main className="content page-enter" id="main" key={`${tab}-${lang}`}>
        <Page />
      </main>
    </div>
  );
}

function LoginScreen({ expired, onSuccess }: { expired: boolean; onSuccess: () => void }) {
  const { t, lang, setLang } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const errParam = params.get('error');
    if (errParam) {
      if (errParam === 'unauthorized') {
        setError(
          lang === 'vi'
            ? 'Tài khoản Discord không có quyền truy cập Dashboard. Vui lòng liên hệ Chủ sở hữu.'
            : 'Discord account is not authorized to access the Dashboard. Please contact the Owner.',
        );
      } else if (errParam === 'missing_secret') {
        setError(
          lang === 'vi'
            ? 'Máy chủ chưa cấu hình DISCORD_CLIENT_SECRET. Hãy kiểm tra file .env.'
            : 'DISCORD_CLIENT_SECRET is not configured on the server.',
        );
      } else if (errParam === 'invalid_state') {
        setError(
          lang === 'vi'
            ? 'Phiên đăng nhập Discord không hợp lệ hoặc đã hết hạn. Vui lòng thử lại.'
            : 'Discord login state expired or invalid. Please try again.',
        );
      } else {
        setError(
          lang === 'vi'
            ? `Lỗi đăng nhập Discord (${errParam}). Vui lòng thử lại.`
            : `Discord login failed (${errParam}). Please try again.`,
        );
      }
      window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
    }
  }, [lang]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/login', { password });
      onSuccess();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) setError(t.login.rateLimited);
      else if (err instanceof ApiError && err.status === 0) setError(err.message);
      else if (err instanceof ApiError && err.status >= 500) setError(lang === 'vi' ? 'Máy chủ đang lỗi — thử lại sau' : 'Server error — try again later');
      else setError(t.login.wrong);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="panel login-card" onSubmit={submit}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginBottom: '20px' }}>
          <div
            className="login-toggle-pill"
            onClick={toggleTheme}
            role="button"
            tabIndex={0}
            title={theme === 'dark' ? 'Switch to Light' : 'Switch to Dark'}
            onKeyDown={(e) => {
              if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                toggleTheme();
              }
            }}
          >
            {theme === 'dark' ? <Moon size={14} /> : <Sun size={14} />}
            <span>{theme === 'dark' ? 'Dark' : 'Light'}</span>
            <div className={`pill-switch pill-switch-sm ${theme === 'dark' ? 'checked' : 'unchecked'}`} aria-hidden="true">
              <div className="pill-switch-track">
                <div className="pill-switch-thumb" />
              </div>
            </div>
          </div>

          <div
            className="login-toggle-pill"
            onClick={() => setLang(lang === 'vi' ? 'en' : 'vi')}
            role="button"
            tabIndex={0}
            title={lang === 'vi' ? 'Switch to English' : 'Chuyển sang Tiếng Việt'}
            onKeyDown={(e) => {
              if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                setLang(lang === 'vi' ? 'en' : 'vi');
              }
            }}
          >
            <Languages size={14} />
            <span>{lang.toUpperCase()}</span>
            <div className={`pill-switch pill-switch-sm ${lang === 'en' ? 'checked' : 'unchecked'}`} aria-hidden="true">
              <div className="pill-switch-track">
                <div className="pill-switch-thumb" />
              </div>
            </div>
          </div>
        </div>

        <div className="login-brand-header">
          <div className="login-logo-wrap" aria-hidden="true">
            <img src={logoFull} alt="EZ Studio Logo" className="login-logo-img" />
          </div>
          <h2 className="login-brand-title">{t.appTitle}</h2>
          <div className="login-brand-sub">EZ Studio · Minecraft Plugins Vault</div>
        </div>

        {/* Discord OAuth2 Button */}
        <a href="/api/auth/discord/login" className="btn-discord-login">
          <svg className="discord-logo-svg" viewBox="0 0 127.14 96.36" fill="currentColor">
            <path d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,45.91,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,45.91,96.12,53,91.08,65.69,84.69,65.69Z" />
          </svg>
          <span>{lang === 'vi' ? 'Đăng nhập với Discord' : 'Sign in with Discord'}</span>
        </a>

        <div className="login-divider">
          <span>{lang === 'vi' ? 'HOẶC DÙNG MẬT KHẨU' : 'OR USE PASSWORD'}</span>
        </div>

        <label htmlFor="dashboard-password">
          <span>{t.login.password}</span>
          <div className="login-password-field">
            <input
              id="dashboard-password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              autoComplete="current-password"
              aria-invalid={error !== null}
              placeholder={lang === 'vi' ? 'Nhập mật khẩu truy cập...' : 'Enter master password...'}
            />
            <button
              type="button"
              className="login-password-toggle-btn"
              onClick={() => setShowPassword(!showPassword)}
              title={showPassword ? (lang === 'vi' ? 'Ẩn mật khẩu' : 'Hide password') : (lang === 'vi' ? 'Hiện mật khẩu' : 'Show password')}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              tabIndex={-1}
            >
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
        </label>
        {expired && (
          <p className="hint" style={{ marginTop: -6, marginBottom: 16 }}>
            {lang === 'vi'
              ? 'Phiên trước đã hết hạn nên dashboard đăng xuất. Dữ liệu không bị ảnh hưởng.'
              : 'Session expired. Dashboard has logged out automatically.'}
          </p>
        )}
        <button className="primary" type="submit" disabled={busy || password === ''} aria-busy={busy} style={{ width: '100%', marginTop: 8 }}>
          {t.login.submit}
        </button>
        {error && (
          <p className="error" role="alert" style={{ textAlign: 'center', marginTop: 12 }}>
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
