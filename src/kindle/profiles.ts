/**
 * Kindle device profiles: native portrait screen resolutions used to size
 * converted pages. Resolutions follow Kindle Comic Converter's profile list
 * (kindlecomicconverter/image.py), which tracks what each panel displays.
 */

export interface KindleProfile {
  id: string;
  name: string;
  /** Native portrait width in pixels. */
  width: number;
  /** Native portrait height in pixels. */
  height: number;
  /** Color screen: keep color; otherwise pages are converted to grayscale. */
  color: boolean;
}

export const KINDLE_PROFILES: readonly KindleProfile[] = Object.freeze([
  { id: 'paperwhite-2024', name: 'Kindle Paperwhite (2024) / Signature Edition', width: 1272, height: 1696, color: false },
  { id: 'paperwhite-2021', name: 'Kindle Paperwhite (2021) / Signature Edition', width: 1236, height: 1648, color: false },
  { id: 'paperwhite-2015', name: 'Kindle Paperwhite (2015–2018) / Voyage', width: 1072, height: 1448, color: false },
  { id: 'kindle-2022', name: 'Kindle (2022 and later)', width: 1072, height: 1448, color: false },
  { id: 'kindle-2019', name: 'Kindle (2019 and earlier)', width: 600, height: 800, color: false },
  { id: 'oasis', name: 'Kindle Oasis (2017, 2019)', width: 1264, height: 1680, color: false },
  { id: 'colorsoft', name: 'Kindle Colorsoft', width: 1272, height: 1696, color: true },
  { id: 'scribe', name: 'Kindle Scribe (2022, 2024)', width: 1860, height: 2480, color: false },
  { id: 'scribe-2025', name: 'Kindle Scribe (2025)', width: 1986, height: 2648, color: false },
  { id: 'scribe-colorsoft', name: 'Kindle Scribe Colorsoft', width: 1986, height: 2648, color: true },
  { id: 'kindle-app', name: 'Kindle app (phone or tablet)', width: 1600, height: 2560, color: true },
].map((profile) => Object.freeze(profile)));

export const DEFAULT_KINDLE_PROFILE_ID = 'paperwhite-2024';

/** Returns the profile with `id`, or the default profile when it is missing or unknown. */
export function getKindleProfile(id?: string): KindleProfile {
  const found = id ? KINDLE_PROFILES.find((profile) => profile.id === id) : undefined;
  return found ?? (KINDLE_PROFILES.find((profile) => profile.id === DEFAULT_KINDLE_PROFILE_ID) as KindleProfile);
}
