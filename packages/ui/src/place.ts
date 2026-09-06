// A latitude and longitude for the sky, guessed from the browser's time zone. The zone is
// already on the machine, so this costs no network call and no geolocation prompt; the user can
// correct it in the theme menu, and the sky only needs a few hundred kilometres of accuracy
// (that is minutes of sunset, and latitude is what sets the length of the day anyway).

export interface Place { lat: number; lon: number }

const ZONES: Record<string, Place> = zones({
  "America/New_York": [40.7, -74], "America/Detroit": [42.3, -83], "America/Chicago": [41.9, -87.6],
  "America/Denver": [39.7, -105], "America/Phoenix": [33.4, -112.1], "America/Los_Angeles": [34.1, -118.2],
  "America/Anchorage": [61.2, -149.9], "America/Toronto": [43.7, -79.4], "America/Vancouver": [49.3, -123.1],
  "America/Edmonton": [53.5, -113.5], "America/Winnipeg": [49.9, -97.1], "America/Halifax": [44.6, -63.6],
  "America/St_Johns": [47.6, -52.7], "America/Mexico_City": [19.4, -99.1], "America/Tijuana": [32.5, -117],
  "America/Monterrey": [25.7, -100.3], "America/Bogota": [4.7, -74.1], "America/Lima": [-12, -77],
  "America/Santiago": [-33.4, -70.6], "America/Sao_Paulo": [-23.5, -46.6], "America/Argentina/Buenos_Aires": [-34.6, -58.4],
  "America/Buenos_Aires": [-34.6, -58.4], "America/Caracas": [10.5, -66.9], "America/Panama": [9, -79.5],
  "America/Guatemala": [14.6, -90.5], "America/Havana": [23.1, -82.4], "America/Puerto_Rico": [18.5, -66.1],
  "America/Costa_Rica": [9.9, -84.1], "America/Montevideo": [-34.9, -56.2], "America/La_Paz": [-16.5, -68.1],
  "America/Guayaquil": [-2.2, -79.9], "America/Asuncion": [-25.3, -57.6],
  "Europe/London": [51.5, -0.1], "Europe/Dublin": [53.3, -6.3], "Europe/Lisbon": [38.7, -9.1],
  "Europe/Madrid": [40.4, -3.7], "Europe/Paris": [48.9, 2.4], "Europe/Brussels": [50.8, 4.4],
  "Europe/Amsterdam": [52.4, 4.9], "Europe/Berlin": [52.5, 13.4], "Europe/Zurich": [47.4, 8.5],
  "Europe/Vienna": [48.2, 16.4], "Europe/Rome": [41.9, 12.5], "Europe/Prague": [50.1, 14.4],
  "Europe/Warsaw": [52.2, 21], "Europe/Stockholm": [59.3, 18.1], "Europe/Oslo": [59.9, 10.8],
  "Europe/Copenhagen": [55.7, 12.6], "Europe/Helsinki": [60.2, 24.9], "Europe/Athens": [38, 23.7],
  "Europe/Bucharest": [44.4, 26.1], "Europe/Budapest": [47.5, 19.1], "Europe/Kyiv": [50.5, 30.5],
  "Europe/Kiev": [50.5, 30.5], "Europe/Moscow": [55.8, 37.6], "Europe/Istanbul": [41, 29],
  "Europe/Belgrade": [44.8, 20.5], "Europe/Sofia": [42.7, 23.3], "Europe/Zagreb": [45.8, 16],
  "Europe/Riga": [56.9, 24.1], "Europe/Vilnius": [54.7, 25.3], "Europe/Tallinn": [59.4, 24.8],
  "Europe/Malta": [35.9, 14.5], "Atlantic/Reykjavik": [64.1, -21.9], "Atlantic/Canary": [28.1, -15.4],
  "Asia/Jerusalem": [31.8, 35.2], "Asia/Dubai": [25.2, 55.3], "Asia/Riyadh": [24.7, 46.7],
  "Asia/Tehran": [35.7, 51.4], "Asia/Karachi": [24.9, 67], "Asia/Kolkata": [22.6, 88.4],
  "Asia/Calcutta": [22.6, 88.4], "Asia/Dhaka": [23.8, 90.4], "Asia/Kathmandu": [27.7, 85.3],
  "Asia/Colombo": [6.9, 79.9], "Asia/Bangkok": [13.8, 100.5], "Asia/Ho_Chi_Minh": [10.8, 106.7],
  "Asia/Saigon": [10.8, 106.7], "Asia/Jakarta": [-6.2, 106.8], "Asia/Singapore": [1.35, 103.8],
  "Asia/Kuala_Lumpur": [3.1, 101.7], "Asia/Manila": [14.6, 121], "Asia/Hong_Kong": [22.3, 114.2],
  "Asia/Taipei": [25, 121.5], "Asia/Shanghai": [31.2, 121.5], "Asia/Chongqing": [29.6, 106.5],
  "Asia/Urumqi": [43.8, 87.6], "Asia/Seoul": [37.6, 127], "Asia/Tokyo": [35.7, 139.7],
  "Asia/Almaty": [43.2, 76.9], "Asia/Tashkent": [41.3, 69.3], "Asia/Baku": [40.4, 49.9],
  "Asia/Tbilisi": [41.7, 44.8], "Asia/Yerevan": [40.2, 44.5], "Asia/Yekaterinburg": [56.8, 60.6],
  "Asia/Novosibirsk": [55, 82.9], "Asia/Vladivostok": [43.1, 131.9], "Asia/Baghdad": [33.3, 44.4],
  "Asia/Kabul": [34.5, 69.2], "Asia/Beirut": [33.9, 35.5], "Asia/Amman": [31.9, 35.9],
  "Asia/Damascus": [33.5, 36.3], "Asia/Kuwait": [29.4, 48], "Asia/Qatar": [25.3, 51.5],
  "Asia/Yangon": [16.8, 96.2], "Asia/Phnom_Penh": [11.6, 104.9],
  "Africa/Cairo": [30, 31.2], "Africa/Lagos": [6.5, 3.4], "Africa/Nairobi": [-1.3, 36.8],
  "Africa/Johannesburg": [-26.2, 28], "Africa/Casablanca": [33.6, -7.6], "Africa/Accra": [5.6, -0.2],
  "Africa/Algiers": [36.8, 3.1], "Africa/Tunis": [36.8, 10.2], "Africa/Addis_Ababa": [9, 38.8],
  "Africa/Kinshasa": [-4.3, 15.3], "Africa/Khartoum": [15.6, 32.5], "Africa/Dakar": [14.7, -17.5],
  "Africa/Abidjan": [5.3, -4], "Africa/Harare": [-17.8, 31.1],
  "Australia/Sydney": [-33.9, 151.2], "Australia/Melbourne": [-37.8, 145], "Australia/Brisbane": [-27.5, 153],
  "Australia/Perth": [-31.9, 115.9], "Australia/Adelaide": [-34.9, 138.6], "Australia/Hobart": [-42.9, 147.3],
  "Australia/Darwin": [-12.5, 130.8], "Pacific/Auckland": [-36.9, 174.8], "Pacific/Honolulu": [21.3, -157.9],
  "Pacific/Fiji": [-18.1, 178.4], "Pacific/Guam": [13.5, 144.8],
  "Indian/Maldives": [4.2, 73.5], "Indian/Mauritius": [-20.2, 57.5],
});

/** A latitude for zones not in the table, by the region they are filed under. */
const REGIONS: Record<string, number> = {
  Africa: 5, America: 25, Antarctica: -70, Asia: 30, Atlantic: 35,
  Australia: -30, Europe: 50, Indian: -10, Pacific: -15, US: 39, Canada: 52, Brazil: -12, Mexico: 20,
};

function zones(t: Record<string, [number, number]>): Record<string, Place> {
  const out: Record<string, Place> = {};
  for (const [k, [lat, lon]] of Object.entries(t)) out[k] = { lat, lon };
  return out;
}

/** Where to put the sun until the user says otherwise. */
export function guessPlace(): Place {
  let zone = "";
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    zone = "";
  }
  const known = ZONES[zone];
  if (known) return known;
  // Unknown zone: the offset from UTC is a real longitude (15° an hour), and the region name is
  // the only hint at a hemisphere. Wrong by a country, but never wrong by a season.
  return { lat: REGIONS[zone.split("/")[0] ?? ""] ?? 40, lon: clampLon(-new Date().getTimezoneOffset() / 4) };
}

export const clampLat = (n: number) => Math.max(-89, Math.min(89, n));
export const clampLon = (n: number) => Math.max(-180, Math.min(180, n));
