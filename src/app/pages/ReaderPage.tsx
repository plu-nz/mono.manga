import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { A, useNavigate, useParams } from '@solidjs/router';
import { Button } from '@plunz/storybook';
import { chapterLabel, mangaKey, type ReadingMode } from '../../core/types';
import { adjacentChapter, loadManga } from '../../library/manga';
import { effectiveMode, progress, saveProgress, settings } from '../../library/store';
import { loadChapterPages, type PageHandle } from '../../reader/pages';
import { isProviderId } from '../../providers';
import { t } from '../../i18n';
import { EmptyState, IconButton, errorMessage } from '../ui';
import { modeLabel } from './MangaPage';

const PRELOAD_AHEAD = 3;

/** Lazily resolves a page handle to an image, switching to the fallback URL once on error. */
function PageImage(props: { handle: PageHandle; eager?: boolean; alt: string; class?: string; onLoad?: () => void }) {
  const [src] = createResource(() => props.handle, handle => handle.src());
  const [useFallback, setUseFallback] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  return (
    <Show when={!failed()} fallback={<div class="page-error" role="img" aria-label={props.alt}>{t('This page could not be loaded.')}</div>}>
      <Show when={src()} fallback={<div class="page-placeholder" aria-hidden="true" />}>
        <img
          class={props.class}
          src={useFallback() ? props.handle.fallback : src()}
          alt={props.alt}
          loading={props.eager ? 'eager' : 'lazy'}
          decoding="async"
          draggable={false}
          onLoad={() => props.onLoad?.()}
          onError={() => (props.handle.fallback && !useFallback() ? setUseFallback(true) : setFailed(true))}
        />
      </Show>
    </Show>
  );
}

