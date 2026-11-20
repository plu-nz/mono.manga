import { createSignal, For, onSettled, Show } from 'solid-js';
import { Button, TextField } from '@plunz/storybook';
import type { ReadingMode } from '../../core/types';
import { settings, updateSettings } from '../../library/store';
import { KINDLE_PROFILES, getKindleProfile } from '../../kindle/profiles';
import { isKindleAddress } from '../../kindle/send';
import { connect, disconnect, isGoogleConfigured, preloadGoogle } from '../../google/auth';
import { deleteAppData } from '../../google/drive';
import { googleState, isSyncEnabled, lastSync, setSyncEnabled, syncNow, syncStatus } from '../sync';
import { requestPersistentStorage, storageEstimate } from '../../storage/db';
import { changeLanguage, formatBytes, languageName, preference, t, type Preference } from '../../i18n';
import { errorMessage, toast } from '../ui';
import { createLoaded } from '../loaded';
import { extraSession, lockExtraSources, unlockExtraSources } from '../../providers/weebcentral/session';
import { aniListAccount, connectAniList, disconnectAniList, isAniListConfigured, loadAniList } from '../../trackers/anilist';
import { modeLabel } from './MangaPage';

/** MangaDex translation language tags most readers ask for. */
const CHAPTER_LANGUAGES = ['en', 'pt-br', 'es-la', 'es', 'fr', 'de', 'it', 'ru', 'pl', 'tr', 'id', 'vi', 'th', 'ar', 'uk', 'ja', 'ko', 'zh', 'zh-hk'];

