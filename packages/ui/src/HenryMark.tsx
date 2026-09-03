/** Henry in sixteen pixels: brim, beard, flannel. The full portrait with the axe is public/henry.svg. */
export function HenryMark({ size = 16 }: { size?: number }) {
  return (
    <svg className="henry-mark" viewBox="0 0 16 16" width={size} height={size} aria-hidden>
      <path className="shirt" d="M0.6 16 L2.2 12.8 H13.8 L15.4 16 Z" />
      <rect className="skin" x="4" y="6" width="8" height="4" />
      <rect className="eye" x="5.4" y="6.8" width="1.6" height="1.8" rx=".6" />
      <rect className="eye" x="9" y="6.8" width="1.6" height="1.8" rx=".6" />
      <path className="beard" d="M3.4 9 H12.6 L11.2 13.2 Q8 14.9 4.8 13.2 Z" />
      {/* A mouth, so the beard doesn't read as a band across the face. */}
      <rect className="mouth" x="7.1" y="9.6" width="1.8" height="1" rx=".5" />
      <rect className="hat" x="5" y="1" width="6" height="4" />
      <rect className="brim" x="1" y="4.4" width="14" height="2" rx="1" />
    </svg>
  );
}
