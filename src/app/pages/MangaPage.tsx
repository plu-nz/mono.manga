import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import { A, useNavigate, useParams } from '@solidjs/router';
import { Button } from '@plunz/storybook';
import { chapterLabel, mangaKey, type ChapterSummary, type ReadingMode } from '../../core/types';
import { groupByVolume, loadManga } from '../../library/manga';
import { addRecentTitle } from '../../library/recent';
import { reportReadToTracker, syncTitleWithTracker } from '../../trackers/sync';
import { extraSourcesUnlocked } from '../../providers/weebcentral/session';
import { WEEBCENTRAL_NAME } from '../../providers/weebcentral';
import { SourceSheet } from '../SourceSheet';
import {
  effectiveMode,
  isChapterRead,
  isInLibrary,
  isSentToKindle,
  library,
  progress,
  setChaptersRead,
  setTitleMode,
  settings,
  toggleFavorite,
  updateSettings,
} from '../../library/store';
import { downloadStates, queueDownloads } from '../../library/download-manager';
import { chapterKey } from '../../storage/db';
import { isProviderId } from '../../providers';
import { mangaDexTitleUrl } from '../../providers/mangadex';
import { formatDate, languageName, t, tn } from '../../i18n';
import { SendSheet } from '../../kindle/SendSheet';
import { Cover, EmptyState, Icon, IconButton, errorMessage, toast } from '../ui';

