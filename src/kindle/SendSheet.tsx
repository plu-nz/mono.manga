import { createMemo, createSignal, For, onMount, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { Button, TextField } from '@plunz/storybook';
import type { ChapterSummary, MangaDetails, ReadingMode } from '../core/types';
import { getKindleProfile } from './profiles';
import { buildEpubs, downloadBlob, isKindleAddress, planExports, type BuildProgress, type Grouping } from './send';
import { getAccessToken, isGoogleConfigured, maxAttachmentBytes, preloadGoogle, sendFileByEmail } from '../google';
import { DEFAULT_MAX_PART_BYTES } from '../converter';
import { markSentToKindle, settings, updateSettings } from '../library/store';
import { formatBytes, t, tn } from '../i18n';
import { ProgressBar, Sheet, errorMessage, toast } from '../app/ui';

type Phase = 'idle' | 'converting' | 'sending' | 'done' | 'error';

export function SendSheet(props: {
  open: boolean;
  onClose: () => void;
  details: MangaDetails;
  chapters: ChapterSummary[];
  mode: ReadingMode;
}) {
  const [grouping, setGrouping] = createSignal<Grouping>('single');
  const [phase, setPhase] = createSignal<Phase>('idle');
  const [progress, setProgress] = createSignal<BuildProgress>();
  const [sendProgress, setSendProgress] = createSignal<{ loaded: number; total: number; file: number; files: number }>();
  const [message, setMessage] = createSignal<string>();
  const [results, setResults] = createSignal<Array<{ fileName: string; size: number; sent: boolean; blob: Blob }>>([]);
  let controller: AbortController | undefined;
  // Load Google's script early so the Gmail popup can open inside the tap.
  onMount(() => { if (isGoogleConfigured()) void preloadGoogle(); });

  const plans = createMemo(() => planExports(props.details, props.chapters, grouping()));
  const pageTotal = createMemo(() => props.chapters.reduce((sum, chapter) => sum + (chapter.externalUrl ? 0 : chapter.pages), 0));
  const profile = createMemo(() => getKindleProfile(settings.kindleModel));
  const canEmail = () => isGoogleConfigured() && Boolean(settings.kindleEmail);
  const [emailDraft, setEmailDraft] = createSignal('');
  const [emailError, setEmailError] = createSignal<string>();

  function saveKindleEmail() {
    const value = emailDraft().trim();
    if (!isKindleAddress(value)) {
      setEmailError(t('Use the address ending in @kindle.com shown in your Amazon account.'));
      return;
    }
    setEmailError(undefined);
    void updateSettings({ kindleEmail: value });
  }
  const busy = () => phase() === 'converting' || phase() === 'sending';

  function close() {
    if (busy()) controller?.abort();
    setPhase('idle');
    setResults([]);
    setMessage(undefined);
    props.onClose();
  }

  async function run(target: 'email' | 'download') {
    controller = new AbortController();
    setResults([]);
    setMessage(undefined);
    try {
      // Ask for Gmail access while the tap still counts as a user gesture; the popup would be blocked after a long conversion.
      if (target === 'email') await getAccessToken(['gmail'], { interactive: true });
      setPhase('converting');
      const parts = await buildEpubs({
        details: props.details,
        plans: plans(),
        profileId: profile().id,
        mode: props.mode,
        dataSaver: settings.dataSaver,
        signal: controller.signal,
        onProgress: setProgress,
        // Gmail's API allows ~35 MB, but messages above ~25 MB fail in practice; base64 adds a third.
        maxPartBytes: target === 'email' ? Math.min(maxAttachmentBytes(), DEFAULT_MAX_PART_BYTES) : Number.POSITIVE_INFINITY,
      });
      if (target === 'download') {
        for (const part of parts) downloadBlob(part.blob, part.fileName);
        setResults(parts.map(part => ({ fileName: part.fileName, size: part.blob.size, sent: false, blob: part.blob })));
        setPhase('done');
        setMessage(tn(parts.length, 'Your EPUB is ready.', 'Your {count} EPUB files are ready.'));
        return;
      }
      setPhase('sending');
      const sent: Array<{ fileName: string; size: number; sent: boolean; blob: Blob }> = [];
      for (const [index, part] of parts.entries()) {
        setSendProgress({ loaded: 0, total: part.blob.size, file: index + 1, files: parts.length });
        await sendFileByEmail({
          to: settings.kindleEmail!,
          subject: part.title,
          text: t('Sent from PLUNZ Manga.'),
          file: part.blob,
          fileName: part.fileName,
          mimeType: 'application/epub+zip',
          signal: controller.signal,
          onProgress: (loaded: number, total: number) => setSendProgress({ loaded, total, file: index + 1, files: parts.length }),
        });
        sent.push({ fileName: part.fileName, size: part.blob.size, sent: true, blob: part.blob });
        setResults([...sent]);
      }
      await markSentToKindle(props.details, props.chapters);
      setPhase('done');
      setMessage(t('Sent. Your Kindle will download it the next time it connects to Wi-Fi.'));
      toast(t('Sent to Kindle.'));
    } catch (error) {
      setPhase('error');
      setMessage(errorMessage(error));
    }
  }

  return (
    <Sheet open={props.open} onClose={close} title={t('Send to Kindle')}>
      <div class="stack">
        <p class="muted">
          {tn(props.chapters.length, '{count} chapter', '{count} chapters')} · {tn(pageTotal(), '{count} page', '{count} pages')} · {profile().name}
          {' '}<A href="/settings#kindle" onClick={close}>{t('Change')}</A>
        </p>

        <fieldset class="choice-group" disabled={busy()}>
          <legend>{t('Files')}</legend>
          <For each={[
            { value: 'single' as const, label: t('One file') },
            { value: 'volume' as const, label: t('One file per volume') },
            { value: 'chapter' as const, label: t('One file per chapter') },
          ]}>
            {option => (
              <label class="choice">
                <input type="radio" name="grouping" value={option.value} checked={grouping() === option.value} onChange={() => setGrouping(option.value)} />
                <span>{option.label}</span>
              </label>
            )}
          </For>
          <p class="hint">{tn(plans().length, 'Creates {count} file. Large files are split to fit email limits.', 'Creates {count} files. Large files are split to fit email limits.')}</p>
        </fieldset>

        <Show when={phase() === 'converting' && progress()}>
          {current => (
            <ProgressBar
              value={current().processed}
              max={current().total}
              label={current().files > 1 ? t('Converting file {file} of {files}', { file: current().file, files: current().files }) : t('Converting pages')}
            />
          )}
        </Show>
        <Show when={phase() === 'sending' && sendProgress()}>
          {current => (
            <ProgressBar value={current().loaded} max={current().total} label={t('Sending file {file} of {files}', { file: current().file, files: current().files })} />
          )}
        </Show>

        <Show when={message()}>
          <p class={phase() === 'error' ? 'error' : 'success'} role={phase() === 'error' ? 'alert' : 'status'}>{message()}</p>
        </Show>
        <Show when={results().length}>
          <ul class="file-list">
            <For each={results()}>
              {result => (
                <li>
                  <span>{result.fileName}</span>
                  <span class="muted">{formatBytes(result.size)}</span>
                  <button type="button" class="text-button" onClick={() => downloadBlob(result.blob, result.fileName)}>{t('Download')}</button>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <Show when={!canEmail() && phase() !== 'done'}>
          <Show when={isGoogleConfigured()} fallback={
            <p class="hint">{t('Direct sending is not available in this version. Reload the app to update, or download the EPUB and use Send to Kindle from Amazon.')}</p>
          }>
            <form class="inline-form" onSubmit={event => { event.preventDefault(); saveKindleEmail(); }}>
              <TextField
                id="sheet-kindle-email"
                label={t('Send-to-Kindle email')}
                type="email"
                inputmode="email"
                autocomplete="off"
                placeholder="name_123@kindle.com"
                value={emailDraft()}
                error={emailError()}
                hint={t('Find it in Amazon under Preferences → Personal Document Settings.')}
                onInput={event => setEmailDraft(event.currentTarget.value)}
              />
              <Button type="submit" variant="outline">{t('Save')}</Button>
            </form>
          </Show>
        </Show>

        <div class="sheet-actions">
          <Show when={busy()} fallback={
            <>
              <Button type="button" variant="outline" onClick={() => void run('download')}>{t('Download EPUB')}</Button>
              <Show when={canEmail()}>
                <Button type="button" onClick={() => void run('email')}>{t('Send to {email}', { email: settings.kindleEmail ?? '' })}</Button>
              </Show>
            </>
          }>
            <Button type="button" variant="outline" onClick={() => controller?.abort()}>{t('Cancel')}</Button>
          </Show>
        </div>
        <p class="hint">{t('Conversion happens on this device. Keep this screen open until it finishes.')}</p>
        <Show when={!busy()}>
          <button type="button" class="text-button" onClick={() => void markSentToKindle(props.details, props.chapters).then(() => { toast(t('Marked as sent. “Send new chapters” continues after these.')); close(); })}>
            {t('Already on my Kindle — mark as sent')}
          </button>
        </Show>
      </div>
    </Sheet>
  );
}
