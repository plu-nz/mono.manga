// @vitest-environment node
import { describe, expect, test, vi } from 'vitest';
import type { ChapterSummary } from '../../core/types';
import { ProviderError } from '../errors';
import { createMangaDexProvider, mangaDexTitleUrl } from './index';
import { inferMode, markdownToText, pickTitle, sortChapters, toMangaDexDate } from './map';
import { WEBTOON_ID, YOTSUBA_ID, chapter, collection, manga } from './test-fixtures';

const ORIGIN = 'https://manga.plu.nz';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A fetch mock that answers by path and records parsed requests. */
function mockFetch(handler: (path: string, params: URLSearchParams) => unknown) {
  const calls: Array<{ path: string; params: URLSearchParams }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), ORIGIN);
    const path = url.pathname.replace(/^\/api\/mangadex\//, '');
    calls.push({ path, params: url.searchParams });
    const result = handler(path, url.searchParams);
    return result instanceof Response ? result : jsonResponse(result);
  });
  const provider = createMangaDexProvider({ fetch: fetcher as unknown as typeof fetch, origin: ORIGIN });
  return { provider, calls, fetcher };
}

describe('title and text mapping', () => {
  test('prefers English, then the original-language romanization, then the main title', () => {
    expect(pickTitle(manga())).toBe('Yotsuba&!');
    expect(pickTitle(manga({ altTitles: [{ ja: 'よつばと!' }] }))).toBe('Yotsuba to!');
    expect(pickTitle(manga({ title: { ja: 'よつばと!' }, altTitles: [{ 'ja-ro': 'Yotsuba to!' }] }))).toBe('Yotsuba to!');
    expect(pickTitle(manga({ title: { ko: '나 혼자만 레벨업' }, altTitles: [{ 'ko-ro': 'Na Honjaman Level Up' }], originalLanguage: 'ko' }))).toBe('Na Honjaman Level Up');
    expect(pickTitle(manga({ title: { fr: 'Titre' }, altTitles: [{ de: 'Titel' }], originalLanguage: 'ja' }))).toBe('Titre');
    expect(pickTitle(manga({ title: {}, altTitles: [] }))).toBe('Untitled');
  });

  test('reduces Markdown descriptions to plain text', () => {
    const text = markdownToText("**Bold** and *italic* and __under__ with [a link](https://x.y/(z)) ![img](https://x/y.png)\n\n---\n\n## Heading\n> quote\n* item\n\n\n\n[b]BB[/b] [url=https://x]label[/url] &amp; &#39;ok&#39; <b>tag</b><script>x</script>");
    expect(text).toBe("Bold and italic and under with a link\n\nHeading\nquote\n- item\n\nBB label & 'ok' tagx");
    expect(markdownToText('snake_case_name stays and 2*3*4 too')).toBe('snake_case_name stays and 2*3*4 too');
  });

  test('infers the reading mode', () => {
    expect(inferMode(manga())).toBe('rtl');
    expect(inferMode(manga({ originalLanguage: 'en' }))).toBe('ltr');
    const longStrip = { id: '3e2b8dae-350e-4ab8-a8ce-016e844b9f0d', type: 'tag' as const, attributes: { name: { en: 'Long Strip' }, group: 'format' } };
    const webComic = { id: 'e197df38-d0e7-43b5-9b09-2842d0c326dd', type: 'tag' as const, attributes: { name: { en: 'Web Comic' }, group: 'format' } };
    expect(inferMode(manga({ tags: [longStrip] }))).toBe('vertical');
    expect(inferMode(manga({ tags: [webComic], originalLanguage: 'ko' }))).toBe('vertical');
    expect(inferMode(manga({ tags: [webComic], originalLanguage: 'ja' }))).toBe('rtl');
  });

  test('formats dates for MangaDex filters', () => {
    expect(toMangaDexDate('2026-11-17T12:34:56.789Z')).toBe('2026-11-17T12:34:56');
    expect(toMangaDexDate('2026-11-17T09:00:00-03:00')).toBe('2026-11-17T12:00:00');
    expect(() => toMangaDexDate('nope')).toThrow(RangeError);
  });
});

