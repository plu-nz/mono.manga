import { createMemo, createSignal, onSettled, Show } from 'solid-js';
import { Button, TextField } from '@plunz/storybook';
import type { ChapterSummary, MangaDetails, ReadingMode } from '../core/types';
import { getKindleProfile } from './profiles';
import { buildEpubs, downloadBlob, isKindleAddress, planExports, type BuildProgress } from './send';
import { getAccessToken, isGoogleConfigured, maxAttachmentBytes, preloadGoogle, sendFileByEmail } from '../google';
import { DEFAULT_MAX_PART_BYTES } from '../converter';
import { markSentToKindle, settings, updateSettings } from '../library/store';
import { t, tn } from '../i18n';
import { ProgressBar, Sheet, errorMessage, toast } from '../app/ui';

type Phase = 'setup' | 'converting' | 'sending' | 'error';

export interface SendSheetApi {
  /** Start sending right away. Call it from the tap itself so the Gmail popup is not blocked. */
  send(chapters: ChapterSummary[]): void;
}

/**
 * Sends chapters to the Kindle as one EPUB per chapter, with no options.
 * The sheet only shows progress, errors, or the one-time Kindle email setup.
 */
export function SendSheet(props: {
  open: boolean;
  onClose: () => void;
  details: MangaDetails;
  mode: ReadingMode;
  /** Solid assigns the API to a `let` variable or passes it to a callback. */
  ref?: SendSheetApi | ((api: SendSheetApi) => void);
}) {
  const [chapters, setChapters] = createSignal<ChapterSummary[]>([]);
  const [phase, setPhase] = createSignal<Phase>('setup');
  const [progress, setProgress] = createSignal<BuildProgress>();
  const [sendProgress, setSendProgress] = createSignal<{ loaded: number; total: number; file: number; files: number }>();
  const [message, setMessage] = createSignal<string>();
  let controller: AbortController | undefined;
  /** What "Try again" repeats after an error. */
  let retry: () => Promise<void> = () => run();
  // Load Google's script early so the Gmail popup can open inside the tap.
  onSettled(() => { if (isGoogleConfigured()) void preloadGoogle(); });

  const pageTotal = createMemo(() => chapters().reduce((sum, chapter) => sum + (chapter.externalUrl ? 0 : chapter.pages), 0));
  const profile = createMemo(() => getKindleProfile(settings.kindleModel));
  const canEmail = () => isGoogleConfigured() && Boolean(settings.kindleEmail);
  const busy = () => phase() === 'converting' || phase() === 'sending';
  const [emailDraft, setEmailDraft] = createSignal('');
  const [emailError, setEmailError] = createSignal<string>();

  (props.ref as ((api: SendSheetApi) => void) | undefined)?.({
    send(next) {
      setChapters(next);
      setMessage(undefined);
      if (canEmail()) void run(); else setPhase('setup');
    },
  });

  function saveKindleEmail() {
    const value = emailDraft().trim();
    if (!isKindleAddress(value)) {
      setEmailError(t('Use the address ending in @kindle.com shown in your Amazon account.'));
      return;
    }
    setEmailError(undefined);
    // Start inside the same tap so Gmail's consent popup is allowed.
    void updateSettings({ kindleEmail: value });
    void run();
  }

  function close() {
    if (busy()) controller?.abort();
    setPhase('setup');
    setMessage(undefined);
    props.onClose();
  }

  function build(maxPartBytes: number, signal: AbortSignal) {
    return buildEpubs({
      details: props.details,
      plans: planExports(props.details, chapters(), 'chapter'),
      profileId: profile().id,
      mode: props.mode,
      dataSaver: settings.dataSaver,
      signal,
      onProgress: setProgress,
      maxPartBytes,
    });
  }

  async function run() {
    retry = run;
    controller = new AbortController();
    const signal = controller.signal;
    const sentChapters = chapters();
    setMessage(undefined);
    setProgress(undefined);
    setSendProgress(undefined);
    try {
      // Ask for Gmail access while the tap still counts as a user gesture; the popup would be blocked after a long conversion.
      const tokenRequest = getAccessToken(['gmail'], { interactive: true });
      setPhase('converting');
      await tokenRequest;
      // Gmail's API allows ~35 MB, but messages above ~25 MB fail in practice; base64 adds a third.
      const parts = await build(Math.min(maxAttachmentBytes(), DEFAULT_MAX_PART_BYTES), signal);
      setPhase('sending');
      for (const [index, part] of parts.entries()) {
        setSendProgress({ loaded: 0, total: part.blob.size, file: index + 1, files: parts.length });
        await sendFileByEmail({
          to: settings.kindleEmail!,
          subject: part.title,
          text: t('Sent from PLUNZ Manga.'),
          file: part.blob,
          fileName: part.fileName,
          mimeType: 'application/epub+zip',
          signal,
          onProgress: (loaded: number, total: number) => setSendProgress({ loaded, total, file: index + 1, files: parts.length }),
        });
      }
      await markSentToKindle(props.details, sentChapters);
      toast(t('Sent to Kindle.'));
      close();
    } catch (error) {
      if (signal.aborted) return;
      setPhase('error');
      setMessage(errorMessage(error));
    }
  }

  /** Without Google sign-in in this build, the EPUB files are the only way to reach the Kindle. */
  async function download() {
    retry = download;
    controller = new AbortController();
    const signal = controller.signal;
    setMessage(undefined);
    try {
      setPhase('converting');
      const parts = await build(Number.POSITIVE_INFINITY, signal);
      for (const part of parts) downloadBlob(part.blob, part.fileName);
      toast(tn(parts.length, 'Your EPUB is ready.', 'Your {count} EPUB files are ready.'));
      close();
    } catch (error) {
      if (signal.aborted) return;
      setPhase('error');
      setMessage(errorMessage(error));
    }
  }

  return (
    <Sheet open={props.open} onClose={close} title={t('Send to Kindle')}>
      <div class="stack">
        <p class="muted">
          {tn(chapters().length, '{count} chapter', '{count} chapters')} · {tn(pageTotal(), '{count} page', '{count} pages')} · {profile().name}
          {' '}<a href="/settings#kindle" onClick={close}>{t('Change')}</a>
        </p>

        <Show when={phase() === 'converting'}>
          <Show when={progress()} fallback={<p class="muted" role="status">{t('Preparing…')}</p>}>
            {current => (
              <ProgressBar
                value={current().processed}
                max={current().total}
                label={current().files > 1 ? t('Converting file {file} of {files}', { file: current().file, files: current().files }) : t('Converting pages')}
              />
            )}
          </Show>
        </Show>
        <Show when={phase() === 'sending' && sendProgress()}>
          {current => (
            <ProgressBar value={current().loaded} max={current().total} label={t('Sending file {file} of {files}', { file: current().file, files: current().files })} />
          )}
        </Show>

        <Show when={message()}>
          <p class="error" role="alert">{message()}</p>
        </Show>

        <Show when={phase() === 'setup' && !canEmail()}>
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
              <Button type="submit">{t('Save and send')}</Button>
            </form>
          </Show>
        </Show>

        <div class="sheet-actions">
          <Show when={busy()}>
            <Button type="button" variant="outline" onClick={close}>{t('Cancel')}</Button>
          </Show>
          <Show when={phase() === 'error'}>
            <Button type="button" onClick={() => void retry()}>{t('Try again')}</Button>
          </Show>
          <Show when={phase() === 'setup' && !isGoogleConfigured()}>
            <Button type="button" onClick={() => void download()}>{t('Download EPUB')}</Button>
          </Show>
        </div>
        <p class="hint">{t('Conversion happens on this device. Keep this screen open until it finishes.')}</p>
      </div>
    </Sheet>
  );
}