export default function MangaPage() {
  const params = useParams<{ provider: string; id: string }>();
  const navigate = useNavigate();
  const [data, { refetch }] = createResource(
    () => (isProviderId(params.provider) ? { provider: params.provider, id: decodeURIComponent(params.id) } : undefined),
    source => loadManga(source.provider, source.id).then(result => {
      void addRecentTitle(result.details);
      syncTitleWithTracker(result.details, result.chapters);
      return result;
    }),
  );
  const [selecting, setSelecting] = createSignal(false);
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [expanded, setExpanded] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  const [linking, setLinking] = createSignal(false);
  const sourceLink = () => (library[key()]?.deleted ? undefined : library[key()]?.sources?.weebcentral);

  const key = () => (data() ? mangaKey(data()!.details.provider, data()!.details.id) : '');
  const saved = () => isInLibrary(key());
  const favorite = () => Boolean(library[key()]?.favorite && saved());
  const mode = (): ReadingMode => (data() ? effectiveMode(key(), data()!.details.defaultMode) : 'ltr');
  // Reading order is kept everywhere else (next chapter, Kindle files); only the list display flips.
  const groups = createMemo(() => {
    const chapters = data()?.chapters ?? [];
    return groupByVolume(settings.newestFirst ? [...chapters].reverse() : chapters);
  });
  const selectedChapters = createMemo(() => (data()?.chapters ?? []).filter(chapter => selected().has(chapter.id)));
  const continueChapter = createMemo(() => {
    const chapters = data()?.chapters ?? [];
    const current = progress[key()];
    if (current && !current.deleted) {
      const found = chapters.find(chapter => chapter.id === current.chapterId);
      if (found) return { chapter: found, resume: true };
    }
    const first = chapters.find(chapter => !chapter.externalUrl);
    return first ? { chapter: first, resume: false } : undefined;
  });

  function toggle(chapter: ChapterSummary) {
    const next = new Set(selected());
    next.has(chapter.id) ? next.delete(chapter.id) : next.add(chapter.id);
    setSelected(next);
  }

  function toggleGroup(chapters: ChapterSummary[]) {
    const next = new Set(selected());
    const all = chapters.every(chapter => next.has(chapter.id));
    for (const chapter of chapters) all ? next.delete(chapter.id) : next.add(chapter.id);
    setSelected(next);
  }

  function readHref(chapter: ChapterSummary) {
    return `/read/${chapter.provider}/${encodeURIComponent(chapter.mangaId)}/${encodeURIComponent(chapter.id)}`;
  }

  function stopSelecting() {
    setSelecting(false);
    setSelected(new Set<string>());
  }

  return (
    <section class="page manga-page">
      <header class="page-head with-back">
        <IconButton icon="back" label={t('Back')} onClick={() => (history.length > 1 ? history.back() : navigate('/'))} />
      </header>

      <Show when={data.error}>
        <EmptyState icon="library" title={t('Could not load this title')}>
          <p>{errorMessage(data.error)}</p>
          <Button type="button" variant="outline" onClick={() => void refetch()}>{t('Try again')}</Button>
        </EmptyState>
      </Show>
      <Show when={data.loading && !data()}><p class="muted center" role="status">{t('Loading…')}</p></Show>

      <Show when={data()}>
        {loaded => (
          <>
            <div class="manga-hero">
              <Cover url={loaded().details.coverUrl} title={loaded().details.title} class="hero-cover" eager />
              <div class="manga-info">
                <h1>{loaded().details.title}</h1>
                <Show when={loaded().details.authors?.length}><p class="muted">{loaded().details.authors!.join(', ')}</p></Show>
                <p class="muted small">
                  {[loaded().details.year, loaded().details.status ? t(loaded().details.status!) : undefined, loaded().details.originalLanguage ? languageName(loaded().details.originalLanguage!) : undefined].filter(Boolean).join(' · ')}
                </p>
                <Show when={loaded().offline}><p class="badge">{t('Offline copy')}</p></Show>
              </div>
            </div>

            <div class="action-row">
              <Show when={continueChapter()}>
                {next => (
                  <A class="plz-button plz-button--solid plz-button--md grow" href={readHref(next().chapter)}>
                    {next().resume ? t('Continue {chapter}', { chapter: chapterLabel({ ...next().chapter, title: undefined }) }) : t('Start reading')}
                  </A>
                )}
              </Show>
              <Button type="button" variant="outline" class={favorite() ? 'is-favorite' : ''} aria-pressed={favorite()} onClick={() => void toggleFavorite(loaded().details).then(() => { if (favorite()) toast(t('Added to your library. New chapters will be counted there.')); })}>
                <Icon name={favorite() ? 'star' : 'starOutline'} size={18} /> {favorite() ? t('Favorite') : t('Add to favorites')}
              </Button>
            </div>

            <Show when={loaded().details.description}>
              <div class="description" classList={{ expanded: expanded() }}>
                <p>{loaded().details.description}</p>
              </div>
              <button type="button" class="text-button" aria-expanded={expanded()} onClick={() => setExpanded(!expanded())}>{expanded() ? t('Show less') : t('Show more')}</button>
            </Show>

            <Show when={loaded().details.tags?.length}>
              <ul class="tags" aria-label={t('Tags')}><For each={loaded().details.tags!.slice(0, 12)}>{tag => <li>{tag}</li>}</For></ul>
            </Show>

            <div class="field-row">
              <label for="reading-mode">{t('Reading mode')}</label>
              <select id="reading-mode" value={library[key()]?.mode ?? ''} onChange={event => void setTitleMode(loaded().details, (event.currentTarget.value || undefined) as ReadingMode | undefined)}>
                <option value="">{t('Automatic ({mode})', { mode: modeLabel(mode()) })}</option>
                <option value="rtl">{modeLabel('rtl')}</option>
                <option value="ltr">{modeLabel('ltr')}</option>
                <option value="vertical">{modeLabel('vertical')}</option>
              </select>
            </div>

            <Show when={extraSourcesUnlocked() && loaded().details.provider !== 'local'}>
              <div class="fill-row">
                <Button type="button" size="sm" variant="outline" onClick={() => setLinking(true)}>
                  <Icon name="plus" size={18} /> {sourceLink() ? t('Filling from {source}', { source: WEEBCENTRAL_NAME }) : t('Fill missing chapters')}
                </Button>
              </div>
              <SourceSheet open={linking()} onClose={() => setLinking(false)} details={loaded().details} onChanged={() => void refetch()} />
            </Show>

            <div class="section-head">
              <h2>{tn(loaded().chapters.length, '{count} chapter', '{count} chapters')}</h2>
              <Show when={loaded().chapters.length}>
                <div class="head-actions">
                  <Button type="button" size="sm" variant="ghost" aria-pressed={Boolean(settings.newestFirst)} onClick={() => void updateSettings({ newestFirst: !settings.newestFirst })}>
                    <Icon name="sort" size={18} /> {settings.newestFirst ? t('Newest first') : t('Oldest first')}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => (selecting() ? stopSelecting() : setSelecting(true))}>{selecting() ? t('Done') : t('Select')}</Button>
                </div>
              </Show>
            </div>

            <Show when={loaded().chapters.length === 0}>
              <EmptyState icon="library" title={t('No chapters in your languages')}>
                <p>{t('Add more chapter languages in Settings, or check the title on MangaDex.')}</p>
              </EmptyState>
            </Show>

            <For each={groups()}>
              {group => (
                <div class="volume">
                  <div class="volume-head">
                    <h3>{group.volume ? t('Volume {volume}', { volume: group.volume }) : t('No volume')}</h3>
                    <Show when={selecting()}>
                      <button type="button" class="text-button" onClick={() => toggleGroup(group.chapters)}>
                        {group.chapters.every(chapter => selected().has(chapter.id)) ? t('Clear volume') : t('Select volume')}
                      </button>
                    </Show>
                  </div>
                  <ul class="chapters">
                    <For each={group.chapters}>
                      {chapter => {
                        const state = () => downloadStates[chapterKey(chapter)];
                        const read = () => isChapterRead(key(), chapter.id);
                        const body = (
                          <>
                            <span class="chapter-title" classList={{ read: read() }}>{chapterLabel({ ...chapter, volume: undefined })}</span>
                            <span class="chapter-meta">
                              {[chapter.groups?.join(', '), languageName(chapter.language), formatDate(chapter.publishedAt)].filter(Boolean).join(' · ')}
                            </span>
                            <Show when={!state() && isSentToKindle(key(), chapter.id)}>
                              <span class="chapter-state sent">{t('On Kindle')}</span>
                            </Show>
                            <Show when={state()}>
                              {current => (
                                <span class="chapter-state">
                                  {current().status === 'complete' ? t('Offline') : current().status === 'downloading' ? `${current().done}/${current().total}` : current().status === 'queued' ? t('Queued') : current().status === 'error' ? t('Download failed') : t('Partial')}
                                </span>
                              )}
                            </Show>
                          </>
                        );
                        return (
                          <li class="chapter" classList={{ selected: selected().has(chapter.id) }}>
                            <Show when={!chapter.externalUrl} fallback={
                              <a class="chapter-link external" href={chapter.externalUrl} target="_blank" rel="noopener">
                                {body}<span class="chapter-state"><Icon name="external" size={16} /> {t('Official site')}</span>
                              </a>
                            }>
                              <Show when={selecting()} fallback={<A class="chapter-link" href={readHref(chapter)}>{body}</A>}>
                                <label class="chapter-link">
                                  <input type="checkbox" checked={selected().has(chapter.id)} onChange={() => toggle(chapter)} />
                                  <span class="chapter-text">{body}</span>
                                </label>
                              </Show>
                            </Show>
                          </li>
                        );
                      }}
                    </For>
                  </ul>
                </div>
              )}
            </For>

            <Show when={loaded().details.provider === 'mangadex'}>
              <p class="attribution">
                {t('Data and images from')} <a href={mangaDexTitleUrl(loaded().details.id)} target="_blank" rel="noopener">MangaDex</a>. {t('Support the official release when it is available in your country.')}
              </p>
            </Show>

            <Show when={selecting()}>
              <div class="selection-bar" role="toolbar" aria-label={t('Selected chapters')}>
                <span>{tn(selectedChapters().length, '{count} selected', '{count} selected')}</span>
                <div class="selection-actions">
                  <IconButton icon="check" label={t('Mark as read')} disabled={!selectedChapters().length} onClick={() => void setChaptersRead(key(), selectedChapters().map(chapter => chapter.id), true).then(() => { reportReadToTracker(data()!.details, data()!.chapters); stopSelecting(); })} />
                  <IconButton icon="unread" label={t('Mark as unread')} disabled={!selectedChapters().length} onClick={() => void setChaptersRead(key(), selectedChapters().map(chapter => chapter.id), false).then(stopSelecting)} />
                  <Show when={loaded().details.provider !== 'local'}>
                    <IconButton icon="download" label={t('Save offline')} disabled={!selectedChapters().length} onClick={() => {
                      queueDownloads(selectedChapters(), loaded().details.title);
                      toast(tn(selectedChapters().length, 'Saving {count} chapter for offline reading.', 'Saving {count} chapters for offline reading.'));
                      stopSelecting();
                    }} />
                  </Show>
                  <Button type="button" size="sm" disabled={!selectedChapters().length} onClick={() => setSending(true)}>
                    <Icon name="send" size={18} /> {t('Kindle')}
                  </Button>
                </div>
              </div>
            </Show>

            <SendSheet open={sending()} onClose={() => setSending(false)} details={loaded().details} chapters={selectedChapters()} mode={mode()} />
          </>
        )}
      </Show>
    </section>
  );
}

export function modeLabel(mode: ReadingMode): string {
  return mode === 'rtl' ? t('Right to left (manga)') : mode === 'ltr' ? t('Left to right') : t('Vertical scroll (webtoon)');
}