describe('search', () => {
  test('builds the query and maps results with proxied covers', async () => {
    const { provider, calls } = mockFetch(() => collection([manga()], 42, 20, 20));
    const result = await provider.search({ text: ' yotsuba ', languages: ['en', 'pt-br'], offset: 20, limit: 20 });
    const { path, params } = calls[0];
    expect(path).toBe('manga');
    expect(params.get('title')).toBe('yotsuba');
    expect(params.getAll('includes[]')).toEqual(['cover_art', 'author', 'artist']);
    expect(params.getAll('contentRating[]')).toEqual(['safe', 'suggestive']);
    expect(params.getAll('availableTranslatedLanguage[]')).toEqual(['en', 'pt-br']);
    expect(params.get('order[relevance]')).toBe('desc');
    expect(params.get('offset')).toBe('20');
    expect(result).toMatchObject({ total: 42, offset: 20, limit: 20 });
    expect(result.items[0]).toEqual({
      provider: 'mangadex',
      id: YOTSUBA_ID,
      title: 'Yotsuba&!',
      coverUrl: `${ORIGIN}/api/mangadex/covers/${YOTSUBA_ID}/4b9aa4eb-4356-417a-bb74-4dc879141e19.jpg.512.jpg`,
      description: 'Yotsuba is a strange little girl!\n\n- Won the Excellence Award in 2006\n\nOfficial Release:\n- Indonesian release by Elex Media (2007)',
      authors: ['Azuma Kiyohiko'],
      status: 'hiatus',
      year: 2003,
      originalLanguage: 'ja',
      contentRating: 'safe',
      tags: ['Comedy'],
    });
  });

  test('passes caller content ratings and orders by popularity without text', async () => {
    const { provider, calls } = mockFetch(() => collection([]));
    await provider.search({ text: '', contentRating: ['safe', 'suggestive', 'erotica'] });
    expect(calls[0].params.get('title')).toBeNull();
    expect(calls[0].params.getAll('contentRating[]')).toEqual(['safe', 'suggestive', 'erotica']);
    expect(calls[0].params.get('order[followedCount]')).toBe('desc');
    expect(calls[0].params.get('limit')).toBe('20');
  });

  test('can build direct image URLs for non-browser clients', async () => {
    const fetcher = vi.fn(async () => jsonResponse(collection([manga()])));
    const provider = createMangaDexProvider({ fetch: fetcher as unknown as typeof fetch, directImages: true });
    const result = await provider.search({ text: 'x' });
    expect(result.items[0].coverUrl).toBe(`https://uploads.mangadex.org/covers/${YOTSUBA_ID}/4b9aa4eb-4356-417a-bb74-4dc879141e19.jpg.512.jpg`);
  });
});

