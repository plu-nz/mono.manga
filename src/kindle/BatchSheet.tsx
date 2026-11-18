import { createEffect, createSignal, For, on, onMount, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { Button } from '@plunz/storybook';
import { chapterLabel } from '../core/types';
import { getAccessToken, isGoogleConfigured, preloadGoogle } from '../google';
import { settings } from '../library/store';
import { getKindleProfile } from './profiles';
import type { TitleBatch } from './auto';
import { deliverBatch, planNewChapters, type BatchStage } from './batch';
import { t, tn } from '../i18n';
import { ProgressBar, Sheet, errorMessage, toast } from '../app/ui';

type Phase = 'checking' | 'review' | 'running' | 'done';

interface Outcome {
  title: string;
  ok: boolean;
  detail: string;
}

/** One tap: refresh favorites, then send every chapter not yet on the Kindle. */
export function BatchSheet(props: { open: boolean; onClose: () => void }) {
  const [phase, setPhase] = createSignal<Phase>('checking');
  const [checked, setChecked] = createSignal({ done: 0, total: 0 });
  const [batches, setBatches] = createSignal<TitleBatch[]>([]);
  const [checkFailures, setCheckFailures] = createSignal<string[]>([]);
  const [current, setCurrent] = createSignal<{ index: number; title: string; stage?: BatchStage }>();
  const [outcomes, setOutcomes] = createSignal<Outcome[]>([]);
  let controller: AbortController | undefined;

  /** Reactive progress of the title being delivered. */
  const stageProgress = () => {
    const item = current();
    const stage = item?.stage;
    const prefix = `${(item?.index ?? 0) + 1}/${batches().length} · ${item?.title ?? ''}`;
    if (!stage) return { value: 0, max: 1, label: prefix };
    return stage.kind === 'converting'
      ? { value: stage.progress.processed, max: stage.progress.total, label: `${prefix} · ${t('Converting pages')}` }
      : { value: stage.loaded, max: stage.total, label: `${prefix} · ${t('Sending file {file} of {files}', { file: stage.file, files: stage.files })}` };
  };
  const canEmail = () => isGoogleConfigured() && Boolean(settings.kindleEmail);
  const chapterCount = () => batches().reduce((sum, batch) => sum + batch.chapters.length, 0);

  onMount(() => { if (isGoogleConfigured()) void preloadGoogle(); });

  async function check() {
    controller = new AbortController();
    setPhase('checking');
    setOutcomes([]);
    const result = await planNewChapters({ signal: controller.signal, onProgress: (done, total) => setChecked({ done, total }) });
    setBatches(result.batches);
    setCheckFailures(result.failed.map(item => `${item.title}: ${errorMessage(item.error)}`));
    setPhase('review');
  }

  async function run(target: 'email' | 'download') {
    controller = new AbortController();
    try {
      // Ask for Gmail access while the tap still counts as a user gesture.
      if (target === 'email') await getAccessToken(['gmail'], { interactive: true });
    } catch (error) {
      toast(errorMessage(error));
      return;
    }
    setPhase('running');
    const results: Outcome[] = [];
    for (const [index, batch] of batches().entries()) {
      if (controller.signal.aborted) break;
      setCurrent({ index, title: batch.details.title });
      try {
        const files = await deliverBatch(batch, target, {
          signal: controller.signal,
          onStage: stage => setCurrent({ index, title: batch.details.title, stage }),
        });
        results.push({ title: batch.details.title, ok: true, detail: tn(files, '{count} file', '{count} files') });
      } catch (error) {
        results.push({ title: batch.details.title, ok: false, detail: errorMessage(error) });
      }
      setOutcomes([...results]);
    }
    setCurrent(undefined);
    setPhase('done');
    const sent = results.filter(item => item.ok).length;
    if (target === 'email' && sent) toast(tn(sent, 'Sent {count} title to Kindle.', 'Sent {count} titles to Kindle.'));
  }

  function close() {
    controller?.abort();
    props.onClose();
  }

  // Start checking as soon as the sheet opens.
  createEffect(on(() => props.open, open => { if (open) void check(); }, { defer: true }));

  return (
    <Sheet open={props.open} onClose={close} title={t('Send new chapters')}>
      <div class="stack">
        <p class="muted">{t('Favorites only. Chapters already sent are skipped.')} · {getKindleProfile(settings.kindleModel).name}</p>

        <Show when={phase() === 'checking'}>
          <ProgressBar value={checked().done} max={checked().total} label={t('Checking favorites')} />
        </Show>

        <Show when={phase() !== 'checking'}>
          <Show when={batches().length} fallback={<p class="success" role="status">{t('Your Kindle is up to date. No new chapters in your favorites.')}</p>}>
            <ul class="batch-list">
              <For each={batches()}>
                {(batch, index) => {
                  const outcome = () => outcomes()[index()];
                  const first = batch.chapters[0];
                  const last = batch.chapters[batch.chapters.length - 1];
                  return (
                    <li classList={{ active: current()?.index === index() }}>
                      <div>
                        <strong>{batch.details.title}</strong>
                        <span class="muted small">
                          {tn(batch.chapters.length, '{count} chapter', '{count} chapters')} · {batch.chapters.length > 1 ? `${chapterLabel({ ...first, title: undefined })} – ${chapterLabel({ ...last, title: undefined })}` : chapterLabel({ ...first, title: undefined })}
                        </span>
                        <Show when={batch.startsAtLatest}><span class="hint">{t('First send: starts with the latest chapter.')}</span></Show>
                      </div>
                      <Show when={outcome()}>{result => <span class={result().ok ? 'success small' : 'error small'}>{result().ok ? `✓ ${result().detail}` : result().detail}</span>}</Show>
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>
          <Show when={checkFailures().length}>
            <details class="help"><summary>{tn(checkFailures().length, '{count} title could not be checked', '{count} titles could not be checked')}</summary><ul><For each={checkFailures()}>{line => <li>{line}</li>}</For></ul></details>
          </Show>
        </Show>

        <Show when={phase() === 'running' && current()?.stage}>
          <ProgressBar value={stageProgress().value} max={stageProgress().max} label={stageProgress().label} />
        </Show>

        <Show when={!canEmail() && phase() === 'review' && batches().length}>
          <p class="hint">{t('Add your Kindle email and connect Google in Settings to send directly.')} <A href="/settings#kindle" onClick={close}>{t('Settings')}</A></p>
        </Show>

        <div class="sheet-actions">
          <Show when={phase() === 'review' && batches().length}>
            <Button type="button" variant="outline" onClick={() => void run('download')}>{t('Download all')}</Button>
            <Show when={canEmail()}>
              <Button type="button" onClick={() => void run('email')}>{tn(chapterCount(), 'Send {count} chapter', 'Send {count} chapters')}</Button>
            </Show>
          </Show>
          <Show when={phase() === 'running' || phase() === 'checking'}>
            <Button type="button" variant="outline" onClick={() => controller?.abort()}>{t('Stop')}</Button>
          </Show>
          <Show when={phase() === 'done'}>
            <Button type="button" variant="outline" onClick={() => void check()}>{t('Check again')}</Button>
          </Show>
        </div>
        <p class="hint">{t('Conversion happens on this device. Keep this screen open until it finishes.')}</p>
      </div>
    </Sheet>
  );
}
