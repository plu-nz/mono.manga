import { createMemo, createSignal, For, onSettled, Show } from 'solid-js';
import { Button } from '@plunz/storybook';
import { libraryEntries, progress, ready } from '../../library/store';
import { checkingNewChapters, newChaptersFor, refreshNewChapters, totalNewChapters } from '../../library/new-chapters';
import { BatchSheet } from '../../kindle/BatchSheet';
import { t, tn } from '../../i18n';
import { Cover, EmptyState, Icon, IconButton } from '../ui';

/** Favorites, each with its count of new chapters, and one tap to send them all to the Kindle. */
export default function LibraryPage() {
  const [batchOpen, setBatchOpen] = createSignal(false);
  const favorites = createMemo(() =>
    libraryEntries()
      .filter(entry => entry.favorite)
      // Titles with new chapters first, then the most recently changed.
      .sort((a, b) => newChaptersFor(b.key).length - newChaptersFor(a.key).length || b.updatedAt - a.updatedAt),
  );

  onSettled(() => { void refreshNewChapters(); });

  return (
    <section class="page" aria-labelledby="library-heading">
      <header class="page-head">
        <h1 id="library-heading">{t('Library')}</h1>
        <Show when={favorites().length}>
          <div class="head-actions">
            <IconButton icon="sync" class={checkingNewChapters() ? 'spinning' : ''} label={t('Check for new chapters')} disabled={checkingNewChapters()} onClick={() => void refreshNewChapters({ force: true })} />
            <Button type="button" size="sm" onClick={() => setBatchOpen(true)}>
              <Icon name="send" size={18} /> {t('Send new chapters')}
            </Button>
          </div>
        </Show>
      </header>
      <BatchSheet open={batchOpen()} onClose={() => { setBatchOpen(false); void refreshNewChapters({ force: true }); }} />

      <Show when={favorites().length}>
        <p class="muted small" role="status">
          {checkingNewChapters()
            ? t('Checking for new chapters…')
            : totalNewChapters()
              ? tn(totalNewChapters(), '{count} new chapter in your library.', '{count} new chapters in your library.')
              : t('No new chapters.')}
        </p>
      </Show>

      <Show when={ready() && favorites().length === 0}>
        <EmptyState icon="library" title={t('Your library is empty')}>
          <p>{t('Tap the star on a title to add it here. New chapters are counted each time you open this screen.')}</p>
          <a class="plz-button plz-button--solid plz-button--md" href="/search">{t('Find manga')}</a>
        </EmptyState>
      </Show>

      <ul class="grid">
        <For each={favorites()}>
          {entry => {
            const current = () => progress[entry.key];
            const count = () => newChaptersFor(entry.key).length;
            return (
              <li>
                <a class="tile" href={`/manga/${entry.provider}/${encodeURIComponent(entry.mangaId)}`}>
                  <Cover url={entry.coverUrl} title={entry.title} />
                  <span class="tile-title">{entry.title}</span>
                  <Show when={current() && !current()!.deleted && current()!.chapterLabel}>
                    <span class="tile-meta">{current()!.chapterLabel}</span>
                  </Show>
                  <Show when={count()}>
                    <span class="tile-badge" aria-label={tn(count(), '{count} new chapter', '{count} new chapters')}>{count()}</span>
                  </Show>
                </a>
              </li>
            );
          }}
        </For>
      </ul>
    </section>
  );
}
