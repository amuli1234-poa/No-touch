import { SVGProps } from 'react';

export function CopyTradingIcon({ className }: SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M19 21V5a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v16m14 0h2m-2 0h-2m-7 0V3m7 18v-6m0 0l6 6m-6-6l-6-6" />
    </svg>
  );
}
