// One icon set for the whole app: 24px grid, 1.8 stroke, round caps and joins.

import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;

function Svg({ children, ...p }: P) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon" {...p}>
      {children}
    </svg>
  );
}

export const IconMap = (p: P) => (
  <Svg {...p}>
    <path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4Z" />
    <path d="M9 4v14M15 6v14" />
  </Svg>
);

export const IconCollection = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
    <circle cx="17" cy="17" r="3.5" />
  </Svg>
);

export const IconMarket = (p: P) => (
  <Svg {...p}>
    <path d="M4 9.5 5.4 4.5h13.2L20 9.5" />
    <path d="M4 9.5a2.67 2.67 0 0 0 5.33 0 2.67 2.67 0 0 0 5.34 0 2.67 2.67 0 0 0 5.33 0" />
    <path d="M5.5 12v7.5h13V12M10 19.5v-4h4v4" />
  </Svg>
);

export const IconCamera = (p: P) => (
  <Svg {...p}>
    <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2.5h6L16.5 7h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-9Z" />
    <circle cx="12" cy="13" r="3.5" />
  </Svg>
);

export const IconSettings = (p: P) => (
  <Svg {...p}>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="17" r="2" />
  </Svg>
);

export const IconLocate = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="6.5" />
    <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
    <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" />
  </Svg>
);

export const IconNavigate = (p: P) => (
  <Svg {...p}>
    <path d="M12 3 19 20l-7-3.5L5 20 12 3Z" />
  </Svg>
);

export const IconCompass = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" />
  </Svg>
);

export const IconClock = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);

export const IconSunrise = (p: P) => (
  <Svg {...p}>
    <path d="M7.5 16a4.5 4.5 0 0 1 9 0M3 16h2M19 16h2M12 7v2.5M6 10.5l1.4 1.4M18 10.5l-1.4 1.4M3 20h18" />
  </Svg>
);

export const IconSun = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
  </Svg>
);

export const IconSunset = (p: P) => (
  <Svg {...p}>
    <path d="M7.5 16a4.5 4.5 0 0 1 9 0M3 16h2M19 16h2M3 20h18M12 4v5M9.5 6.5 12 9l2.5-2.5" />
  </Svg>
);

export const IconMoon = (p: P) => (
  <Svg {...p}>
    <path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10Z" />
  </Svg>
);

export const IconPaw = (p: P) => (
  <Svg {...p}>
    <path d="M12 12.5c-2.6 0-5 2.9-5 5 0 1.4 1 2 2.3 2 1 0 1.7-.6 2.7-.6s1.7.6 2.7.6c1.3 0 2.3-.6 2.3-2 0-2.1-2.4-5-5-5Z" />
    <ellipse cx="7" cy="9.5" rx="1.6" ry="2.1" />
    <ellipse cx="10.2" cy="6" rx="1.6" ry="2.1" />
    <ellipse cx="13.8" cy="6" rx="1.6" ry="2.1" />
    <ellipse cx="17" cy="9.5" rx="1.6" ry="2.1" />
  </Svg>
);

export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);

export const IconCopy = (p: P) => (
  <Svg {...p}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2.5" />
    <path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
  </Svg>
);

export const IconGift = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="8" width="17" height="4" rx="1" />
    <path d="M5 12v7.5h14V12M12 8v11.5" />
    <path d="M12 8C10.5 4.5 7 4.5 7 6.5S10 8 12 8Zm0 0c1.5-3.5 5-3.5 5-1.5S14 8 12 8Z" />
  </Svg>
);

export const IconTag = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1.5 1.5 0 0 1 0 2.1l-6.4 6.4a1.5 1.5 0 0 1-2.1 0l-8.5-8.1Z" />
    <circle cx="8" cy="8" r="1.4" />
  </Svg>
);

