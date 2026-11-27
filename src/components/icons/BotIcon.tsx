import { SVGProps } from 'react';

export function BotIcon({ className }: SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 2v4m6 10v4m-6-10v-4M6 6v4m6 10v4m6-10v-4M12 6v4m6-10v-4M6 6v4m6 10v4m6-10v-4" />
    </svg>
  );
}
