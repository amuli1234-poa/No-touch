import React, { useEffect, useRef, useState } from 'react';

/* --------------------------------------------------------------------------
   Reveal — subtle fade-up as a section scrolls into view.
   One observer per element, disconnected after it fires. Motion is disabled
   globally under `prefers-reduced-motion` (see index.css).
   -------------------------------------------------------------------------- */

export const Reveal: React.FC<{
  children: React.ReactNode;
  className?: string;
  delay?: number;
  as?: 'div' | 'section' | 'li' | 'article';
}> = ({ children, className = '', delay = 0, as = 'div' }) => {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setShown(true);
            observer.disconnect();
          }
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const Tag = as as React.ElementType;

  return (
    <Tag
      ref={ref}
      style={{ transitionDelay: `${delay}ms` }}
      className={`transition-[opacity,transform] duration-700 ease-out ${
        shown ? 'translate-y-0 opacity-100' : 'translate-y-3 opacity-0'
      } ${className}`}
    >
      {children}
    </Tag>
  );
};

/* --------------------------------------------------------------------------
   Section — consistent vertical rhythm and max width
   -------------------------------------------------------------------------- */

export const Section: React.FC<{
  id?: string;
  children: React.ReactNode;
  className?: string;
  innerClassName?: string;
}> = ({ id, children, className = '', innerClassName = '' }) => (
  <section id={id} className={`relative scroll-mt-24 py-16 sm:py-20 lg:py-24 ${className}`}>
    <div className={`mx-auto w-full max-w-6xl px-5 sm:px-8 ${innerClassName}`}>{children}</div>
  </section>
);

export const Eyebrow: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className = ''
}) => (
  <span
    className={`inline-flex items-center gap-2 rounded-full border border-[var(--ws-hairline)] bg-surface/70 px-3.5 py-1.5 text-[12px] font-semibold uppercase tracking-[0.16em] text-accent-soft ${className}`}
  >
    {children}
  </span>
);

export const SectionHeading: React.FC<{
  eyebrow?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  align?: 'left' | 'center';
  className?: string;
}> = ({ eyebrow, title, description, align = 'center', className = '' }) => (
  <div
    className={`${align === 'center' ? 'mx-auto max-w-2xl text-center' : 'max-w-2xl'} ${className}`}
  >
    {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
    <h2 className="mt-5 text-[26px] font-extrabold leading-[1.15] tracking-[-0.03em] text-fg-1 sm:text-[32px] lg:text-[36px]">
      {title}
    </h2>
    {description && (
      <p className="mt-4 text-[14.5px] leading-relaxed text-fg-4 sm:text-[15.5px]">
        {description}
      </p>
    )}
  </div>
);

/* --------------------------------------------------------------------------
   Buttons — anchors styled for the public site
   -------------------------------------------------------------------------- */

type WsButtonVariant = 'primary' | 'secondary' | 'ghost';

const WS_BUTTON: Record<WsButtonVariant, string> = {
  primary:
    'bg-accent text-on-accent border-accent hover:bg-accent-strong shadow-[var(--shadow-accent-lg)]',
  secondary:
    'bg-surface-raised text-fg-1 border-[var(--ws-hairline)] hover:border-accent/50 hover:bg-surface-elevated',
  ghost: 'bg-transparent text-fg-3 border-transparent hover:bg-surface-raised hover:text-fg-1'
};

export const WsButton: React.FC<{
  children: React.ReactNode;
  variant?: WsButtonVariant;
  onClick?: () => void;
  href?: string;
  className?: string;
  icon?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  ariaLabel?: string;
}> = ({ children, variant = 'primary', onClick, href, className = '', icon, size = 'md', ariaLabel }) => {
  const sizing =
    size === 'lg'
      ? 'h-12 px-6 text-[14.5px] gap-2'
      : size === 'sm'
        ? 'h-9 px-3.5 text-[13.5px] gap-1.5'
        : 'h-11 px-5 text-[13.5px] gap-2';

  const cls = `group inline-flex items-center justify-center rounded-[11px] border font-semibold tracking-tight transition-colors ${WS_BUTTON[variant]} ${sizing} ${className}`;

  if (href) {
    return (
      <a href={href} className={cls} aria-label={ariaLabel}>
        {children}
        {icon}
      </a>
    );
  }

  return (
    <button type="button" onClick={onClick} className={cls} aria-label={ariaLabel}>
      {children}
      {icon}
    </button>
  );
};
