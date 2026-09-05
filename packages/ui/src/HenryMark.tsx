import { useId } from "react";

/**
 * Henry: brim, beard, flannel, no axe. Drawn on a 64-unit grid so the same paths serve the
 * 16px topbar and the app icon. The check and the hat band only appear above 48px - at 16px
 * their lines land on a fraction of a device pixel and read as mud across the flannel.
 */
export function HenryMark({ size = 16 }: { size?: number }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const detailed = size >= 48;
  return (
    <svg className="henry-mark" viewBox="0 0 64 64" width={size} height={size} aria-hidden>
      <defs>
        <clipPath id={`${uid}-shirt`}><path d="M4 64 L9.4 52.4 Q10.2 51 12 51 H52 Q53.8 51 54.6 52.4 L60 64 Z" /></clipPath>
        <clipPath id={`${uid}-crown`}><path d="M20.6 20 L22.4 6.4 Q22.8 4 25.4 4 H38.6 Q41.2 4 41.6 6.4 L43.4 20 Z" /></clipPath>
      </defs>
      <path className="shirt" d="M4 64 L9.4 52.4 Q10.2 51 12 51 H52 Q53.8 51 54.6 52.4 L60 64 Z" />
      {detailed && (
        <g className="check" clipPath={`url(#${uid}-shirt)`}>
          <rect x="13" y="50" width="1.8" height="14" /><rect x="21" y="50" width="1.8" height="14" />
          <rect x="30" y="50" width="1.8" height="14" /><rect x="39" y="50" width="1.8" height="14" />
          <rect x="47" y="50" width="1.8" height="14" />
          <rect x="2" y="54.5" width="60" height="1.8" /><rect x="2" y="60" width="60" height="1.8" />
        </g>
      )}
      <rect className="skin" x="16" y="24" width="32" height="16" rx="4" />
      <rect className="nose" x="30.6" y="29.8" width="2.8" height="6.6" rx="1.4" />
      <rect className="eye" x="21.6" y="27.2" width="6.4" height="7.2" rx="3.2" />
      <rect className="eye" x="36" y="27.2" width="6.4" height="7.2" rx="3.2" />
      <path className="beard" d="M13.6 36 H50.4 L45 52.4 Q32 59.6 19 52.4 Z" />
      {/* A mouth, so the beard doesn't read as a band across the face. */}
      <rect className="mouth" x="28.4" y="39.4" width="7.2" height="3.6" rx="1.8" />
      <path className="mustache" d="M32 38.2 C30.2 36.4 26.4 36 24 37.8 C24.9 40.9 28.4 41.8 32 40.3 C35.6 41.8 39.1 40.9 40 37.8 C37.6 36 33.8 36.4 32 38.2 Z" />
      <path className="hat" d="M20.6 20 L22.4 6.4 Q22.8 4 25.4 4 H38.6 Q41.2 4 41.6 6.4 L43.4 20 Z" />
      {detailed && (
        <g clipPath={`url(#${uid}-crown)`}><rect className="band" x="18" y="14" width="28" height="4.4" /></g>
      )}
      <rect className="brim" x="4" y="17.6" width="56" height="8" rx="4" />
    </svg>
  );
}