export default function ReaderPage() {
  const params = useParams<{ provider: string; mangaId: string; chapterId: string }>();
  const navigate = useNavigate();
  const [manga] = createResource(
    () => (isProviderId(params.provider) ? { provider: params.provider, id: decodeURIComponent(params.mangaId) } : undefined),
    source => loadManga(source.provider, source.id),
  );
  const chapter = createMemo(() => manga()?.chapters.find(item => item.id === decodeURIComponent(params.chapterId)));
  const [pages] = createResource(chapter, item => loadChapterPages(item, { dataSaver: settings.dataSaver }));
  const key = () => (manga() ? mangaKey(manga()!.details.provider, manga()!.details.id) : '');
  const [modeOverride, setModeOverride] = createSignal<ReadingMode>();
  const mode = (): ReadingMode => modeOverride() ?? (manga() ? effectiveMode(key(), manga()!.details.defaultMode) : 'rtl');
  const [page, setPage] = createSignal(0);
  const [chrome, setChrome] = createSignal(true);
  const next = createMemo(() => (manga() && chapter() ? adjacentChapter(manga()!.chapters, chapter()!, 1) : undefined));
  const previous = createMemo(() => (manga() && chapter() ? adjacentChapter(manga()!.chapters, chapter()!, -1) : undefined));
  const count = () => pages()?.length ?? 0;
  /** One extra "end" slide after the last page offers the next chapter. */
  const atEnd = () => page() >= count();

  // Start where the user stopped when reopening the same chapter.
  createEffect(on(pages, list => {
    if (!list) return;
    const saved = progress[key()];
    const start = saved && !saved.deleted && saved.chapterId === chapter()?.id ? Math.min(saved.page, list.length - 1) : 0;
    setPage(Math.max(0, start));
    if (mode() === 'vertical' && start > 0) requestAnimationFrame(() => document.getElementById(`page-${start}`)?.scrollIntoView());
  }));

  onCleanup(() => pages()?.forEach(handle => handle.release()));
  createEffect(on(pages, (_list, previousList) => previousList?.forEach(handle => handle.release())));

  // Persist progress shortly after the page settles.
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(on([page, pages], ([current, list]) => {
    const item = chapter();
    if (!list || !item || !manga()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void saveProgress({ key: key(), chapter: item, chapterLabel: chapterLabel({ ...item, title: undefined }), page: Math.min(current, list.length - 1), pageCount: list.length });
    }, 600);
  }));
  onCleanup(() => clearTimeout(saveTimer));

  function go(step: number) {
    const target = page() + step;
    if (target < 0) {
      if (previous()) openChapter(previous()!.id);
      return;
    }
    if (target > count()) {
      if (next()) openChapter(next()!.id);
      return;
    }
    setPage(target);
  }

  function openChapter(id: string) {
    navigate(`/read/${params.provider}/${params.mangaId}/${encodeURIComponent(id)}`, { replace: true });
  }

  /** Map a physical side to forward/back according to the reading direction. */
  function side(direction: 'left' | 'right') {
    const forward = mode() === 'rtl' ? direction === 'left' : direction === 'right';
    go(forward ? 1 : -1);
  }

  function onKey(event: KeyboardEvent) {
    if (mode() === 'vertical') return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); side('left'); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); side('right'); }
    else if (event.key === ' ' || event.key === 'PageDown') { event.preventDefault(); go(1); }
    else if (event.key === 'PageUp') { event.preventDefault(); go(-1); }
  }
  onMount(() => window.addEventListener('keydown', onKey));
  onCleanup(() => window.removeEventListener('keydown', onKey));

  // Swipe handling for paged modes.
  let startX = 0;
  let startY = 0;
  let pointerDown = false;
  function onPointerDown(event: PointerEvent) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointerDown = true;
    startX = event.clientX;
    startY = event.clientY;
  }
  function onPointerUp(event: PointerEvent) {
    if (!pointerDown) return;
    pointerDown = false;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      side(dx < 0 ? 'right' : 'left');
      return;
    }
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      const width = (event.currentTarget as HTMLElement).clientWidth;
      const third = event.clientX / width;
      if (third < 0.3) side('left');
      else if (third > 0.7) side('right');
      else setChrome(!chrome());
    }
  }

  // Vertical mode: track the page closest to the top of the viewport.
  let observer: IntersectionObserver | undefined;
  function observe(element: HTMLElement, index: number) {
    observer ??= new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) setPage(Number((entry.target as HTMLElement).dataset.index));
      }
    }, { rootMargin: '-45% 0px -45% 0px' });
    element.dataset.index = String(index);
    observer.observe(element);
  }
  onCleanup(() => observer?.disconnect());

  const visibleHandles = createMemo(() => {
    const list = pages() ?? [];
    return list.filter(handle => handle.index >= page() && handle.index <= page() + PRELOAD_AHEAD);
  });

  return (
    <div class="reader" classList={{ 'chrome-hidden': !chrome(), [`mode-${mode()}`]: true }}>
      <header class="reader-bar top">
        <IconButton icon="back" label={t('Back to title')} onClick={() => navigate(`/manga/${params.provider}/${params.mangaId}`)} />
        <div class="reader-title">
          <strong>{manga()?.details.title}</strong>
          <span>{chapter() ? chapterLabel(chapter()!) : ''}</span>
        </div>
        <label class="sr-only" for="reader-mode">{t('Reading mode')}</label>
        <select id="reader-mode" class="reader-mode" value={mode()} onChange={event => setModeOverride(event.currentTarget.value as ReadingMode)}>
          <option value="rtl">{modeLabel('rtl')}</option>
          <option value="ltr">{modeLabel('ltr')}</option>
          <option value="vertical">{modeLabel('vertical')}</option>
        </select>
      </header>

      <Show when={manga.error || pages.error}>
        <EmptyState icon="library" title={t('Could not open this chapter')}>
          <p>{errorMessage(manga.error ?? pages.error)}</p>
          <A href={`/manga/${params.provider}/${params.mangaId}`}>{t('Back to title')}</A>
        </EmptyState>
      </Show>
      <Show when={(manga.loading || pages.loading) && !pages()}><p class="reader-loading" role="status">{t('Loading…')}</p></Show>

      <Show when={pages()}>
        {list => (
          <Show when={mode() === 'vertical'} fallback={
            <div class="paged" onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => (pointerDown = false)}>
              <Show when={!atEnd()} fallback={
                <EndOfChapter next={next()?.id} label={next() ? chapterLabel(next()!) : undefined} onNext={id => openChapter(id)} back={`/manga/${params.provider}/${params.mangaId}`} />
              }>
                <For each={visibleHandles()}>
                  {handle => (
                    <div class="paged-slide" classList={{ current: handle.index === page() }} aria-hidden={handle.index !== page()}>
                      <PageImage handle={handle} eager alt={t('Page {page} of {count}', { page: handle.index + 1, count: list().length })} />
                    </div>
                  )}
                </For>
              </Show>
            </div>
          }>
            <div class="vertical" onClick={() => setChrome(!chrome())}>
              <For each={list()}>
                {handle => (
                  <div class="vertical-page" id={`page-${handle.index}`} ref={element => observe(element, handle.index)}>
                    <PageImage handle={handle} eager={handle.index < 3} alt={t('Page {page} of {count}', { page: handle.index + 1, count: list().length })} />
                  </div>
                )}
              </For>
              <EndOfChapter next={next()?.id} label={next() ? chapterLabel(next()!) : undefined} onNext={id => openChapter(id)} back={`/manga/${params.provider}/${params.mangaId}`} />
            </div>
          </Show>
        )}
      </Show>

      <footer class="reader-bar bottom">
        <IconButton icon="back" class={mode() === 'rtl' ? 'flip' : ''} label={mode() === 'rtl' ? t('Next chapter') : t('Previous chapter')} disabled={mode() === 'rtl' ? !next() : !previous()} onClick={() => { const target = mode() === 'rtl' ? next() : previous(); if (target) openChapter(target.id); }} />
        <Show when={count() > 0}>
          <label class="sr-only" for="page-slider">{t('Page')}</label>
          <input
            id="page-slider"
            class="page-slider"
            type="range"
            min="0"
            max={Math.max(0, count() - 1)}
            value={Math.min(page(), count() - 1)}
            dir={mode() === 'rtl' ? 'rtl' : 'ltr'}
            onInput={event => {
              const value = Number(event.currentTarget.value);
              setPage(value);
              if (mode() === 'vertical') document.getElementById(`page-${value}`)?.scrollIntoView();
            }}
          />
          <span class="page-count">{Math.min(page() + 1, count())}/{count()}</span>
        </Show>
        <IconButton icon="back" class={mode() === 'rtl' ? '' : 'flip'} label={mode() === 'rtl' ? t('Previous chapter') : t('Next chapter')} disabled={mode() === 'rtl' ? !previous() : !next()} onClick={() => { const target = mode() === 'rtl' ? previous() : next(); if (target) openChapter(target.id); }} />
      </footer>
    </div>
  );
}

function EndOfChapter(props: { next?: string; label?: string; onNext: (id: string) => void; back: string }) {
  return (
    <div class="end-of-chapter" onPointerUp={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      <p>{t('End of chapter')}</p>
      <Show when={props.next} fallback={<><p class="muted">{t('You are up to date.')}</p><A class="plz-button plz-button--outline plz-button--md" href={props.back}>{t('Back to title')}</A></>}>
        <Button type="button" onClick={() => props.onNext(props.next!)}>{t('Next: {chapter}', { chapter: props.label ?? '' })}</Button>
      </Show>
    </div>
  );
}
