/**
 * Small handwritten MangaDex responses for tests, trimmed from real
 * responses recorded on 2026-11-17.
 */
import type { ChapterEntity, MangaEntity } from './api';

export const YOTSUBA_ID = '58be6aa6-06cb-4ca5-bd20-f1392ce451fb';
export const WEBTOON_ID = '32d76d19-8a05-4db0-9fc2-e0b0648fe9d0';

export function manga(overrides: Partial<MangaEntity['attributes']> = {}, id = YOTSUBA_ID, relationships?: MangaEntity['relationships']): MangaEntity {
  return {
    id,
    type: 'manga',
    attributes: {
      title: { 'ja-ro': 'Yotsuba to!' },
      altTitles: [{ ja: 'よつばと!' }, { en: 'Yotsuba&!' }, { 'pt-br': 'Yotsuba&!' }],
      description: {
        en: "Yotsuba is a **strange** little girl!\n\n---\n- **Won the [Excellence Award](https://example.org/award) in 2006**\n\n\n---\nOfficial Release:\n- Indonesian release by Elex Media (2007)",
        ru: 'Йоцуба',
      },
      originalLanguage: 'ja',
      status: 'hiatus',
      year: 2003,
      contentRating: 'safe',
      tags: [{ id: '4d32cc48-9f00-4cca-9b5a-a839f0764984', type: 'tag', attributes: { name: { en: 'Comedy' }, group: 'genre' } }],
      availableTranslatedLanguages: ['vi', 'en', 'pt-br', null],
      links: { al: '30104', mu: 'auem2hr', mal: '104', raw: 'https://comic-walker.com/detail/KC_003331_S', engtl: 'javascript:alert(1)' },
      latestUploadedChapter: 'b82f842f-d581-49cf-bee1-6f9d732e57ad',
      ...overrides,
    },
    relationships: relationships ?? [
      { id: 'a1', type: 'author', attributes: { name: 'Azuma Kiyohiko' } },
      { id: 'a1', type: 'artist', attributes: { name: 'Azuma Kiyohiko' } },
      { id: 'c1', type: 'cover_art', attributes: { fileName: '4b9aa4eb-4356-417a-bb74-4dc879141e19.jpg' } },
      { id: 'm2', type: 'manga' },
    ],
  };
}

let counter = 0;

export function chapter(attributes: Partial<ChapterEntity['attributes']> = {}, groups: Array<{ id: string; name: string }> = [{ id: 'g1', name: 'Momotato' }], mangaId = YOTSUBA_ID): ChapterEntity {
  counter += 1;
  return {
    id: attributes.chapter !== undefined ? `ch-${attributes.volume ?? 'x'}-${attributes.chapter ?? 'none'}-${counter}` : `ch-${counter}`,
    type: 'chapter',
    attributes: {
      volume: '1',
      chapter: '1',
      title: 'Yotsuba & Moving',
      translatedLanguage: 'en',
      externalUrl: null,
      publishAt: '2018-02-05T18:23:58+00:00',
      readableAt: '2018-02-05T18:23:58+00:00',
      createdAt: '2018-02-05T18:23:58+00:00',
      pages: 48,
      isUnavailable: false,
      ...attributes,
    },
    relationships: [
      ...groups.map(group => ({ id: group.id, type: 'scanlation_group', attributes: { name: group.name } })),
      { id: mangaId, type: 'manga' },
    ],
  };
}

export function collection<T>(data: T[], total = data.length, offset = 0, limit = data.length) {
  return { result: 'ok', response: 'collection', data, total, offset, limit };
}
