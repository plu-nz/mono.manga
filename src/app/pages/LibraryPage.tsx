import { createMemo, createSignal, For, onMount, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { Button } from '@plunz/storybook';
import { chapterLabel } from '../../core/types';
import { libraryEntries, progress, ready } from '../../library/store';
import { checkForUpdates, checking, markUpdatesSeen, unseenCount, updates } from '../../library/updates';
import { formatDate, t, tn } from '../../i18n';
import { Cover, EmptyState, Icon, errorMessage, toast } from '../ui';
import { BatchSheet } from '../../kindle/BatchSheet';

type Tab = 'all' | 'favorites' | 'updates';

export default function LibraryPage() {
  const [tab, setTab] = createSignal<Tab>('all');
  const [batchOpen, setBatchOpen] = createSignal(false);
  const hasFavorites = () => libraryEntries().some(entry => entry.favorite);
  const entries = createMemo(() => {
    const all = libraryEntries();
    return tab() === 'favorites' ? all.filter(entry => entry.favorite) : all;
  });

  onMount(() => { void checkForUpdates().catch(() => undefined); });

  async function refresh() {
    try {
      const found = await checkForUpdates({ force: true });
      toast(found ? tn(found, '{count} new chapter.', '{count} new chapters.') : t('No new chapters.'));
    } catch (error) {
      toast(errorMessage(error));
    }
  }

  return (
    <section class="page" aria-labelledby="library-heading">
      <header class="page-head">
        <h1 id="library-heading">{t('Library')}</h1>
        <Show when={hasFavorites()}>
          <Button type="button" size="sm" onClick={() => setBatchOpen(true)}>
            <Icon name="send" size={18} /> {t('Send new chapters')}
          </Button>
        </Show>
      </header>
      <BatchSheet open={batchOpen()} onClose={() => setBatchOpen(false)} />
      <div class="tabs" role="tablist" aria-label={t('Library sections')}>
        <For each={[
          { id: 'all' as const, label: t('All') },
          { id: 'favorites' as const, label: t('Favorites') },
          { id: 'updates' as const, label: unseenCount() ? `${t('Updates')} (${unseenCount()})` : t('Updates') },
        ]}>
          {item => (
            <button type="button" role="tab" class="tab" aria-selected={tab() === item.id} onClick={() => setTab(item.id)}>{item.label}</button>
          )}
        </For>
      </div>

      <Show when={tab() !== 'updates'} fallback={
        <div class="stack">
          <div class="row-between">
            <Button type="button" size="sm" variant="outline" disabled={checking()} onClick={() => void refresh()}>{checking() ? t('Checking…') : t('Check for new chapters')}</Button>
            <Show when={unseenCount()}><button type="button" class="text-button" onClick={() => void markUpdatesSeen()}>{t('Mark all as seen')}</button></Show>
          </div>
          <Show when={updates().length} fallback={<EmptyState icon="bell" title={t('No new chapters yet')}><p>{t('New chapters of titles in your library appear here. The app checks when you open it.')}</p></EmptyState>}>
            <ul class="updates">
              <For each={updates()}>
                {item => (
                  <li classList={{ unseen: !item.seen }}>
                    <A href={`/read/${item.chapter.provider}/${encodeURIComponent(item.chapter.mangaId)}/${encodeURIComponent(item.chapter.id)}`}>
                      <strong>{item.mangaTitle}</strong>
                      <span>{chapterLabel(item.chapter)}</span>
                      <span class="muted small">{[item.chapter.groups?.join(', '), formatDate(item.chapter.publishedAt)].filter(Boolean).join(' · ')}</span>
                    </A>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      }>
        <Show when={ready() && entries().length === 0}>
          <EmptyState icon="library" title={tab() === 'favorites' ? t('No favorites yet') : t('Your library is empty')}>
            <p>{tab() === 'favorites' ? t('Tap the star on a title to keep it here.') : t('Search for a title or import your own files to start reading.')}</p>
            <A class="plz-button plz-button--solid plz-button--md" href="/search">{t('Find manga')}</A>
          </EmptyState>
        </Show>
        <ul class="grid">
          <For each={entries()}>
            {entry => {
              const current = () => progress[entry.key];
              return (
                <li>
                  <A class="tile" href={`/manga/${entry.provider}/${encodeURIComponent(entry.mangaId)}`}>
                    <Cover url={entry.coverUrl} title={entry.title} />
                    <span class="tile-title">{entry.title}</span>
                    <Show when={current() && !current()!.deleted && current()!.chapterLabel}>
                      <span class="tile-meta">{current()!.chapterLabel}</span>
                    </Show>
                    <Show when={updates().some(item => !item.seen && item.mangaKey === entry.key)}>
                      <span class="tile-badge">{t('New')}</span>
                    </Show>
                  </A>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
    </section>
  );
}