export default function SettingsPage() {
  // Undefined until the user edits, so the field shows the stored address even when settings finish loading after mount.
  const [draft, setEmail] = createSignal<string>();
  const email = () => draft() ?? settings.kindleEmail ?? '';
  const [emailError, setEmailError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [syncOn, setSyncOn] = createSignal(isSyncEnabled());
  const estimate = createLoaded(() => true, () => storageEstimate());
  const refetchEstimate = estimate.refetch;
  const [persisted, setPersisted] = createSignal<boolean>();
  onSettled(() => { if (isGoogleConfigured()) void preloadGoogle(); void loadAniList(); });

  function toggleLanguage(tag: string) {
    const current = [...settings.languages];
    const next = current.includes(tag) ? current.filter(item => item !== tag) : [...current, tag];
    if (next.length === 0) return;
    void updateSettings({ languages: next });
  }

  function saveEmail() {
    const value = email().trim();
    if (value && !isKindleAddress(value)) {
      setEmailError(t('Use the address ending in @kindle.com shown in your Amazon account.'));
      return;
    }
    setEmailError(undefined);
    void updateSettings({ kindleEmail: value || undefined }).then(() => toast(t('Saved.')));
  }

  async function withBusy(action: () => Promise<void>) {
    setBusy(true);
    try { await action(); }
    catch (error) { toast(errorMessage(error)); }
    finally { setBusy(false); }
  }

  return (
    <section class="page settings" aria-labelledby="settings-heading">
      <header class="page-head"><h1 id="settings-heading">{t('Settings')}</h1></header>

      <section class="settings-section" aria-labelledby="general-heading">
        <h2 id="general-heading">{t('General')}</h2>
        <div class="field-row">
          <label for="ui-language">{t('Language')}</label>
          <select id="ui-language" value={preference()} onChange={event => changeLanguage(event.currentTarget.value as Preference)}>
            <option value="system">{t('System language')}</option>
            <option value="en">English</option>
            <option value="pt">Português</option>
            <option value="es">Español</option>
          </select>
        </div>
        <fieldset class="chips">
          <legend>{t('Chapter languages')}</legend>
          <p class="hint">{t('Search and chapter lists only show translations in these languages.')}</p>
          <div class="chip-list">
            <For each={CHAPTER_LANGUAGES}>
              {tag => (
                <label class="chip">
                  <input type="checkbox" checked={settings.languages.includes(tag)} onChange={() => toggleLanguage(tag)} />
                  <span>{languageName(tag)}</span>
                </label>
              )}
            </For>
          </div>
        </fieldset>
      </section>

      <section class="settings-section" aria-labelledby="reader-heading">
        <h2 id="reader-heading">{t('Reader')}</h2>
        <div class="field-row">
          <label for="default-mode">{t('Default reading mode')}</label>
          <select id="default-mode" value={settings.defaultMode} onChange={event => void updateSettings({ defaultMode: event.currentTarget.value as ReadingMode | 'auto' })}>
            <option value="auto">{t('Automatic (by title)')}</option>
            <option value="rtl">{modeLabel('rtl')}</option>
            <option value="ltr">{modeLabel('ltr')}</option>
            <option value="vertical">{modeLabel('vertical')}</option>
          </select>
        </div>
        <label class="switch-row">
          <span><strong>{t('Data saver')}</strong><span class="hint">{t('Load smaller images when reading, saving offline, and converting.')}</span></span>
          <input type="checkbox" role="switch" checked={settings.dataSaver} onChange={event => void updateSettings({ dataSaver: event.currentTarget.checked })} />
        </label>
        <label class="switch-row">
          <span><strong>{t('Show adult content')}</strong><span class="hint">{t('Include titles rated erotica or pornographic in search. Only for adults.')}</span></span>
          <input type="checkbox" role="switch" checked={settings.showMature} onChange={event => void updateSettings({ showMature: event.currentTarget.checked })} />
        </label>
      </section>

      <section class="settings-section" id="kindle" aria-labelledby="kindle-heading">
        <h2 id="kindle-heading">{t('Kindle')}</h2>
        <div class="field-row">
          <label for="kindle-model">{t('Kindle model')}</label>
          <select id="kindle-model" value={getKindleProfile(settings.kindleModel).id} onChange={event => void updateSettings({ kindleModel: event.currentTarget.value })}>
            <For each={KINDLE_PROFILES}>{profile => <option value={profile.id}>{profile.name} ({profile.width}×{profile.height})</option>}</For>
          </select>
        </div>
        <p class="hint">{t('Pages are resized for this screen. Color is kept only for color models.')}</p>
        <TextField
          id="kindle-email"
          label={t('Send-to-Kindle email')}
          type="email"
          inputmode="email"
          autocomplete="off"
          placeholder="name_123@kindle.com"
          value={email()}
          error={emailError()}
          onInput={event => {
            setEmail(event.currentTarget.value);
            // Save as soon as the address is valid, so leaving the screen never loses it.
            if (isKindleAddress(event.currentTarget.value) && event.currentTarget.value.trim() !== settings.kindleEmail) {
              setEmailError(undefined);
              void updateSettings({ kindleEmail: event.currentTarget.value.trim() });
            }
          }}
          onChange={saveEmail}
        />
        <details class="help">
          <summary>{t('How to set up sending')}</summary>
          <ol>
            <li>{t('Open Amazon “Manage Your Content and Devices”, then “Preferences” → “Personal Document Settings”.')}</li>
            <li>{t('Copy your Kindle’s email address (ending in @kindle.com) into the field above.')}</li>
            <li>{t('Add your Gmail address to the “Approved Personal Document E-mail List”. Amazon ignores email from addresses that are not on this list.')}</li>
            <li>{t('Connect Google below. Files are sent from your own Gmail account; PLUNZ never sees them.')}</li>
          </ol>
          <a href="https://www.amazon.com/hz/mycd/myx#/home/settings/pdoc" target="_blank" rel="noopener">{t('Open Amazon settings')}</a>
        </details>
      </section>

      <Show when={isAniListConfigured()}>
        <section class="settings-section" id="tracking" aria-labelledby="tracking-heading">
          <h2 id="tracking-heading">{t('Tracking')}</h2>
          <p class="hint">{t('Optional. Link AniList to update your list when you finish a chapter and to bring chapters you read elsewhere into this app.')}</p>
          <Show when={aniListAccount()} fallback={
            <Button type="button" onClick={() => { try { connectAniList(); } catch (error) { toast(errorMessage(error)); } }}>{t('Connect AniList')}</Button>
          }>
            {linked => (
              <>
                <p>{t('Connected to AniList as {name}', { name: linked().userName })}</p>
                <div class="button-row">
                  <Button type="button" variant="ghost" size="sm" onClick={() => void disconnectAniList().then(() => toast(t('AniList disconnected.')))}>{t('Disconnect')}</Button>
                </div>
              </>
            )}
          </Show>
        </section>
      </Show>

      <Show when={isGoogleConfigured()}>
        <section class="settings-section" id="extra-sources" aria-labelledby="extra-heading">
          <h2 id="extra-heading">{t('Extra chapter sources')}</h2>
          <p class="hint">{t('Fills chapters missing from a title with another source. Sign in with Google to turn it on.')}</p>
          <Show when={extraSession()} fallback={
            <Button type="button" variant="outline" disabled={busy()} onClick={() => void withBusy(async () => {
              const unlocked = await unlockExtraSources();
              toast(t('Extra sources unlocked for {email}', { email: unlocked.email }));
            })}>{t('Unlock with Google')}</Button>
          }>
            {current => (
              <>
                <p>{t('Unlocked for {email}', { email: current().email })}</p>
                <label class="switch-row">
                  <span><strong>{t('Fill automatically')}</strong><span class="hint">{t('Link titles whose name matches exactly when you open them. You can change or stop it on the title.')}</span></span>
                  <input type="checkbox" role="switch" checked={settings.autoFill !== false} onChange={event => void updateSettings({ autoFill: event.currentTarget.checked })} />
                </label>
                <div class="button-row">
                  <Button type="button" variant="ghost" size="sm" onClick={() => void lockExtraSources()}>{t('Lock')}</Button>
                </div>
              </>
            )}
          </Show>
        </section>
      </Show>

      <section class="settings-section" aria-labelledby="google-heading">
        <h2 id="google-heading">{t('Google account')}</h2>
        <Show when={isGoogleConfigured()} fallback={<p class="hint">{t('Google features are not configured on this site yet. Everything else works without an account.')}</p>}>
          <p class="hint">{t('Optional. Used only to sync your library through a hidden folder in your Google Drive and to email files to your Kindle from your Gmail. Each permission is requested when you first need it.')}</p>
          <Show when={googleState().connected} fallback={
            <Button type="button" disabled={busy()} onClick={() => void withBusy(async () => { await connect(['drive']); setSyncOn(true); await setSyncEnabled(true); })}>{t('Connect Google and sync')}</Button>
          }>
            <p>{t('Connected as {email}', { email: googleState().email ?? '' })}</p>
            <label class="switch-row">
              <span><strong>{t('Sync library and progress')}</strong><span class="hint">
                {syncStatus() === 'syncing' ? t('Syncing…')
                  : syncStatus() === 'reconnect' ? t('Reconnect Google to keep syncing.')
                  : syncStatus() === 'error' ? t('The last sync failed. It will retry automatically.')
                  : lastSync() ? t('Last synced {time}', { time: new Date(lastSync()!).toLocaleString() }) : t('Not synced yet')}
              </span></span>
              <input type="checkbox" role="switch" checked={syncOn()} disabled={busy()} onChange={event => {
                const value = event.currentTarget.checked;
                void withBusy(async () => {
                  if (value && !googleState().scopes.includes('drive')) await connect(['drive']);
                  setSyncOn(value);
                  await setSyncEnabled(value);
                });
              }} />
            </label>
            <div class="button-row">
              <Show when={syncStatus() === 'reconnect'}>
                <Button type="button" disabled={busy()} onClick={() => void withBusy(async () => { await connect(['drive']); await syncNow(); })}>{t('Reconnect')}</Button>
              </Show>
              <Button type="button" variant="outline" size="sm" disabled={busy() || !syncOn()} onClick={() => void withBusy(syncNow)}>{t('Sync now')}</Button>
              <Button type="button" variant="ghost" size="sm" disabled={busy()} onClick={() => void withBusy(async () => {
                if (!confirm(t('Delete the synced copy from your Google Drive? Data on this device is kept.'))) return;
                await deleteAppData();
                toast(t('Synced data deleted from Google Drive.'));
              })}>{t('Delete synced data')}</Button>
              <Button type="button" variant="ghost" size="sm" disabled={busy()} onClick={() => void withBusy(async () => { await setSyncEnabled(false); setSyncOn(false); await disconnect(); })}>{t('Disconnect')}</Button>
            </div>
          </Show>
        </Show>
      </section>

      <section class="settings-section" aria-labelledby="storage-heading">
        <h2 id="storage-heading">{t('Storage')}</h2>
        <Show when={estimate()}>{value => <p class="muted">{t('Using {used} of about {quota} available on this device.', { used: formatBytes(value().usage), quota: formatBytes(value().quota) })}</p>}</Show>
        <Button type="button" variant="outline" size="sm" onClick={() => void requestPersistentStorage().then(value => { setPersisted(value); refetchEstimate(); })}>{t('Keep offline data')}</Button>
        <Show when={persisted() !== undefined}>
          <p class="hint">{persisted() ? t('This browser will keep offline chapters unless you remove them.') : t('This browser may remove offline chapters when space runs low. Installing the app helps.')}</p>
        </Show>
      </section>

      <section class="settings-section" aria-labelledby="about-heading">
        <h2 id="about-heading">{t('About')}</h2>
        <p class="hint">{t('Your library, progress, and downloads stay on this device. PLUNZ has no account and stores no manga. Titles and chapters come from MangaDex and are translated by the scanlation groups credited on each chapter.')}</p>
        <p class="hint">{t('Support the official release when it is available in your country.')}</p>
        <p><a href="https://mangadex.org" target="_blank" rel="noopener">MangaDex</a> · <a href="https://plu.nz" target="_blank" rel="noopener">PLUNZ</a> · <a href="/privacy" rel="external">{t('Privacy')}</a></p>
      </section>
    </section>
  );
}