export const IconSync = (p: P) => (
  <Svg {...p}>
    <path d="M19.5 9A8 8 0 0 0 5 7.5M4.5 15a8 8 0 0 0 14.5 1.5" />
    <path d="M19.5 4v5h-5M4.5 20v-5h5" />
  </Svg>
);

export const IconShield = (p: P) => (
  <Svg {...p}>
    <path d="M12 3 4.5 6v5.5c0 4.5 3.2 8 7.5 9.5 4.3-1.5 7.5-5 7.5-9.5V6L12 3Z" />
    <path d="m8.5 12 2.5 2.5 4.5-5" />
  </Svg>
);

export const IconAlert = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5v5.5M12 16.2v.3" />
  </Svg>
);

export const IconArrowLeft = (p: P) => (
  <Svg {...p}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Svg>
);

export const IconPin = (p: P) => (
  <Svg {...p}>
    <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" />
    <circle cx="12" cy="10" r="2.5" />
  </Svg>
);

export const IconWallet = (p: P) => (
  <Svg {...p}>
    <path d="M18.5 7.5V5.5a1.5 1.5 0 0 0-1.5-1.5H5.5A2 2 0 0 0 3.5 6v12a2 2 0 0 0 2 2h13a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 18.5 8H5.5a2 2 0 0 1-2-2" />
    <circle cx="16" cy="14" r="1.2" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconWorld = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="4" />
  </Svg>
);

export const IconSparkle = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.5 13.8 10l6.7 2-6.7 2L12 20.5 10.2 14 3.5 12l6.7-2L12 3.5Z" />
  </Svg>
);

export const IconLogout = (p: P) => (
  <Svg {...p}>
    <path d="M14 4.5H6.5a1.5 1.5 0 0 0-1.5 1.5v12a1.5 1.5 0 0 0 1.5 1.5H14M10 12h10M16.5 8.5 20 12l-3.5 3.5" />
  </Svg>
);

/** The brand mark: a red map pin with a creature's eye, on a yellow toy tile. */
export function BrandMark({ className = "nav-brand-mark" }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="bm-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffe36b" />
          <stop offset="1" stopColor="#f2a000" />
        </linearGradient>
      </defs>
      <rect x="2.5" y="2.5" width="43" height="43" rx="13" fill="url(#bm-g)" stroke="#0b1630" strokeWidth="3" />
      <path d="M6 13a10 10 0 0 1 9-8" stroke="#fff" strokeOpacity=".6" strokeWidth="3" strokeLinecap="round" fill="none" />
      <path d="M24 8.5c-6.4 0-11.5 4.9-11.5 11.2 0 8.3 11.5 18.3 11.5 18.3s11.5-10 11.5-18.3c0-6.3-5.1-11.2-11.5-11.2Z" fill="#ff5a5a" stroke="#0b1630" strokeWidth="3" strokeLinejoin="round" />
      <circle cx="24" cy="20" r="6" fill="#fff" stroke="#0b1630" strokeWidth="2.5" />
      <circle cx="25.6" cy="19" r="2.6" fill="#0b1630" />
      <circle cx="26.4" cy="18.2" r="0.9" fill="#fff" />
    </svg>
  );
}

export const IconChevronSwap = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 8.5h13l-3.5-3.5M19.5 15.5h-13l3.5 3.5" />
  </Svg>
);

export const IconUser = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="8.5" r="3.5" />
    <path d="M5 19.5c1-3.5 3.8-5 7-5s6 1.5 7 5" />
  </Svg>
);

// ---------------------------------------------------------------------------------------------------------
// Illustrated "game art" icons for the tab bar and HUD: flat colour fills with a thick dark outline.
// ---------------------------------------------------------------------------------------------------------

const O = "#0b1630";
const art = { stroke: O, strokeWidth: 2.5, strokeLinejoin: "round" as const, strokeLinecap: "round" as const };

