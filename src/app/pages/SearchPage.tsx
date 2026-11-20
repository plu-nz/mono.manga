import { createSignal, For, onCleanup, onSettled, Show, untrack } from 'solid-js';
import { useNavigate, useSearchParams } from '@solidjs/router';
import { Button } from '@plunz/storybook';
import type { MangaSummary } from '../../core/types';
import { getProvider } from '../../providers';
import { importLocalFiles } from '../../providers/local';
import { setFavorite, settings } from '../../library/store';
import { t, tn } from '../../i18n';
import { Cover, EmptyState, Icon, IconButton, errorMessage, toast } from '../ui';
import { addRecentSearch, clearRecent, loadRecent, recentSearches, recentTitles, removeRecentSearch } from '../../library/recent';

const PAGE_SIZE = 24;

export default function SearchPage() {
  const [params, setParams] = useSearchParams<{ q?: string }>();
  const navigate = useNavigate();
  // Seeded once from the address; typing owns it afterwards.
  const [text, setText] = createSignal(untrack(() => params.q ?? ''));
  const [items, setItems] = createSignal<MangaSummary[]>([]);
  const [total, setTotal] = createSignal(0);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [searched, setSearched] = createSignal(false);
  const [importing, setImporting] = createSignal(false);
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => { controller?.abort(); clearTimeout(timer); });

  async function run(query: string, offset = 0) {
    controller?.abort();
    if (!query.trim()) { setItems([]); setTotal(0); setSearched(false); setError(undefined); return; }
    controller = new AbortController();
    setLoading(true);
    setError(undefined);
    try {
      const ratings = settings.showMature ? ['safe', 'suggestive', 'erotica', 'pornographic'] : ['safe', 'suggestive'];
      const result = await getProvider('mangadex').search(
        { text: query.trim(), languages: [...settings.languages], offset, limit: PAGE_SIZE, contentRating: ratings },
        controller.signal,
      );
      setItems(offset ? [...items(), ...result.items] : result.items);
      setTotal(result.total);
      setSearched(true);
    } catch (caught) {
      if (!controller.signal.aborted) setError(errorMessage(caught));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  function onInput(value: string) {
    setText(value);
    clearTimeout(timer);
    timer = setTimeout(() => { setParams({ q: value.trim() || undefined }, { replace: true }); void run(value); }, 400);
  }

  // A shared or reloaded address searches once for its query.
  onSettled(() => {
    if (params.q) void run(params.q);
    void loadRecent();
  });

  function searchFor(query: string) {
    clearTimeout(timer);
    setText(query);
    setParams({ q: query }, { replace: true });
    void addRecentSearch(query);
    void run(query);
  }

  async function onImport(files: FileList | null) {
    if (!files?.length) return;
    setImporting(true);
    try {
      const results = await importLocalFiles([...files]);
      // Imported titles join the favorites so they are easy to find again.
      for (const result of results) await setFavorite(result.details, true);
      const pages = results.reduce((sum, result) => sum + result.pages, 0);
      toast(tn(pages, 'Imported {count} page.', 'Imported {count} pages.'));
      if (results[0]) navigate(`/manga/local/${encodeURIComponent(results[0].details.id)}`);
    } catch (caught) {
      toast(errorMessage(caught));
    } finally {
      setImporting(false);
    }
  }

  return (
    <section class="page" aria-labelledby="search-heading">
      <header class="page-head">
        <h1 id="search-heading">{t('Search')}</h1>
      </header>
      <form class="search-form" role="search" onSubmit={event => { event.preventDefault(); clearTimeout(timer); setParams({ q: text().trim() || undefined }, { replace: true }); void addRecentSearch(text()); void run(text()); }}>
        <label class="sr-only" for="search-input">{t('Search titles on MangaDex')}</label>
        <Icon name="search" class="search-icon" />
        <input
          id="search-input"
          class="search-input"
          type="search"
          enterkeyhint="search"
          autocomplete="off"
          placeholder={t('Search titles on MangaDex')}
          value={text()}
          onInput={event => onInput(event.currentTarget.value)}
        />
      </form>

      <div class="import-row">
        <label class="import-button" aria-busy={importing() ? 'true' : undefined}>
          <Icon name="upload" />
          <span>{importing() ? t('Importing…') : t('Import your files (CBZ, ZIP, images)')}</span>
          <input type="file" class="sr-only" multiple accept=".cbz,.zip,application/zip,image/*" disabled={importing()} onChange={event => { void onImport(event.currentTarget.files); event.currentTarget.value = ''; }} />
        </label>
      </div>

      <Show when={error()}><p class="error" role="alert">{error()}</p></Show>

      <Show when={searched() && !loading() && items().length === 0 && !error()}>
        <EmptyState icon="search" title={t('No titles found')}>
          <p>{t('Try another title, or add more chapter languages in Settings.')}</p>
        </EmptyState>
      </Show>

      <Show when={!searched() && !loading() && !error()}>
        <Show when={recentSearches().length || recentTitles().length} fallback={
          <EmptyState icon="search" title={t('Find something to read')}>
            <p>{t('Search MangaDex by title. Results only include titles with chapters in your languages.')}</p>
          </EmptyState>
        }>
          <Show when={recentSearches().length}>
            <section class="recent" aria-labelledby="recent-searches-heading">
              <div class="row-between">
                <h2 id="recent-searches-heading">{t('Recent searches')}</h2>
                <button type="button" class="text-button" onClick={() => void clearRecent()}>{t('Clear history')}</button>
              </div>
              <ul class="recent-searches">
                <For each={recentSearches()}>
                  {query => (
                    <li>
                      <button type="button" class="recent-query" onClick={() => searchFor(query)}><Icon name="search" size={16} /> {query}</button>
                      <IconButton icon="close" label={t('Remove “{query}” from history', { query })} onClick={() => void removeRecentSearch(query)} />
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </Show>
          <Show when={recentTitles().length}>
            <section class="recent" aria-labelledby="recent-titles-heading">
              <div class="row-between">
                <h2 id="recent-titles-heading">{t('Recently opened')}</h2>
                <Show when={!recentSearches().length}><button type="button" class="text-button" onClick={() => void clearRecent()}>{t('Clear history')}</button></Show>
              </div>
              <ul class="grid">
                <For each={recentTitles()}>
                  {item => (
                    <li>
                      <a class="tile" href={`/manga/${item.provider}/${encodeURIComponent(item.id)}`}>
                        <Cover url={item.coverUrl} title={item.title} />
                        <span class="tile-title">{item.title}</span>
                      </a>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </Show>
        </Show>
      </Show>

      <ul class="grid" aria-busy={loading() ? 'true' : undefined}>
        <For each={items()}>
          {item => (
            <li>
              <a class="tile" href={`/manga/${item.provider}/${encodeURIComponent(item.id)}`} onClick={() => void addRecentSearch(text())}>
                <Cover url={item.coverUrl} title={item.title} />
                <span class="tile-title">{item.title}</span>
                <Show when={item.year || item.status}>
                  <span class="tile-meta">{[item.year, item.status ? t(item.status) : undefined].filter(Boolean).join(' · ')}</span>
                </Show>
              </a>
            </li>
          )}
        </For>
      </ul>

      <Show when={loading()}><p class="muted center" role="status">{t('Loading…')}</p></Show>
      <Show when={!loading() && items().length < total()}>
        <div class="center"><Button type="button" variant="outline" onClick={() => void run(text(), items().length)}>{t('Load more')}</Button></div>
      </Show>
      <Show when={searched()}>
        <p class="attribution">{t('Data and images from')} <a href="https://mangadex.org" target="_blank" rel="noopener">MangaDex</a>. {t('Chapters are translated by scanlation groups credited on each chapter.')}</p>
      </Show>
    </section>
  );
}
