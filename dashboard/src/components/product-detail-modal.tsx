import React, { useState } from 'react';
import { PluginItem, formatVnd } from '../lib/mock-store.js';

interface ProductDetailModalProps {
  plugin: PluginItem | null;
  onClose: () => void;
  onAddToCart: (plugin: PluginItem) => void;
  onBuyNow: (plugin: PluginItem) => void;
}

export function ProductDetailModal({
  plugin,
  onClose,
  onAddToCart,
  onBuyNow,
}: ProductDetailModalProps) {
  const [activeTab, setActiveTab] = useState<'overview' | 'changelog' | 'dependencies'>('overview');

  if (!plugin) return null;

  return (
    <div className="ez-modal-backdrop" onClick={onClose}>
      <div className="ez-modal-panel" onClick={(e) => e.stopPropagation()}>
        {/* Modal Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div className="ez-product-icon" style={{ width: '56px', height: '56px', fontSize: '32px' }}>
              {plugin.icon}
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <h2 style={{ fontSize: '22px', fontWeight: '800', margin: 0, color: '#fff' }}>{plugin.name}</h2>
                {plugin.badge && <span className="ez-bento-badge" style={{ position: 'static' }}>{plugin.badge}</span>}
              </div>
              <p style={{ margin: '4px 0 0', color: '#94a3b8', fontSize: '14px' }}>
                Phát triển bởi <strong style={{ color: '#06b6d4' }}>{plugin.author}</strong> • Dung lượng: {plugin.fileSize}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'rgba(255,255,255,0.06)', border: 'none', color: '#94a3b8', width: '36px', height: '36px', borderRadius: '50%', cursor: 'pointer', fontSize: '18px' }}
          >
            ✕
          </button>
        </div>

        {/* Tab Buttons */}
        <div style={{ display: 'flex', gap: '8px', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '12px', marginBottom: '20px' }}>
          <button
            type="button"
            className={`ez-nav-item ${activeTab === 'overview' ? 'active' : ''}`}
            onClick={() => setActiveTab('overview')}
          >
            📖 Tổng quan
          </button>
          <button
            type="button"
            className={`ez-nav-item ${activeTab === 'changelog' ? 'active' : ''}`}
            onClick={() => setActiveTab('changelog')}
          >
            📜 Lịch sử phiên bản ({plugin.changelog.length})
          </button>
          <button
            type="button"
            className={`ez-nav-item ${activeTab === 'dependencies' ? 'active' : ''}`}
            onClick={() => setActiveTab('dependencies')}
          >
            🔗 Phụ thuộc ({plugin.dependencies.length})
          </button>
        </div>

        {/* Tab Content */}
        <div style={{ minHeight: '180px', marginBottom: '24px' }}>
          {activeTab === 'overview' && (
            <div>
              <p style={{ fontSize: '15px', lineHeight: '1.6', color: '#cbd5e1', marginBottom: '16px' }}>
                {plugin.description}
              </p>
              
              <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '12px', padding: '16px', marginBottom: '16px' }}>
                <h4 style={{ margin: '0 0 10px', fontSize: '14px', color: '#10b981' }}>✨ Tính năng & Thông số kỹ thuật:</h4>
                <ul style={{ margin: 0, paddingLeft: '20px', color: '#94a3b8', fontSize: '13px', lineHeight: '1.7' }}>
                  <li>Phiên bản chuẩn gốc Spigot: <strong>{plugin.nativeVersion}</strong></li>
                  <li>Hỗ trợ tương thích đa phiên bản: {plugin.versions.join(', ')}</li>
                  <li>Hỗ trợ Folia đa luồng & Paper/Purpur mới nhất</li>
                  <li>Tự động kích hoạt bản quyền Instant Key sau khi thanh toán</li>
                </ul>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '16px', color: '#94a3b8', fontSize: '13px' }}>
                <span>⭐ <strong>{plugin.rating}</strong> / 5.0 ({plugin.reviewCount} đánh giá)</span>
                <span>📥 <strong>{plugin.downloads.toLocaleString()}</strong> lượt tải</span>
                <span>🛡️ Đã quét Virus & Trojan 100% Clean</span>
              </div>
            </div>
          )}

          {activeTab === 'changelog' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {plugin.changelog.map((item, idx) => (
                <div key={idx} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '10px', padding: '14px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <strong style={{ color: '#06b6d4' }}>v{item.version}</strong>
                    <span style={{ fontSize: '12px', color: '#64748b' }}>{item.date}</span>
                  </div>
                  <ul style={{ margin: 0, paddingLeft: '18px', color: '#cbd5e1', fontSize: '13px' }}>
                    {item.notes.map((n, i) => <li key={i}>{n}</li>)}
                  </ul>
                </div>
              ))}
            </div>
          )}

          {activeTab === 'dependencies' && (
            <div>
              <p style={{ color: '#94a3b8', fontSize: '14px', marginBottom: '12px' }}>
                Các plugin và thư viện bắt buộc / khuyên dùng để hoạt động trơn tru:
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {plugin.dependencies.length > 0 ? (
                  plugin.dependencies.map((dep, idx) => (
                    <span key={idx} style={{ padding: '6px 14px', borderRadius: '8px', background: 'rgba(16, 185, 129, 0.1)', color: '#10b981', border: '1px solid rgba(16, 185, 129, 0.3)', fontSize: '13px', fontWeight: '600' }}>
                      📦 {dep}
                    </span>
                  ))
                ) : (
                  <span style={{ color: '#10b981' }}>✅ Không yêu cầu plugin phụ thuộc (Standalone).</span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer / Actions */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: '16px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <div>
            <span style={{ fontSize: '12px', color: '#94a3b8', display: 'block' }}>Giá thanh toán:</span>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
              <span style={{ fontSize: '24px', fontWeight: '900', color: '#10b981' }}>{formatVnd(plugin.priceVnd)}</span>
              {plugin.originalPriceVnd && (
                <span style={{ fontSize: '14px', color: '#64748b', textDecoration: 'line-through' }}>
                  {formatVnd(plugin.originalPriceVnd)}
                </span>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', gap: '12px' }}>
            <button
              type="button"
              className="ez-btn-action"
              style={{ background: 'rgba(255,255,255,0.08)', color: '#fff' }}
              onClick={() => {
                onAddToCart(plugin);
                onClose();
              }}
            >
              🛒 Thêm vào giỏ
            </button>
            <button
              type="button"
              className="ez-btn-action"
              onClick={() => {
                onBuyNow(plugin);
                onClose();
              }}
            >
              ⚡ Mua Ngay
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
