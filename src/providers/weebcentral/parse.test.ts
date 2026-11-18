import { describe, expect, it } from 'vitest';
import { parseChapterList, parseSearchResults } from './parse';

const SEARCH = `
<article class="bg-base-300 flex gap-4 p-4">
  <a href="https://weebcentral.com/series/01J76XY7VSG3R5ANYPDWTXDVP6/Kingdom">
    <img src="https://temp.compsci88.com/cover/fallback/01J76XY7VSG3R5ANYPDWTXDVP6.jpg" alt="Kingdom cover">
  </a>
  <div><strong>Year: </strong> <span>2006</span></div>
</article>
<article class="bg-base-300 flex gap-4 p-4">
  <a href="https://weebcentral.com/series/01J76XY800718ZGG7EVQR74DXE/Kingdom-Of-Zombie">
    <img src="x.jpg" alt="Kingdom of Zombie &amp; Friends cover">
  </a>
</article>`;

const row = (id: string, label: string, date: string) => `
<div class="flex items-center" x-data="{ new_chapter: checkNewChapter('${date}') }">
  <a href="/chapters/${id}" class="flex-1">
    <span class="me-2"><img src="/static/images/chapter-badge.svg" alt=""></span>
    <span class="grow flex"><span class="">${label}</span>
      <span x-show="last_read_chapter === '${id}'"><svg><path d="M0"/></svg><span class="hidden md:inline">Last Read</span></span>
    </span>
    <time class="text-datetime" datetime="${date}">${date}</time>
  </a>
</div>`;

describe('Weeb Central parsers', () => {
  it('reads search results with cover and year', () => {
    expect(parseSearchResults(SEARCH)).toEqual([
      { provider: 'weebcentral', id: '01J76XY7VSG3R5ANYPDWTXDVP6', title: 'Kingdom', coverUrl: 'https://temp.compsci88.com/cover/small/01J76XY7VSG3R5ANYPDWTXDVP6.webp', year: 2006 },
      { provider: 'weebcentral', id: '01J76XY800718ZGG7EVQR74DXE', title: 'Kingdom of Zombie & Friends', coverUrl: 'https://temp.compsci88.com/cover/small/01J76XY800718ZGG7EVQR74DXE.webp' },
    ]);
  });

  it('reads the chapter list in reading order', () => {
    const html = row('01M6PKD4Y9PM0AEGK525773E9C', 'Chapter 893', '2026-11-05T19:36:37.577Z')
      + row('01M66N9NM7K3DQGS0668BC214H', 'Chapter 892.5', '2026-10-30T15:01:49.831Z')
      + row('01J76XYTQF0NESRNNX434QB7TG', 'Special Episode', '2024-09-07T17:04:15.717Z');
    expect(parseChapterList(html)).toEqual([
      { id: '01J76XYTQF0NESRNNX434QB7TG', label: 'Special Episode', publishedAt: '2024-09-07T17:04:15.717Z' },
      { id: '01M66N9NM7K3DQGS0668BC214H', label: 'Chapter 892.5', number: '892.5', publishedAt: '2026-10-30T15:01:49.831Z' },
      { id: '01M6PKD4Y9PM0AEGK525773E9C', label: 'Chapter 893', number: '893', publishedAt: '2026-11-05T19:36:37.577Z' },
    ]);
  });
});
