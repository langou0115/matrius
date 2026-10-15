import type { ReactNode } from 'react';

const paths = {
  good: <><path d="M7 10l4-7c1-1 3 0 3 2v4h5a2 2 0 0 1 2 2l-2 8a2 2 0 0 1-2 2H7V10Z" /><rect x="2" y="10" width="5" height="11" rx="1" /></>,
  bad: <><path d="M7 14l4 7c1 1 3 0 3-2v-4h5a2 2 0 0 0 2-2l-2-8a2 2 0 0 0-2-2H7v11Z" /><rect x="2" y="3" width="5" height="11" rx="1" /></>,
  fork: <><circle cx="6" cy="4" r="2" /><circle cx="18" cy="4" r="2" /><circle cx="12" cy="20" r="2" /><path d="M6 6v3a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V6m-6 6v6" /></>,
  compose: <><path d="M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7" /><path d="m16 3 5 5M10 14l1-5 7-7a2.1 2.1 0 0 1 3 3l-7 7-4 2Z" /></>,
  copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
  collapse: <path d="m6 15 6-6 6 6" />,
  expand: <path d="m6 9 6 6 6-6" />,
  search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></>,
  sidebar: <><rect x="3" y="3" width="18" height="18" rx="4" /><path d="M9 3v18" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  sparkle: <><path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7L12 3Z" /><path d="m20 2 .6 1.4L22 4l-1.4.6L20 6l-.6-1.4L18 4l1.4-.6L20 2Z" /></>,
  chevron: <path d="m8 10 4 4 4-4" />,
  arrow: <path d="M12 19V5m-6 6 6-6 6 6" />,
  back: <path d="M19 12H5m6-6-6 6 6 6" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  chat: <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z" />,
  user: <><circle cx="12" cy="8" r="3.5" /><path d="M5 21v-2a7 7 0 0 1 14 0v2" /></>,
  settings: <><path d="m9.5 3-.7 2.4-2 .9-2.3-.6-2 3.4 1.6 1.8v2.2l-1.6 1.8 2 3.4 2.3-.6 2 .9.7 2.4h5l.7-2.4 2-.9 2.3.6 2-3.4-1.6-1.8v-2.2l1.6-1.8-2-3.4-2.3.6-2-.9-.7-2.4h-5Z" /><circle cx="12" cy="12" r="3" /></>,
  code: <><path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18" /></>,
  pen: <><path d="m15 4 5 5M4 20l5-1L21 7a2.1 2.1 0 0 0-5-5L4 14l-1 7Z" /><path d="M13 21h8" /></>,
  compare: <><path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4" /></>,
  bolt: <path d="m13 2-9 12h7l-1 8 10-12h-7l1-8Z" />,
  pin: <><path d="m16 3 5 5-4 1-3 5v3l-2 2-7-7 2-2h3l5-3 1-4ZM2 22l6-6" /></>,
  trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>,
  moon: <path d="M21 13a9 9 0 1 1-10-10 7 7 0 0 0 10 10Z" />,
  monitor: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10h.01" /></>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;
export function Icon({ name, size = 20, className = '' }: { name: IconName; size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
