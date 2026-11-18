import { describe, expect, it } from 'vitest';
import { DEFAULT_KINDLE_PROFILE_ID, getKindleProfile, KINDLE_PROFILES } from './profiles';

describe('Kindle profiles', () => {
  it('has unique ids and portrait resolutions', () => {
    const ids = new Set(KINDLE_PROFILES.map((profile) => profile.id));
    expect(ids.size).toBe(KINDLE_PROFILES.length);
    for (const profile of KINDLE_PROFILES) {
      expect(profile.height).toBeGreaterThan(profile.width);
      expect(Number.isInteger(profile.width) && Number.isInteger(profile.height)).toBe(true);
    }
  });

  it('includes the default profile', () => {
    expect(KINDLE_PROFILES.some((profile) => profile.id === DEFAULT_KINDLE_PROFILE_ID)).toBe(true);
  });

  it('returns the requested profile', () => {
    expect(getKindleProfile('scribe')).toMatchObject({ width: 1860, height: 2480, color: false });
    expect(getKindleProfile('colorsoft').color).toBe(true);
  });

  it('falls back to the default profile', () => {
    expect(getKindleProfile().id).toBe(DEFAULT_KINDLE_PROFILE_ID);
    expect(getKindleProfile('').id).toBe(DEFAULT_KINDLE_PROFILE_ID);
    expect(getKindleProfile('kindle-9000').id).toBe(DEFAULT_KINDLE_PROFILE_ID);
  });
});