export const ArtMap = ({ className = "nav-art" }: { className?: string }) => (
  <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
    <path d="M5 15 17 11v28L5 43Z" fill="#6fd35c" {...art} />
    <path d="M17 11l14 4v28l-14-4Z" fill="#9cec84" {...art} />
    <path d="M31 15l12-4v28l-12 4Z" fill="#6fd35c" {...art} />
    <path d="M9 34c4-2 7 1 10-1s5-3 8-1 6 2 9-1" fill="none" stroke="#fff" strokeWidth="2" strokeDasharray="2 3" strokeLinecap="round" />
    <path d="M24 3.5c-5.2 0-9 3.9-9 8.8 0 6.8 9 14.7 9 14.7s9-7.9 9-14.7c0-4.9-3.8-8.8-9-8.8Z" fill="#ff5a5a" {...art} />
    <circle cx="24" cy="12.3" r="3.4" fill="#fff" {...art} strokeWidth="2" />
  </svg>
);

export const ArtChest = ({ className = "nav-art" }: { className?: string }) => (
  <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
    <rect x="6" y="21" width="36" height="21" rx="3" fill="#c97a3a" {...art} />
    <path d="M6 22v-5a9 9 0 0 1 9-9h18a9 9 0 0 1 9 9v5Z" fill="#e8964d" {...art} />
    <path d="M12 8.6V42M36 8.6V42" stroke={O} strokeWidth="7" />
    <path d="M12 8.6V42M36 8.6V42" stroke="#ffcd2e" strokeWidth="3.5" />
    <path d="M6 22h36" stroke={O} strokeWidth="2.5" />
    <rect x="19.5" y="17.5" width="9" height="11" rx="2.5" fill="#ffe36b" {...art} />
    <circle cx="24" cy="22.5" r="1.6" fill={O} />
    <path d="M10 13.5c2-2.6 4-3.5 7-3.5" stroke="#fff" strokeOpacity=".55" strokeWidth="2" strokeLinecap="round" fill="none" />
  </svg>
);

export const ArtShop = ({ className = "nav-art" }: { className?: string }) => (
  <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
    <rect x="15" y="3.5" width="18" height="7" rx="2.5" fill="#ffcd2e" {...art} />
    <rect x="8" y="20" width="32" height="23" rx="2" fill="#f2f6ff" {...art} />
    <rect x="20" y="29" width="8" height="14" rx="1.5" fill="#4aa8ff" {...art} />
    <rect x="11.5" y="26" width="6" height="7" rx="1.5" fill="#9fdcff" {...art} strokeWidth="2" />
    <rect x="30.5" y="26" width="6" height="7" rx="1.5" fill="#9fdcff" {...art} strokeWidth="2" />
    <path d="M6 10.5h36l3 9.5H3Z" fill="#ff5a5a" {...art} />
    <path d="M12 10.5 10 20M24 10.5V20M36 10.5l2 9.5" stroke="#fff" strokeWidth="5" />
    <path d="M6 10.5h36l3 9.5H3Z" fill="none" {...art} />
    <path d="M3 20a3.5 3.5 0 0 0 7 0 3.5 3.5 0 0 0 7 0 3.5 3.5 0 0 0 7 0 3.5 3.5 0 0 0 7 0 3.5 3.5 0 0 0 7 0 3.5 3.5 0 0 0 7 0" fill="#ff5a5a" {...art} />
  </svg>
);

export const ArtGear = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
    {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
      <rect key={a} x="19.5" y="2.5" width="9" height="11" rx="2.5" fill="#fff" {...art} transform={`rotate(${a} 24 24)`} />
    ))}
    <circle cx="24" cy="24" r="15" fill="#fff" {...art} />
    <circle cx="24" cy="24" r="6.5" fill="#2a83ee" {...art} />
    <path d="M14 19a11 11 0 0 1 6-6" stroke="#c9d6ee" strokeWidth="2.5" strokeLinecap="round" fill="none" />
  </svg>
);
