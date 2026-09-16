import { Zap } from 'lucide-react';
import { useI18n } from '../i18n/context.js';

export function LoadingScreen() {
  const { lang } = useI18n();

  return (
    <div className="loading-screen" role="alert" aria-busy="true">
      <div className="loading-card">
        <div className="loading-logo-wrap">
          <div className="loading-mark">
            <Zap size={28} />
          </div>
          <div className="loading-glow" />
        </div>
        <div className="loading-info">
          <h3 className="loading-title">Kho Plugin · EZStore</h3>
          <p className="loading-subtitle">
            {lang === 'vi' ? 'Đang khởi tạo hệ thống…' : 'Initializing system…'}
          </p>
        </div>
        <div className="loading-bar-track">
          <div className="loading-bar-fill" />
        </div>
      </div>
    </div>
  );
}
