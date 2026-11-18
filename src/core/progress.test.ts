import { describe, expect, it } from 'vitest';
import { mergeProgress, readChapterIds, type ReadingProgress } from './types';
import { mergeRecords } from '../sync/merge';

const base = (over: Partial<ReadingProgress>): ReadingProgress => ({ key: 'mangadex:a', chapterId: 'c1', page: 0, pageCount: 10, updatedAt: 100, ...over });

describe('mergeProgress', () => {
  it('unions chapters read on different devices and keeps the newest position', () => {
    const phone = base({ chapterId: 'c3', page: 4, updatedAt: 300, chapters: { c3: { read: true, at: 300 } } });
    const laptop = base({ chapterId: 'c2', page: 9, updatedAt: 200, chapters: { c2: { read: true, at: 200 } } });
    const merged = mergeProgress(phone, laptop);
    expect(merged).toMatchObject({ chapterId: 'c3', page: 4, updatedAt: 300 });
    expect(readChapterIds(merged).sort()).toEqual(['c2', 'c3']);
    expect(merged.read?.sort()).toEqual(['c2', 'c3']);
  });

  it('lets a later unread beat an earlier read, per chapter', () => {
    const a = base({ updatedAt: 500, chapters: { c1: { read: false, at: 500 } } });
    const b = base({ updatedAt: 400, chapters: { c1: { read: true, at: 200 }, c2: { read: true, at: 400 } } });
    expect(readChapterIds(mergeProgress(a, b))).toEqual(['c2']);
  });

  it('reads legacy lists as read at the record time', () => {
    const legacy = base({ updatedAt: 100, read: ['c1', 'c2'] });
    const current = base({ updatedAt: 150, chapters: { c2: { read: false, at: 150 } } });
    expect(readChapterIds(mergeProgress(legacy, current))).toEqual(['c1']);
  });

  it('marks both sides changed when each had something new', () => {
    const local = { k: base({ updatedAt: 300, chapters: { c3: { read: true, at: 300 } } }) };
    const remote = { k: base({ updatedAt: 200, chapters: { c2: { read: true, at: 200 } } }) };
    const result = mergeRecords(local, remote, 1_000, mergeProgress);
    expect(result.localChanged).toEqual(['k']);
    expect(result.remoteChanged).toBe(true);
    const again = mergeRecords(result.merged, result.merged, 1_000, mergeProgress);
    expect(again).toMatchObject({ localChanged: [], remoteChanged: false });
  });
});
