import React, { useState } from 'react';
import { useToast } from './toast.js';
import { UserProfile, CartItem } from '../lib/mock-store.js';

interface HeaderNavbarProps {
  currentMode: 'store' | 'admin';
  onSwitchMode: (mode: 'store' | 'admin') => void;
  activeStoreTab: string;
  onSelectStoreTab: (tab: string) => void;
  cartItems: CartItem[];
  onOpenCart: () => void;
  user: UserProfile | null;
  onOpenAuth: () => void;
  onOpenProfile: () => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
}

export function HeaderNavbar({
  currentMode,
  onSwitchMode,
  activeStoreTab,
  onSelectStoreTab,
  cartItems,
  onOpenCart,
  user,
  onOpenAuth,
  onOpenProfile,
  searchQuery,
  onSearchChange,
}: HeaderNavbarProps) {
  const toast = useToast();
  const totalCartQuantity = cartItems.reduce((acc, item) => acc + item.quantity, 0);

  return (
    <header className="ez-header">
      {/* Brand & Mode Switcher */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
        <div className="ez-brand-group" onClick={() => onSelectStoreTab('home')}>
          <div className="ez-brand-icon">⚡</div>
          <span className="ez-brand-text" style={{ fontSize: '20px' }}>EZStore</span>
        </div>

        {/* Client Storefront <-> Admin Dashboard Switcher */}
        <div className="ez-mode-toggle">
          <button
            type="button"
            className={`ez-mode-btn ${currentMode === 'store' ? 'active' : ''}`}
            onClick={() => onSwitchMode('store')}
            title="Xem giao diện Khách hàng mua sắm"
          >
            <span>🛒 Storefront</span>
          </button>
          <button
            type="button"
            className={`ez-mode-btn ${currentMode === 'admin' ? 'active' : ''}`}
            onClick={() => onSwitchMode('admin')}
            title="Chuyển sang Bảng điều khiển Quản trị"
          >
            <span>⚙️ Admin Panel</span>
          </button>
        </div>
      </div>

      {/* Navigation Links for Storefront */}
      {currentMode === 'store' && (
        <nav className="ez-nav-links">
          <button
            type="button"
            className={`ez-nav-item ${activeStoreTab === 'home' ? 'active' : ''}`}
            onClick={() => onSelectStoreTab('home')}
          >
            Trang Chủ
          </button>
          <button
            type="button"
            className={`ez-nav-item ${activeStoreTab === 'shop' ? 'active' : ''}`}
            onClick={() => onSelectStoreTab('shop')}
          >
            Kho Plugin (Shop)
          </button>
          <button
            type="button"
            className={`ez-nav-item ${activeStoreTab === 'services' ? 'active' : ''}`}
            onClick={() => onSelectStoreTab('services')}
          >
            Dịch Vụ Máy Chủ
          </button>
          <button
            type="button"
            className={`ez-nav-item ${activeStoreTab === 'profile' ? 'active' : ''}`}
            onClick={() => onSelectStoreTab('profile')}
          >
            Tủ Đồ & Giftcode
          </button>
        </nav>
      )}

      {/* Header Actions: Search Quick bar, Cart, Auth */}
      <div className="ez-header-actions">
        {/* Cart Button */}
        <button type="button" className="ez-cart-btn" onClick={onOpenCart} title="Mở giỏ hàng">
          <span>🛒</span>
          <span>Giỏ hàng</span>
          {totalCartQuantity > 0 && <span className="ez-cart-badge">{totalCartQuantity}</span>}
        </button>

        {/* User Auth Pill */}
        {user ? (
          <div className="ez-user-pill" onClick={onOpenProfile} title="Xem trang cá nhân & tủ đồ">
            <img src={user.avatar} alt={user.displayName || user.username || 'User'} className="ez-user-avatar" />
            <div style={{ display: 'flex', flexDirection: 'column', textAlign: 'left', lineHeight: '1.2' }}>
              <span style={{ fontSize: '13px', fontWeight: '700', color: '#fff' }}>{user.displayName || user.username || 'User'}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span className="ez-vip-gold-pill">👑 {user.vipRank}</span>
                <span style={{ fontSize: '11px', color: '#10b981' }}>● Online</span>
              </div>
            </div>
          </div>
        ) : (
          <button type="button" className="ez-discord-login-btn" onClick={onOpenAuth}>
            <span>👾</span>
            <span>Đăng nhập Discord</span>
          </button>
        )}
      </div>
    </header>
  );
}
