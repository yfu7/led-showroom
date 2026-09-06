/**
 * Line illustrations for catalog thumbnails. Every icon is a 48 × 48 viewBox drawn with
 * `stroke: currentColor` at 1.1 px so it inherits the card's foreground colour in both themes.
 */
import type { ReactNode, SVGProps } from 'react';

export type CatalogIconKind =
  | 'led-wall' | 'led-poster' | 'stage' | 'kiosk' | 'totem' | 'truss' | 'drape' | 'table' | 'chair' | 'sofa'
  | 'figure' | 'plant' | 'box' | 'cylinder' | 'screen' | 'podium' | 'speaker' | 'counter' | 'locker' | 'room'
  | 'model' | 'splat';

const ICONS: Record<CatalogIconKind, ReactNode> = {
  'led-wall': (
    <>
      <rect x="7" y="9" width="34" height="26" rx="1" />
      <path d="M18.3 9v26M29.7 9v26M7 17.7h34M7 26.3h34" />
      <path d="M13 35v4M35 35v4M9 39h8M31 39h8" />
    </>
  ),
  'led-poster': (
    <>
      <rect x="17" y="6" width="14" height="30" rx="1" />
      <path d="M17 16h14M17 26h14" />
      <path d="M14 40h20M19 36v4M29 36v4" />
      <path d="M31 12l4 2M31 30l4 2M35 14v18" opacity=".55" />
    </>
  ),
  stage: (
    <>
      <path d="M8 20l16-6 16 6-16 6z" />
      <path d="M8 20v8l16 6 16-6v-8" />
      <path d="M24 26v8" />
      <path d="M8 28l-1 8M40 28l1 8M24 34l0 6" opacity=".55" />
    </>
  ),
  kiosk: (
    <>
      <path d="M17 8h14l1 8H16z" />
      <rect x="17" y="16" width="14" height="22" rx="1" />
      <path d="M20 21h8M20 25h8M20 29h8" opacity=".6" />
      <path d="M13 40h22" />
    </>
  ),
  totem: (
    <>
      <rect x="16" y="6" width="16" height="28" rx="1.5" />
      <rect x="18.5" y="8.5" width="11" height="21" rx=".5" opacity=".6" />
      <path d="M24 34v5M13 40h22" />
    </>
  ),
  truss: (
    <>
      <path d="M6 18h36M6 30h36" />
      <path d="M6 18l6 12 6-12 6 12 6-12 6 12 6-12 6 12" />
      <path d="M6 18v12M42 18v12" />
    </>
  ),
  drape: (
    <>
      <path d="M8 9h32" />
      <path d="M8 9v30M40 9v30" />
      <path d="M13 9c0 12 2 20 0 30M18 9c0 12-2 20 0 30M23 9c0 12 2 20 0 30M28 9c0 12-2 20 0 30M33 9c0 12 2 20 0 30" opacity=".6" />
      <path d="M6 39h4M38 39h4" />
    </>
  ),
  table: (
    <>
      <path d="M6 18h36" />
      <path d="M8 18v4h32v-4" />
      <path d="M11 22v16M37 22v16M11 30h26" />
    </>
  ),
  chair: (
    <>
      <path d="M16 8h14v14H16z" />
      <path d="M13 22h22v5H13z" />
      <path d="M14 27v13M34 27v13M18 22v-4M30 22v-4" />
    </>
  ),
  sofa: (
    <>
      <path d="M12 16a4 4 0 0 1 4-4h16a4 4 0 0 1 4 4v8" />
      <path d="M6 24a3 3 0 0 1 3 3v6h30v-6a3 3 0 0 1 3-3" />
      <path d="M9 24v-3a3 3 0 0 1 6 0v6M39 24v-3a3 3 0 0 0-6 0v6" />
      <path d="M12 33v5M36 33v5M15 27h18" />
    </>
  ),
  figure: (
    <>
      <circle cx="24" cy="9" r="4" />
      <path d="M17 17h14l-1 12h-2l-1 12h-6l-1-12h-2z" />
      <path d="M17 17l-4 10M31 17l4 10" />
    </>
  ),
  plant: (
    <>
      <path d="M17 30h14l-1.5 9h-11z" />
      <path d="M24 30V16" />
      <path d="M24 22c-6 0-9-3-10-9 6 0 9 3 10 9zM24 18c0-6 3-9 9-10 0 6-3 9-9 10z" />
      <path d="M24 26c-5 0-7-2-8-6 5 0 7 2 8 6z" opacity=".6" />
    </>
  ),
  box: (
    <>
      <path d="M10 16l14-7 14 7v16l-14 7-14-7z" />
      <path d="M10 16l14 7 14-7M24 23v16" />
    </>
  ),
  cylinder: (
    <>
      <ellipse cx="24" cy="12" rx="12" ry="4" />
      <path d="M12 12v24c0 2.2 5.4 4 12 4s12-1.8 12-4V12" />
      <path d="M12 26c0 2.2 5.4 4 12 4s12-1.8 12-4" opacity=".4" />
    </>
  ),
  screen: (
    <>
      <rect x="6" y="9" width="36" height="22" rx="1.5" />
      <path d="M24 31v9M14 40h20" />
      <path d="M10 13l28 14" opacity=".35" />
    </>
  ),
  podium: (
    <>
      <path d="M13 12h22l2 4H11z" />
      <path d="M15 16h18v22H15z" />
      <path d="M19 21h10M19 25h10" opacity=".6" />
      <path d="M11 38h26" />
    </>
  ),
  speaker: (
    <>
      <rect x="15" y="6" width="18" height="24" rx="1.5" />
      <circle cx="24" cy="21" r="5" />
      <circle cx="24" cy="12" r="2" />
      <path d="M24 30v6M18 42l6-6 6 6" />
    </>
  ),
  counter: (
    <>
      <path d="M8 16h32v4H8z" />
      <path d="M10 20v18h28V20" />
      <path d="M10 38h28" />
      <path d="M16 26h16M16 30h16" opacity=".5" />
    </>
  ),
  locker: (
    <>
      <rect x="15" y="6" width="18" height="34" rx="1.5" />
      <path d="M15 15h18M15 24h18M15 32h18" />
      <path d="M28 10.5h2M28 19.5h2M28 28h2M28 36h2" />
    </>
  ),
  room: (
    <>
      <path d="M6 14l10-6h22l-10 6z" opacity=".5" />
      <path d="M6 14h22v22H6z" />
      <path d="M28 14l10-6v22l-10 6" />
      <path d="M6 36l10-6" opacity=".5" />
    </>
  ),
  model: (
    <>
      <path d="M12 18l12-6 12 6v14l-12 6-12-6z" />
      <path d="M12 18l12 6 12-6M24 24v14" />
      <path d="M36 8v8M32 12l4-4 4 4" />
    </>
  ),
  splat: (
    <>
      <circle cx="24" cy="24" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="16" cy="18" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="32" cy="16" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="30" cy="30" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="18" cy="31" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="24" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="26" r="1" fill="currentColor" stroke="none" />
      <circle cx="36" cy="24" r="1" fill="currentColor" stroke="none" />
      <circle cx="24" cy="36" r="1" fill="currentColor" stroke="none" />
      <circle cx="20" cy="22" r=".9" fill="currentColor" stroke="none" opacity=".6" />
      <circle cx="28" cy="22" r=".9" fill="currentColor" stroke="none" opacity=".6" />
      <circle cx="26" cy="29" r=".9" fill="currentColor" stroke="none" opacity=".6" />
      <circle cx="24" cy="24" r="13" opacity=".25" strokeDasharray="1.5 3" />
    </>
  ),
};

export interface CatalogIconProps extends Omit<SVGProps<SVGSVGElement>, 'kind'> {
  kind: CatalogIconKind;
}

/** A catalog thumbnail illustration. Sized by the parent (`.card .thumb svg` is 44 px). */
export function CatalogIcon({ kind, ...rest }: CatalogIconProps) {
  return (
    <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {ICONS[kind] ?? ICONS.box}
    </svg>
  );
}
