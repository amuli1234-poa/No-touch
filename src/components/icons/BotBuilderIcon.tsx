import { SVGProps } from 'react';

export function BotBuilderIcon({ className }: SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 2v20m-9-9h18m-18 0v-6m0 0l6-6m-6 6l-6-6m12 12h-6m6-6v-6m0 0l6-6m-6 6l-6-6" />
    </svg>
  );
}
