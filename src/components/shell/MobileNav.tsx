import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { Route } from './navigation';

interface MobileNavProps {
  open: boolean;
  activeRoute: Route;
  onClose: () => void;
  onNavigate: (route: Route) => void;
  onNavigateOverview: () => void;
}

export const MobileNav: React.FC<MobileNavProps> = ({
  open,
  activeRoute,
  onClose,
  onNavigate,
  onNavigateOverview
}) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (open) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <div
      className={`fixed inset-0 z-50 lg:hidden ${open ? '' : 'pointer-events-none'}`}
      aria-hidden={!open}
    >
      <div
        className={`absolute inset-0 bg-black/70 backdrop-blur-sm transition-opacity duration-200 ${
          open ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={onClose}
      />
      <div
        className={`absolute inset-y-0 left-0 w-[264px] border-r border-[#1E293B] shadow-2xl transition-transform duration-200 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <button
          onClick={onClose}
          aria-label="Close navigation"
          className="absolute -right-11 top-3 flex h-8 w-8 items-center justify-center rounded-[9px] border border-[#273449] bg-[#172238] text-slate-300"
        >
          <X className="h-4 w-4" />
        </button>
        <Sidebar
          activeRoute={activeRoute}
          onNavigate={(r) => {
            onNavigate(r);
            onClose();
          }}
          onNavigateOverview={() => {
            onNavigateOverview();
            onClose();
          }}
        />
      </div>
    </div>
  );
};
