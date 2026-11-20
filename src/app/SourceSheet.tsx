import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';
import { Button, TextField } from '@plunz/storybook';
import { mangaKey, type MangaDetails, type MangaSummary } from '../core/types';
import { forgetLinkedChapters } from '../library/manga';
import { setSourceLink } from '../library/store';
import { effectiveSourceLink } from '../library/auto-fill';
import { weebCentralProvider, WEEBCENTRAL_NAME } from '../providers/weebcentral';
import { t } from '../i18n';
import { Cover, Sheet, errorMessage, toast } from './ui';

/** Link a title to Weeb Central so its missing chapters are filled from there. */
export function SourceSheet(props: { open: boolean; onClose: () => void; details: MangaDetails; onChanged: () => void }) {
  const key = () => mangaKey(props.details.provider, props.details.id);
  const link = () => effectiveSourceLink(key());
  const [query, setQuery] = createSignal('');
  const [results, setResults] = createSignal<MangaSummary[]>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();

  async function search(text: string) {
    if (!text.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      setResults((await weebCentralProvider.search({ text })).items.slice(0, 12));
    } catch (failure) {
      setResults([]);
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  // Search by the title's name as soon as the sheet opens.
  // A memo, so a refreshed title object with the same name does not search again.
  const openedFor = createMemo(() => (props.open ? props.details.title : undefined));
  createEffect(
    openedFor,
    title => {
      if (title === undefined) return;
      setQuery(title);
      setResults(undefined);
      void search(title);
    },
  );

  async function choose(item: MangaSummary | undefined) {
    await setSourceLink(props.details, item ? { id: item.id, title: item.title } : undefined);
    forgetLinkedChapters(key());
    toast(item ? t('Missing chapters will be filled from {source}.', { source: WEEBCENTRAL_NAME }) : t('Extra chapters removed.'));
    props.onChanged();
    props.onClose();
  }

  return (
    <Sheet open={props.open} onClose={props.onClose} title={t('Fill missing chapters')}>
      <div class="sheet-content">
        <p class="hint">{t('Chapters this title lacks here are added from {source}. Chapters already available are kept.', { source: WEEBCENTRAL_NAME })}</p>
        <Show when={link()}>
          {current => (
            <div class="linked-source">
              <p>{current().auto
                ? t('Filling automatically from {source}: {title}', { source: WEEBCENTRAL_NAME, title: current().title })
                : t('Filling from {source}: {title}', { source: WEEBCENTRAL_NAME, title: current().title })}</p>
              <Button type="button" variant="ghost" size="sm" onClick={() => void choose(undefined)}>{t('Stop filling')}</Button>
            </div>
          )}
        </Show>
        <form class="source-search" onSubmit={event => { event.preventDefault(); void search(query()); }}>
          <TextField id="source-query" label={t('Search {source}', { source: WEEBCENTRAL_NAME })} value={query()} onInput={event => setQuery(event.currentTarget.value)} />
          <Button type="submit" variant="outline" disabled={busy()}>{t('Search')}</Button>
        </form>
        <Show when={busy()}><p class="muted" role="status">{t('Searching…')}</p></Show>
        <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
        <Show when={!busy() && results()?.length === 0 && !error()}><p class="muted">{t('No results.')}</p></Show>
        <ul class="source-results">
          <For each={results()}>
            {item => (
              <li>
                <button type="button" class="source-result" aria-current={link()?.id === item.id ? 'true' : undefined} onClick={() => void choose(item)}>
                  <Cover url={item.coverUrl} title={item.title} class="source-cover" />
                  <span class="source-name">
                    <strong>{item.title}</strong>
                    <span class="muted small">{[item.year, link()?.id === item.id ? t('Linked') : undefined].filter(Boolean).join(' · ')}</span>
                  </span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Sheet>
  );
}