describe('getManga', () => {
  test('maps details, links, and languages', async () => {
    const { provider, calls } = mockFetch(() => ({ result: 'ok', data: manga() }));
    const details = await provider.getManga(YOTSUBA_ID);
    expect(calls[0].path).toBe(`manga/${YOTSUBA_ID}`);
    expect(details.defaultMode).toBe('rtl');
    expect(details.altTitles).toEqual(['Yotsuba to!', 'よつばと!']);
    expect(details.availableLanguages).toEqual(['vi', 'en', 'pt-br']);
    expect(details.links).toEqual([
      { label: 'MangaDex', url: `https://mangadex.org/title/${YOTSUBA_ID}` },
      { label: 'AniList', url: 'https://anilist.co/manga/30104' },
      { label: 'MangaUpdates', url: 'https://www.mangaupdates.com/series/auem2hr' },
      { label: 'MyAnimeList', url: 'https://myanimelist.net/manga/104' },
      { label: 'Official (original)', url: 'https://comic-walker.com/detail/KC_003331_S' },
    ]);
  });

  test('rejects ids that are not UUIDs without a request', async () => {
    const { provider, fetcher } = mockFetch(() => ({}));
    await expect(provider.getManga('../user/me')).rejects.toMatchObject({ code: 'not_found' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('errors', () => {
  test.each([
    [429, 'rate_limited'],
    [404, 'not_found'],
    [503, 'upstream'],
    [403, 'upstream'],
  ])('maps HTTP %i to %s', async (status, code) => {
    const { provider } = mockFetch(() => jsonResponse({ result: 'error' }, status, { 'retry-after': '7' }));
    const error = await provider.getManga(YOTSUBA_ID).catch(e => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe(code);
    if (code === 'rate_limited') expect(error.retryAfter).toBe(7);
  });

  test('maps network failures and error results', async () => {
    const offline = createMangaDexProvider({ fetch: (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch });
    await expect(offline.getManga(YOTSUBA_ID)).rejects.toMatchObject({ code: 'network' });
    const { provider } = mockFetch(() => ({ result: 'error', errors: [] }));
    await expect(provider.getManga(YOTSUBA_ID)).rejects.toMatchObject({ code: 'upstream' });
  });

  test('respects AbortSignal', async () => {
    const controller = new AbortController();
    controller.abort();
    const { provider, fetcher } = mockFetch(() => ({}));
    await expect(provider.getManga(YOTSUBA_ID, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();

    const late = new AbortController();
    const abortingFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      late.abort();
      throw init?.signal?.reason ?? new DOMException('Aborted', 'AbortError');
    });
    const aborting = createMangaDexProvider({ fetch: abortingFetch as unknown as typeof fetch });
    const error = await aborting.getManga(YOTSUBA_ID, late.signal).catch(e => e);
    expect(error).not.toBeInstanceOf(ProviderError);
    expect(error.name).toBe('AbortError');
  });
});

describe('getChapters', () => {
  test('paginates the feed with the expected filters', async () => {
    const first = Array.from({ length: 500 }, (_, i) => chapter({ volume: null, chapter: String(i + 1) }));
    const second = [chapter({ volume: null, chapter: '501' }), chapter({ volume: null, chapter: '502', pages: 0 })];
    const { provider, calls } = mockFetch((_path, params) => (params.get('offset') === '0' ? collection(first, 502, 0, 500) : collection(second, 502, 500, 500)));
    const chapters = await provider.getChapters(YOTSUBA_ID, { languages: ['en'] });
    expect(calls).toHaveLength(2);
    const { path, params } = calls[0];
    expect(path).toBe(`manga/${YOTSUBA_ID}/feed`);
    expect(params.get('limit')).toBe('500');
    expect(params.getAll('translatedLanguage[]')).toEqual(['en']);
    expect(params.get('order[volume]')).toBe('asc');
    expect(params.get('order[chapter]')).toBe('asc');
    expect(params.getAll('includes[]')).toEqual(['scanlation_group']);
    expect(params.getAll('contentRating[]')).toEqual(['safe', 'suggestive', 'erotica', 'pornographic']);
    // includeExternalUrl=1 would return ONLY external chapters; it must be absent.
    expect(params.has('includeExternalUrl')).toBe(false);
    expect(params.get('includeFuturePublishAt')).toBe('0');
    expect(calls[1].params.get('offset')).toBe('500');
    // The zero-page chapter without an external URL is skipped.
    expect(chapters).toHaveLength(501);
    expect(chapters.at(-1)?.number).toBe('501');
  });

  test('maps groups and external chapters and keeps multiple releases', async () => {
    const { provider } = mockFetch(() => collection([
      chapter({ chapter: '2', title: '' }, [{ id: 'g1', name: 'Alpha' }, { id: 'g2', name: 'Beta' }]),
      chapter({ chapter: '2', publishAt: '2019-01-01T00:00:00+00:00', readableAt: '2019-01-01T00:00:00+00:00' }, [{ id: 'g3', name: 'Gamma' }]),
      chapter({ chapter: '3', pages: 0, externalUrl: 'https://mangaplus.shueisha.co.jp/viewer/1' }, []),
      chapter({ chapter: '4', pages: 0, externalUrl: 'javascript:alert(1)' }),
    ]));
    const chapters = await provider.getChapters(YOTSUBA_ID, { languages: ['en'] });
    expect(chapters.map(c => [c.number, c.groups, c.externalUrl])).toEqual([
      ['2', ['Alpha', 'Beta'], undefined],
      ['2', ['Gamma'], undefined],
      ['3', undefined, 'https://mangaplus.shueisha.co.jp/viewer/1'],
    ]);
    expect(chapters[0]).toMatchObject({ provider: 'mangadex', mangaId: YOTSUBA_ID, volume: '1', language: 'en', pages: 48, publishedAt: '2018-02-05T18:23:58+00:00' });
    expect(chapters[0].title).toBeUndefined();
  });
});

describe('sortChapters', () => {
  const c = (number?: string, volume?: string, id = `${volume ?? '-'}:${number ?? '-'}`): ChapterSummary =>
    ({ provider: 'mangadex', mangaId: 'm', id, language: 'en', pages: 1, ...(number ? { number } : {}), ...(volume ? { volume } : {}) });

  test('sorts numerically, places extras after their volume and loose oneshots last', () => {
    const sorted = sortChapters([
      c('10'), c('2', '1'), c('10.5'), c(undefined, undefined, 'oneshot'), c('1', '1'), c(undefined, '1', 'extra-v1'), c('3', '2'), c('11', '3'), c(undefined, '0', 'prologue'),
    ]);
    expect(sorted.map(item => item.id)).toEqual(['0:-', '1:1', '1:2', 'extra-v1', '2:3', '-:10', '-:10.5', '3:11', 'oneshot'].map(id => (id === '0:-' ? 'prologue' : id)));
  });

  test('handles volume-less series', () => {
    expect(sortChapters([c('100'), c('9'), c('99.5')]).map(item => item.number)).toEqual(['9', '99.5', '100']);
  });
});

describe('getPages', () => {
  const server = {
    result: 'ok',
    baseUrl: 'https://abc.mangadex.network:44300/token',
    chapter: { hash: '74f21f6b8eb1d5851cc4f51ff3dcfdd1', data: ['x1-a.jpg', 'x2-b.png'], dataSaver: ['x1-a.jpg', 'x2-b.jpg'] },
  };

  test('builds proxied URLs with the other quality as fallback', async () => {
    const { provider, calls } = mockFetch(() => server);
    const pages = await provider.getPages('a3de73a0-ec90-42f1-bdb2-8ab7d95fa2c0', { dataSaver: false });
    expect(calls[0].path).toBe('at-home/server/a3de73a0-ec90-42f1-bdb2-8ab7d95fa2c0');
    const base = encodeURIComponent(server.baseUrl);
    expect(pages).toEqual([
      { index: 0, url: `${ORIGIN}/api/mangadex/page/data/${server.chapter.hash}/x1-a.jpg?base=${base}`, fallbackUrl: `${ORIGIN}/api/mangadex/page/data-saver/${server.chapter.hash}/x1-a.jpg?base=${base}` },
      { index: 1, url: `${ORIGIN}/api/mangadex/page/data/${server.chapter.hash}/x2-b.png?base=${base}`, fallbackUrl: `${ORIGIN}/api/mangadex/page/data-saver/${server.chapter.hash}/x2-b.jpg?base=${base}` },
    ]);
  });

  test('data saver swaps qualities; direct mode uses the node URL as-is', async () => {
    const { provider } = mockFetch(() => server);
    const pages = await provider.getPages('a3de73a0-ec90-42f1-bdb2-8ab7d95fa2c0', { dataSaver: true });
    expect(pages[1].url).toContain('/page/data-saver/');
    expect(pages[1].fallbackUrl).toContain('/page/data/');
    const direct = createMangaDexProvider({ fetch: (async () => jsonResponse(server)) as typeof fetch, directImages: true });
    const [first] = await direct.getPages('a3de73a0-ec90-42f1-bdb2-8ab7d95fa2c0', { dataSaver: false });
    expect(first.url).toBe(`https://abc.mangadex.network:44300/token/data/${server.chapter.hash}/x1-a.jpg`);
  });
});

describe('getUpdates', () => {
  test('batches title lookups and reads feeds only for changed titles', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const changedId = ids[120];
    const { provider, calls } = mockFetch((path, params) => {
      if (path === 'manga') {
        return collection(params.getAll('ids[]').map((id, i) => manga({ latestUploadedChapter: `latest-${id}` }, id)).filter((_, i) => i % 2 === 0));
      }
      if (path === 'chapter') {
        return collection(params.getAll('ids[]').map(chapterId => {
          const fresh = chapterId === `latest-${changedId}`;
          const date = fresh ? '2026-11-17T10:00:00+00:00' : '2026-01-01T00:00:00+00:00';
          return { ...chapter({ publishAt: date, readableAt: date, createdAt: date }), id: chapterId };
        }));
      }
      return collection([
        chapter({ chapter: '51', publishAt: '2026-11-17T09:00:00+00:00', readableAt: '2026-11-17T09:00:00+00:00' }, undefined, changedId),
        chapter({ chapter: '52', publishAt: '2026-11-17T10:00:00+00:00', readableAt: '2026-11-17T10:00:00+00:00' }, undefined, changedId),
      ]);
    });
    const updates = await provider.getUpdates!([...ids, ids[0], 'not-a-uuid'], { languages: ['en'], since: '2026-11-16T12:00:00.000Z' });
    const mangaCalls = calls.filter(call => call.path === 'manga');
    expect(mangaCalls.map(call => call.params.getAll('ids[]').length)).toEqual([100, 50]);
    expect(mangaCalls[0].params.getAll('contentRating[]')).toHaveLength(4);
    const feedCalls = calls.filter(call => call.path.endsWith('/feed'));
    expect(feedCalls.map(call => call.path)).toEqual([`manga/${changedId}/feed`]);
    const feed = feedCalls[0].params;
    expect(feed.get('publishAtSince')).toBe('2026-11-16T12:00:00');
    expect(feed.getAll('translatedLanguage[]')).toEqual(['en']);
    expect(feed.get('order[publishAt]')).toBe('desc');
    expect(feed.get('limit')).toBe('100');
    expect(updates.map(update => [update.mangaId, update.number])).toEqual([[changedId, '52'], [changedId, '51']]);
  });
});

describe('provider metadata', () => {
  test('exposes attribution and title links', () => {
    const provider = createMangaDexProvider();
    expect(provider.attribution).toEqual({ text: 'Data and images from MangaDex', url: 'https://mangadex.org' });
    expect(provider.capabilities).toEqual({ search: true, updates: true });
    expect(mangaDexTitleUrl(WEBTOON_ID)).toBe(`https://mangadex.org/title/${WEBTOON_ID}`);
  });
});
