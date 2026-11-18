import { lazy, onMount, Show, type JSX } from 'solid-js';
import { A, Route, Router, useLocation } from '@solidjs/router';
import { Theme, Button } from '@plunz/storybook';
import { useRegisterSW } from 'virtual:pwa-register/solid';
import { loadLibrary } from '../library/store';
import { refreshNewChapters, totalNewChapters } from '../library/new-chapters';
import { loadDownloadStates } from '../library/download-manager';
import { initSync, syncStatus } from './sync';
import { t } from '../i18n';
import { Icon, ToastRegion, type IconName } from './ui';
import LibraryPage from './pages/LibraryPage';

const SearchPage = lazy(() => import('./pages/SearchPage'));
const MangaPage = lazy(() => import('./pages/MangaPage'));
const ReaderPage = lazy(() => import('./pages/ReaderPage'));
const DownloadsPage = lazy(() => import('./pages/DownloadsPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const AniListCallbackPage = lazy(() => import('./pages/AniListCallbackPage'));

function NavLink(props: { href: string; icon: IconName; label: string; badge?: number; end?: boolean; onClick?: () => void }) {
  return (
    <A href={props.href} end={props.end} class="nav-link" activeClass="active" onClick={() => props.onClick?.()}>
      <span class="nav-icon">
        <Icon name={props.icon} />
        <Show when={props.badge}><span class="nav-badge" aria-hidden="true">{props.badge}</span></Show>
      </span>
      <span>{props.label}</span>
      <Show when={props.badge}><span class="sr-only">{t('{count} new', { count: props.badge ?? 0 })}</span></Show>
    </A>
  );
}

function Shell(props: { children?: JSX.Element }) {
  const location = useLocation();
  const inReader = () => location.pathname.startsWith('/read/');
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW();

  return (
    <Theme class="app" accent="orange" shape="square">
      <a class="skip-link" href="#main">{t('Skip to content')}</a>
      <main id="main" class={inReader() ? 'main reader-main' : 'main'}>{props.children}</main>
      <Show when={needRefresh()}>
        <div class="update-banner" role="status">
          <span>{t('A new version is ready.')}</span>
          <Button type="button" size="sm" onClick={() => void updateServiceWorker(true)}>{t('Update')}</Button>
        </div>
      </Show>
      <Show when={!inReader()}>
        <nav class="bottom-nav" aria-label={t('Main')}>
          <NavLink
            href="/"
            end
            icon="library"
            label={t('Library')}
            badge={totalNewChapters()}
            // Every tap on Library also checks favorites for new chapters.
            onClick={() => { window.scrollTo({ top: 0, behavior: 'smooth' }); void refreshNewChapters({ force: true }); }}
          />
          <NavLink href="/search" icon="search" label={t('Search')} />
          <NavLink href="/downloads" icon="download" label={t('Downloads')} />
          <NavLink href="/settings" icon={syncStatus() === 'reconnect' ? 'sync' : 'settings'} label={t('Settings')} />
        </nav>
      </Show>
      <ToastRegion />
    </Theme>
  );
}

export default function App() {
  onMount(() => {
    void loadLibrary().then(() => initSync());
    void loadDownloadStates();
  });
  return (
    <Router root={Shell}>
      <Route path="/" component={LibraryPage} />
      <Route path="/search" component={SearchPage} />
      <Route path="/manga/:provider/:id" component={MangaPage} />
      <Route path="/read/:provider/:mangaId/:chapterId" component={ReaderPage} />
      <Route path="/downloads" component={DownloadsPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route path="/auth/anilist" component={AniListCallbackPage} />
      <Route path="*" component={LibraryPage} />
    </Router>
  );
}
