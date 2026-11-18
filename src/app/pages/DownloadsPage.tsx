import { createMemo, createResource, For, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { Button } from '@plunz/storybook';
import { chapterLabel } from '../../core/types';
import { listDownloads } from '../../storage/downloads';
import { storageEstimate } from '../../storage/db';
import { cancelDownloads, downloadStates, downloadsVersion, removeDownload } from '../../library/download-manager';
import { formatBytes, t, tn } from '../../i18n';
import { EmptyState, IconButton, ProgressBar } from '../ui';

export default function DownloadsPage() {
  const [records, { refetch }] = createResource(downloadsVersion, () => listDownloads());
  const [estimate] = createResource(downloadsVersion, () => storageEstimate());
  const groups = createMemo(() => {
    const map = new Map<string, { title: string; mangaKey: string; items: NonNullable<ReturnType<typeof records>> }>();
    for (const record of records() ?? []) {
      if (!map.has(record.mangaKey)) map.set(record.mangaKey, { title: record.mangaTitle, mangaKey: record.mangaKey, items: [] });
      map.get(record.mangaKey)!.items.push(record);
    }
    return [...map.values()];
  });
  const active = createMemo(() => Object.values(downloadStates).filter(state => state.status === 'queued' || state.status === 'downloading'));

  async function remove(key: string) {
    await removeDownload(key);
    await refetch();
  }

  return (
    <section class="page" aria-labelledby="downloads-heading">
      <header class="page-head"><h1 id="downloads-heading">{t('Downloads')}</h1></header>

      <Show when={estimate()}>
        {value => <p class="muted">{t('Using {used} of about {quota} available on this device.', { used: formatBytes(value().usage), quota: formatBytes(value().quota) })}</p>}
      </Show>

      <Show when={active().length}>
        <div class="stack card-like">
          <ProgressBar
            value={active().reduce((sum, state) => sum + state.done, 0)}
            max={active().reduce((sum, state) => sum + state.total, 0)}
            label={tn(active().length, 'Saving {count} chapter', 'Saving {count} chapters')}
          />
          <Button type="button" size="sm" variant="outline" onClick={cancelDownloads}>{t('Stop')}</Button>
        </div>
      </Show>

      <Show when={records() && groups().length === 0}>
        <EmptyState icon="download" title={t('Nothing saved offline')}>
          <p>{t('Select chapters on a title and choose “Save offline” to read without a connection. Imported files also appear here.')}</p>
        </EmptyState>
      </Show>

      <For each={groups()}>
        {group => (
          <div class="download-group">
            <h2><A href={`/manga/${group.mangaKey.replace(':', '/')}`}>{group.title}</A></h2>
            <ul class="chapters">
              <For each={group.items}>
                {record => (
                  <li class="chapter">
                    <div class="chapter-link static">
                      <span class="chapter-title">{chapterLabel(record.chapter)}</span>
                      <span class="chapter-meta">
                        {[tn(record.pageCount, '{count} page', '{count} pages'), formatBytes(record.bytes), record.status === 'partial' ? t('Partial') : undefined].filter(Boolean).join(' · ')}
                      </span>
                    </div>
                    <IconButton icon="trash" label={t('Delete {chapter}', { chapter: chapterLabel(record.chapter) })} onClick={() => void remove(record.chapterKey)} />
                  </li>
                )}
              </For>
            </ul>
          </div>
        )}
      </For>
    </section>
  );
}
