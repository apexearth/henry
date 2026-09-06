// Where the sun and moon actually are, for a place and a moment. All arithmetic: no API, no
// network, no permission prompt. The sun uses the USNO low-precision series (~0.01°) and the
// moon Meeus's abridged lunar terms (~0.1°), which is a small fraction of one pixel of the
// discs ContextSky draws with them.

const RAD = Math.PI / 180;
const sin = (deg: number) => Math.sin(deg * RAD);
const cos = (deg: number) => Math.cos(deg * RAD);
const tan = (deg: number) => Math.tan(deg * RAD);
const norm = (deg: number) => ((deg % 360) + 360) % 360;

/** Days since J2000.0 (2000-01-01 12:00 UT). */
const days = (now: Date) => now.getTime() / 86400000 - 10957.5;
/** Greenwich mean sidereal time, in degrees. */
const gmst = (d: number) => norm(280.16 + 360.9856235 * d);

interface Equatorial { ra: number; dec: number }

/** Ecliptic longitude/latitude to right ascension/declination, degrees. */
function equatorial(lon: number, lat: number, d: number): Equatorial {
  const e = 23.439 - 0.0000004 * d; // obliquity
  return {
    ra: Math.atan2(sin(lon) * cos(e) - tan(lat) * sin(e), cos(lon)) / RAD,
    dec: Math.asin(sin(lat) * cos(e) + cos(lat) * sin(e) * sin(lon)) / RAD,
  };
}

/** The sun's ecliptic longitude. */
function sunLon(d: number): number {
  const g = 357.529 + 0.98560028 * d; // mean anomaly
  const q = 280.459 + 0.98564736 * d; // mean longitude
  return norm(q + 1.915 * sin(g) + 0.02 * sin(2 * g));
}

/** The moon's ecliptic longitude and latitude: mean terms plus evection, variation and the rest. */
function moonLonLat(d: number): { lon: number; lat: number } {
  const L = 218.316 + 13.176396 * d;  // mean longitude
  const M = 134.963 + 13.064993 * d;  // mean anomaly
  const F = 93.272 + 13.22935 * d;    // argument of latitude
  const D = 297.85 + 12.190749 * d;   // elongation from the sun
  const S = 357.529 + 0.98560028 * d; // the sun's mean anomaly
  const lon = L + 6.289 * sin(M) - 1.274 * sin(M - 2 * D) + 0.658 * sin(2 * D)
    + 0.214 * sin(2 * M) - 0.186 * sin(S) - 0.114 * sin(2 * F);
  return { lon: norm(lon), lat: 5.128 * sin(F) };
}

export interface Body {
  /** Degrees above the horizon; negative is below it. */
  alt: number;
  /** Hours from this body's transit: negative rising in the east, positive setting in the west. */
  hour: number;
  /** Hours from transit to setting — half the time it is up. 12 when it never sets, and when it never rises. */
  half: number;
}

/** The altitude a body is called risen at: refraction lifts the sun over the horizon while its
 * centre is still 0.83 degrees below, and the moon is close enough that parallax pulls the other way. */
const RISEN = { sun: -0.833, moon: 0.125 };

function body(eq: Equatorial, d: number, lat: number, lon: number, risen: number): Body {
  let ha = norm(gmst(d) + lon - eq.ra);
  if (ha > 180) ha -= 360;
  // >1 never rises, <-1 never sets: the poles, in season.
  const cosHalf = (sin(risen) - sin(lat) * sin(eq.dec)) / (cos(lat) * cos(eq.dec));
  return {
    alt: Math.asin(sin(lat) * sin(eq.dec) + cos(lat) * cos(eq.dec) * cos(ha)) / RAD,
    hour: ha / 15,
    half: Math.abs(cosHalf) >= 1 ? 12 : Math.acos(cosHalf) / RAD / 15,
  };
}

export interface Sky {
  sun: Body;
  moon: Body;
  /** Fraction of the moon's disc that is lit: 0 new, 0.5 at the quarters, 1 full. */
  lit: number;
}

/** The sky over (`lat`, `lon`) — degrees north and east — at `now`. */
export function skyState(now: Date, lat: number, lon: number): Sky {
  const d = days(now);
  const s = sunLon(d);
  const m = moonLonLat(d);
  // Elongation from the sun is the phase: 0 puts the moon in front of it, 180 opposite it.
  const elong = Math.acos(cos(m.lat) * cos(m.lon - s)) / RAD;
  return {
    sun: body(equatorial(s, 0, d), d, lat, lon, RISEN.sun),
    moon: body(equatorial(m.lon, m.lat, d), d, lat, lon, RISEN.moon),
    lit: (1 - cos(elong)) / 2,
  };
}

/** Clock time of a body's rising and setting today, from where it is now. Null if it does neither. */
export function riseSet(now: Date, b: Body): { rise: Date; set: Date } | null {
  if (b.half >= 12 || b.half <= 0) return null;
  const transit = now.getTime() - b.hour * 3600_000;
  return { rise: new Date(transit - b.half * 3600_000), set: new Date(transit + b.half * 3600_000) };
}
