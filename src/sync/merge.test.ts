import { describe, expect, it } from 'vitest';
import type { SyncRecord } from '../core/types';
import { TOMBSTONE_TTL_MS, jsonEqual, mergeRecords } from './merge';

interface Item extends SyncRecord {
  value: string;
}

const NOW = 1_800_000_000_000;
const T0 = NOW - 1_000_000;
/** `t` is relative to a recent base time so nothing is old enough to prune unless intended. */
const item = (value: string, t: number, deleted?: boolean): Item => ({ value, updatedAt: T0 + t, ...(deleted ? { deleted } : {}) });

describe('mergeRecords', () => {
  it('returns no changes when both sides are equal', () => {
    const records = { a: item('x', 1) };
    expect(mergeRecords(records, { a: item('x', 1) }, NOW)).toEqual({ merged: records, localChanged: [], remoteChanged: false });
  });

  it('applies last write wins per key', () => {
    const local = { a: item('local-new', 20), b: item('local-old', 5) };
    const remote = { a: item('remote-old', 10), b: item('remote-new', 30) };
    const result = mergeRecords(local, remote, NOW);
    expect(result.merged).toEqual({ a: local.a, b: remote.b });
    expect(result.localChanged).toEqual(['b']);
    expect(result.remoteChanged).toBe(true);
  });

  it('pulls remote-only keys and pushes local-only keys', () => {
    const result = mergeRecords({ l: item('l', 1) }, { r: item('r', 1) }, NOW);
    expect(Object.keys(result.merged).sort()).toEqual(['l', 'r']);
    expect(result.localChanged).toEqual(['r']);
    expect(result.remoteChanged).toBe(true);
  });

  it('keeps the remote value on ties', () => {
    const result = mergeRecords({ a: item('local', 10) }, { a: item('remote', 10) }, NOW);
    expect(result.merged.a.value).toBe('remote');
    expect(result.localChanged).toEqual(['a']);
    expect(result.remoteChanged).toBe(false);
  });

  it('treats equal content with different key order as unchanged', () => {
    const result = mergeRecords({ a: { updatedAt: T0, value: 'x' } as Item }, { a: { value: 'x', updatedAt: T0 } as Item }, NOW);
    expect(result.localChanged).toEqual([]);
    expect(result.remoteChanged).toBe(false);
  });

  it('lets a newer tombstone win and propagate', () => {
    const result = mergeRecords({ a: item('x', 10) }, { a: item('x', 20, true) }, NOW);
    expect(result.merged.a.deleted).toBe(true);
    expect(result.localChanged).toEqual(['a']);
  });

  it('lets a newer write resurrect an older tombstone', () => {
    const result = mergeRecords({ a: item('back', 30) }, { a: item('x', 20, true) }, NOW);
    expect(result.merged.a).toEqual(item('back', 30));
    expect(result.remoteChanged).toBe(true);
  });

  it('prunes tombstones older than 90 days', () => {
    const old = NOW - TOMBSTONE_TTL_MS - 1 - T0;
    const recent = NOW - TOMBSTONE_TTL_MS + 1 - T0;
    const result = mergeRecords({ gone: item('x', old, true) }, { gone: item('x', old, true), kept: item('y', recent, true) }, NOW);
    expect(Object.keys(result.merged)).toEqual(['kept']);
    expect(result.localChanged).toEqual(['kept']);
    expect(result.remoteChanged).toBe(true);
  });

  it('does not flag remote when a pruned tombstone exists only locally', () => {
    const old = NOW - TOMBSTONE_TTL_MS - 1 - T0;
    const result = mergeRecords({ gone: item('x', old, true) }, {}, NOW);
    expect(result).toEqual({ merged: {}, localChanged: [], remoteChanged: false });
  });

  it('ignores corrupt records and rewrites the remote', () => {
    const remote = { bad: { value: 'no-time' } as unknown as Item, a: item('x', 1) };
    const result = mergeRecords({ a: item('x', 1) }, remote, NOW);
    expect(result.merged).toEqual({ a: item('x', 1) });
    expect(result.remoteChanged).toBe(true);
  });
});

describe('jsonEqual', () => {
  it('compares nested JSON structurally and ignores undefined fields', () => {
    expect(jsonEqual({ a: [1, { b: 2 }], c: undefined }, { a: [1, { b: 2 }] })).toBe(true);
    expect(jsonEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(jsonEqual({ a: 1 }, [1])).toBe(false);
  });
});
