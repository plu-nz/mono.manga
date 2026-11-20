import { lazy, Loading, onSettled, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { createRouter, useLocation } from '@solidjs/router';
import { Theme, Button } from '@plunz/storybook';
import { useRegisterSW } from 'virtual:pwa-register/solid';
import { loadLibrary } from '../library/store';
import { refreshNewChapters, totalNewChapters } from '../library/new-chapters';
import { loadDownloadStates } from '../library/download-manager';
import { loadExtraSession } from '../providers/weebcentral/session';
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

const Router = createRouter({
  routes: [
    { path: '/', component: LibraryPage },
    { path: '/search', component: SearchPage },
    { path: '/manga/:provider/:id', component: MangaPage },
    { path: '/read/:provider/:mangaId/:chapterId', component: ReaderPage },
    { path: '/downloads', component: DownloadsPage },
    { path: '/settings', component: SettingsPage },
    { path: '/auth/anilist', component: AniListCallbackPage },
    { path: '*rest', component: LibraryPage },
  ],
});

/** A bottom-bar link; the router marks the current section with `data-active`. */
function NavLink(props: { href: string; icon: IconName; label: string; badge?: number; onClick?: () => void }) {
  return (
    <a href={props.href} class="nav-link" onClick={() => props.onClick?.()}>
      <span class="nav-icon">
        <Icon name={props.icon} />
        <Show when={props.badge}><span class="nav-badge" aria-hidden="true">{props.badge}</span></Show>
      </span>
      <span>{props.label}</span>
      <Show when={props.badge}><span class="sr-only">{t('{count} new', { count: props.badge ?? 0 })}</span></Show>
    </a>
  );
}

function Shell(props: { children?: JSX.Element }) {
  const location = useLocation();
  const inReader = () => location.pathname.startsWith('/read/');
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW();

  return (
    <Theme class="app" accent="orange" shape="square">
      <a class="skip-link" href="#main">{t('Skip to content')}</a>
      {/* Screens load on demand; the bar stays while one arrives. */}
      <main id="main" class={inReader() ? 'main reader-main' : 'main'}><Loading>{props.children}</Loading></main>
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
  onSettled(() => {
    void loadLibrary().then(() => initSync());
    void loadDownloadStates();
    void loadExtraSession();
  });
  return <Router>{props => <Shell>{props.children}</Shell>}</Router>;
}
