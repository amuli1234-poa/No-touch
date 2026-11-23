import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export function PanelSection({
  title,
  icon,
  defaultOpen = false,
  children
}: {
  title: string;
  icon?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="bot-panel-section" open={defaultOpen}>
      <summary className="bot-panel-section__summary">
        <span className="flex min-w-0 items-center gap-2">
          {icon}
          <span className="truncate">{title}</span>
        </span>
        <ChevronDown
          className="bot-panel-section__chevron h-3.5 w-3.5 shrink-0 text-faint transition-transform"
          aria-hidden="true"
        />
      </summary>
      <div className="bot-panel-section__content">{children}</div>
    </details>
  );
}
