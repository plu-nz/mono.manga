import { onMount } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { completeAniListConnect } from '../../trackers/anilist';
import { t } from '../../i18n';
import { errorMessage, toast } from '../ui';

/** AniList redirects here with the token in the fragment; finish and go back to Settings. */
export default function AniListCallbackPage() {
  const navigate = useNavigate();
  onMount(() => {
    const hash = location.hash;
    // Drop the token from the address bar and history right away.
    history.replaceState(null, '', location.pathname);
    completeAniListConnect(hash)
      .then(account => toast(t('Connected to AniList as {name}', { name: account.userName })))
      .catch(error => toast(errorMessage(error)))
      .finally(() => navigate('/settings#tracking', { replace: true }));
  });
  return <section class="page"><p class="muted" role="status">{t('Connecting to AniList…')}</p></section>;
}
