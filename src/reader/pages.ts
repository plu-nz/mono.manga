import type { ChapterSummary, PageRef } from '../core/types';
import { getProvider } from '../providers';
import { chapterKey } from '../storage/db';
import { fetchPageBlob, getDownload, getStoredPage } from '../storage/downloads';

/**
 * A page that can be shown (as a URL) or converted (as a Blob), whether it
 * is stored offline or still on the provider's image server.
 */
export interface PageHandle {
  index: number;
  /** Displayable URL: an object URL for stored pages, otherwise the remote URL. */
  src(): Promise<string>;
  /** Alternative remote URL to try when the displayed one fails. */
  fallback?: string;
  blob(signal?: AbortSignal): Promise<Blob>;
  release(): void;
}

export async function loadChapterPages(chapter: ChapterSummary, options: { dataSaver: boolean; signal?: AbortSignal }): Promise<PageHandle[]> {
  const key = chapterKey(chapter);
  const download = await getDownload(key);
  let refs: PageRef[];
  if (download?.status === 'complete' || chapter.provider === 'local') {
    refs = Array.from({ length: download?.pageCount ?? chapter.pages }, (_, index) => ({ index, url: '' }));
  } else {
    refs = await getProvider(chapter.provider).getPages(chapter.id, { dataSaver: options.dataSaver }, options.signal);
  }
  return refs.map(ref => createHandle(key, ref));
}

/** Page references from the provider, for downloading. */
export async function remotePageRefs(chapter: ChapterSummary, dataSaver: boolean, signal?: AbortSignal): Promise<PageRef[]> {
  return getProvider(chapter.provider).getPages(chapter.id, { dataSaver }, signal);
}

function createHandle(key: string, ref: PageRef): PageHandle {
  let objectUrl: string | undefined;
  return {
    index: ref.index,
    fallback: ref.fallbackUrl,
    async src() {
      if (objectUrl) return objectUrl;
      const stored = await getStoredPage(key, ref.index);
      if (stored) {
        objectUrl = URL.createObjectURL(stored);
        return objectUrl;
      }
      if (!ref.url) throw Object.assign(new Error('Page missing'), { code: 'page_missing' });
      return ref.url;
    },
    async blob(signal) {
      const stored = await getStoredPage(key, ref.index);
      if (stored) return stored;
      if (!ref.url) throw Object.assign(new Error('Page missing'), { code: 'page_missing' });
      return fetchPageBlob(ref, signal);
    },
    release() {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = undefined;
    },
  };
}
