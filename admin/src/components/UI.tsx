import type { ReactNode } from 'react';
import { AlertTriangle, Inbox, Info, X } from 'lucide-react';
import { useToast, type Toast } from '../lib/hooks';

/* ================================ Card ================================= */

export function Card({
  title,
  subtitle,
  actions,
  children,
  tight,
  className = ''
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  tight?: boolean;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          <div className="grow">
            {title && <div className="card-title">{title}</div>}
            {subtitle && <div className="card-sub">{subtitle}</div>}
          </div>
          {actions}
        </header>
      )}
      <div className={tight ? 'card-body tight' : 'card-body'}>{children}</div>
    </section>
  );
}

/* =============================== StatCard ============================== */

export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = 'blue',
  unavailable
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: 'blue' | 'violet' | 'success' | 'warn' | 'danger';
  unavailable?: boolean;
}) {
  return (
    <div className="stat" data-tone={tone}>
      <div className="stat-label">
        {icon && <span className="stat-icon">{icon}</span>}
        {label}
      </div>
      <div className={`stat-value ${unavailable ? 'muted' : ''}`}>{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

/* ================================ Badge ================================ */

export function Badge({ children, tone = 'blue', dot }: { children: ReactNode; tone?: string; dot?: string }) {
  return (
    <span className={`badge ${tone}`}>
      {dot && <span className={`dot ${dot}`} />}
      {children}
    </span>
  );
}

/* ================================ Notice =============================== */

export function Notice({
  kind = 'info',
  children,
  icon
}: {
  kind?: 'info' | 'warn' | 'danger' | 'violet';
  children: ReactNode;
  icon?: ReactNode;
}) {
  const fallback = kind === 'danger' || kind === 'warn' ? <AlertTriangle size={16} /> : <Info size={16} />;
  return (
    <div className={`notice notice-${kind}`}>
      {icon ?? fallback}
      <div className="grow">{children}</div>
    </div>
  );
}

/* ================================ Empty ================================ */

export function Empty({
  title,
  children,
  icon
}: {
  title: string;
  children?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon ?? <Inbox size={22} />}</div>
      <div className="empty-title">{title}</div>
      {children && <div className="empty-text">{children}</div>}
    </div>
  );
}

/* ================================ Modal ================================ */

export function Modal({
  open,
  title,
  description,
  children,
  footer,
  onClose,
  wide
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className={`modal ${wide ? 'wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head row-between">
          <div>
            <div className="modal-title">{title}</div>
            {description && <div className="modal-desc">{description}</div>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {children && <div className="modal-body">{children}</div>}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ============================== Pagination ============================= */

export function Pagination({
  page,
  pageSize,
  total,
  totalPages,
  onPage
}: {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  onPage: (page: number) => void;
}) {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="pager">
      <span>
        {from}–{to} of {total}
      </span>
      <span className="spacer" />
      <button className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </button>
      <span className="mono small">
        {page} / {totalPages}
      </span>
      <button className="btn btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
        Next
      </button>
    </div>
  );
}

/* ================================ Toaster ============================== */

const TOAST_ICON: Record<Toast['kind'], ReactNode> = {
  success: <span className="dot dot-green" />,
  error: <span className="dot dot-red" />,
  info: <span className="dot dot-blue" />,
  warn: <span className="dot dot-amber" />
};

export function Toaster() {
  const { toasts, dismiss } = useToast();
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <div style={{ marginTop: 4 }}>{TOAST_ICON[t.kind]}</div>
          <div className="toast-body">
            <div className="toast-title">{t.title}</div>
            {t.message && <div className="toast-msg">{t.message}</div>}
          </div>
          <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

/* ================================ Spark =============================== */

export interface Point {
  label: string;
  value: number;
}

/**
 * Dependency-free line/area chart. Renders real series only; callers pass an
 * empty array (and render an Empty state) when there is no data.
 */
export function Sparkline({
  points,
  height = 140,
  showArea = true,
  formatValue
}: {
  points: Point[];
  height?: number;
  showArea?: boolean;
  formatValue?: (v: number) => string;
}) {
  if (points.length === 0) return null;
  const w = 600;
  const h = height;
  const padX = 8;
  const padY = 14;
  const values = points.map((p) => p.value);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const stepX = points.length > 1 ? (w - padX * 2) / (points.length - 1) : 0;

  const coords = points.map((p, i) => {
    const x = padX + i * stepX;
    const y = padY + (h - padY * 2) * (1 - (p.value - min) / span);
    return { x, y, ...p };
  });

  const line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const area = `${line} L${coords[coords.length - 1].x.toFixed(1)},${h - padY} L${coords[0].x.toFixed(1)},${h - padY} Z`;
  const gridYs = [0, 0.5, 1].map((f) => padY + (h - padY * 2) * f);
  const fmt = formatValue ?? ((v: number) => String(v));

  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="Trend">
      {gridYs.map((y, i) => (
        <line key={i} className="spark-grid" x1={padX} x2={w - padX} y1={y} y2={y} />
      ))}
      {showArea && <path className="spark-area" d={area} />}
      <path className="spark-line" d={line} />
      <text className="spark-label" x={padX} y={padY - 3}>
        {fmt(max)}
      </text>
      <text className="spark-label" x={w - padX} y={h - 3} textAnchor="end">
        {points[points.length - 1].label}
      </text>
    </svg>
  );
}

/* ============================== PageHeader ============================= */

export function PageHeader({
  title,
  subtitle,
  actions
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="row-between mb-lg wrap">
      <div>
        <h1>{title}</h1>
        {subtitle && <div className="muted small" style={{ marginTop: 3 }}>{subtitle}</div>}
      </div>
      {actions && <div className="row gap-sm wrap">{actions}</div>}
    </div>
  );
}

/* ============================== LoadingBlock =========================== */

export function LoadingBlock({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="center-pad row gap" style={{ justifyContent: 'center' }}>
      <div className="spinner" />
      <span className="muted small">{label}</span>
    </div>
  );
}

/** A short, plain-language description of why a value is unavailable. */
export function UnavailableNote({ text }: { text: string }) {
  return (
    <Notice kind="warn">
      <strong>Not available. </strong>
      {text}
    </Notice>
  );
}
