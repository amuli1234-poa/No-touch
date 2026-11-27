import { SVGProps } from 'react';

export function ProScannerIcon({ className }: SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 2l2.22 6.23 7.57.73-3.79 5.66L12 16.2l-6.5-1.88-3.79-5.66L9.78 8.23z" />
      <path d="M12 13l-1.6-1.6L12 8l1.6 1.6z" />
    </svg>
  );
}
