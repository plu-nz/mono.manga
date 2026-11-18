import { createResource, createSignal, onCleanup, Show, type JSX, splitProps, createEffect } from 'solid-js';
import { Portal } from 'solid-js/web';
import { LOCAL_COVER_PREFIX } from '../providers/local';
import { getStoredPage } from '../storage/downloads';
import { t } from '../i18n';

const ICONS = {
  library: 'M4 4h4v16H4zM10 4h4v16h-4zM16.5 4.5l3.8 1-3.6 15-3.8-1z',
  search: 'M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zm0 2a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zm5.2 9.3 4.6 4.6-1.4 1.4-4.6-4.6z',
  download: 'M11 3h2v9.6l3.3-3.3 1.4 1.4L12 16.4l-5.7-5.7 1.4-1.4 3.3 3.3zM4 18h16v2H4z',
  settings: 'M10.3 2h3.4l.5 2.6 1.9.8 2.2-1.5 2.4 2.4-1.5 2.2.8 1.9 2.6.5v3.4l-2.6.5-.8 1.9 1.5 2.2-2.4 2.4-2.2-1.5-1.9.8-.5 2.6h-3.4l-.5-2.6-1.9-.8-2.2 1.5-2.4-2.4 1.5-2.2-.8-1.9L2 13.7v-3.4l2.6-.5.8-1.9-1.5-2.2 2.4-2.4 2.2 1.5 1.9-.8zM12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z',
  back: 'M15.4 4.6 8 12l7.4 7.4-1.4 1.4L5.2 12 14 3.2z',
  star: 'M12 2.8l2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3L2.9 9.5l6.3-.9z',
  starOutline: 'M12 2.8l2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3L2.9 9.5l6.3-.9zm0 4.5-1.5 3.1-3.4.5 2.5 2.4-.6 3.4 3-1.6 3 1.6-.6-3.4 2.5-2.4-3.4-.5z',
  plus: 'M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z',
  check: 'M9.5 16.2 4.8 11.5l-1.4 1.4 6.1 6.1L21 7.5l-1.4-1.4z',
  close: 'M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4z',
  send: 'M3 4.5 21.5 12 3 19.5l2.2-7.5zm3.8 8.5-1 3.4L15.8 12l-10-4.4 1 3.4H12v2z',
  trash: 'M9 3h6l1 2h4v2H4V5h4zM6 9h12l-1 12H7zm4 2v8h1.5v-8zm2.5 0v8H14v-8z',
  upload: 'M11 20h2v-9.6l3.3 3.3 1.4-1.4L12 6.6l-5.7 5.7 1.4 1.4 3.3-3.3zM4 4h16v2H4z',
  menu: 'M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z',
  external: 'M14 3h7v7h-2V6.4l-8.3 8.3-1.4-1.4L17.6 5H14zM5 5h6v2H7v10h10v-4h2v6H5z',
  bell: 'M12 22a2.5 2.5 0 0 0 2.5-2.5h-5A2.5 2.5 0 0 0 12 22zm7-6V11a7 7 0 0 0-5.5-6.8V3h-3v1.2A7 7 0 0 0 5 11v5l-2 2v1h18v-1z',
  sync: 'M12 4a8 8 0 0 1 7.4 5H17v2h6V5h-2v2.3A10 10 0 0 0 2 12h2a8 8 0 0 1 8-8zm8 8a8 8 0 0 1-15.4 3H7v-2H1v6h2v-2.3A10 10 0 0 0 22 12z',
} as const;

export type IconName = keyof typeof ICONS;

export function Icon(props: { name: IconName; size?: number; class?: string; label?: string }) {
  return (
    <svg
      class={`icon ${props.class ?? ''}`}
      width={props.size ?? 22}
      height={props.size ?? 22}
      viewBox="0 0 24 24"
      fill="currentColor"
      role={props.label ? 'img' : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : 'true'}
    >
      <path d={ICONS[props.name]} fill-rule="evenodd" />
    </svg>
  );
}

/** Cover image that also resolves covers of imported titles from IndexedDB. */
export function Cover(props: { url?: string; title: string; class?: string; eager?: boolean }) {
  const [failed, setFailed] = createSignal(false);
  const [src] = createResource(
    () => props.url,
    async url => {
      if (!url.startsWith(LOCAL_COVER_PREFIX)) return url;
      const blob = await getStoredPage(`local:${url.slice(LOCAL_COVER_PREFIX.length)}`, 0);
      return blob ? URL.createObjectURL(blob) : undefined;
    },
  );
  createEffect(() => {
    const value = src();
    if (value?.startsWith('blob:')) onCleanup(() => URL.revokeObjectURL(value));
  });
  return (
    <div class={`cover ${props.class ?? ''}`}>
      <Show when={src() && !failed()} fallback={<span class="cover-fallback" aria-hidden="true">{props.title.slice(0, 1).toUpperCase()}</span>}>
        <img src={src()} alt="" loading={props.eager ? 'eager' : 'lazy'} decoding="async" onError={() => setFailed(true)} />
      </Show>
    </div>
  );
}

/** Accessible bottom sheet built on the native dialog element. */
export function Sheet(props: { open: boolean; onClose: () => void; title: string; children: JSX.Element }) {
  let dialog: HTMLDialogElement | undefined;
  createEffect(() => {
    if (!dialog) return;
    if (props.open && !dialog.open) dialog.showModal();
    if (!props.open && dialog.open) dialog.close();
  });
  return (
    <Portal>
      <dialog
        ref={dialog}
        // Portaled outside the app, so it carries the theme tokens itself.
        class="sheet plz-theme"
        data-plz-accent="orange"
        data-plz-shape="square"
        aria-label={props.title}
        onClose={() => props.onClose()}
        onClick={event => { if (event.target === dialog) props.onClose(); }}
      >
        <div class="sheet-body">
          <div class="sheet-head">
            <h2>{props.title}</h2>
            <button type="button" class="icon-button" onClick={() => props.onClose()} aria-label={t('Close')}>
              <Icon name="close" />
            </button>
          </div>
          <Show when={props.open}>{props.children}</Show>
        </div>
      </dialog>
    </Portal>
  );
}

export function ProgressBar(props: { value: number; max: number; label: string }) {
  return (
    <div class="progress">
      <div class="progress-label"><span>{props.label}</span><span>{props.max ? Math.round((props.value / props.max) * 100) : 0}%</span></div>
      <progress value={props.value} max={props.max || 1} aria-label={props.label} />
    </div>
  );
}

export function EmptyState(props: { icon: IconName; title: string; children?: JSX.Element }) {
  return (
    <div class="empty">
      <Icon name={props.icon} size={36} />
      <h2>{props.title}</h2>
      {props.children}
    </div>
  );
}

export function IconButton(props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; pressed?: boolean }) {
  const [local, rest] = splitProps(props, ['icon', 'label', 'pressed', 'class']);
  return (
    <button type="button" {...rest} class={`icon-button ${local.class ?? ''}`} aria-label={local.label} title={local.label} aria-pressed={local.pressed}>
      <Icon name={local.icon} />
    </button>
  );
}

const [toastText, setToastText] = createSignal<string>();
let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** Brief status message announced to screen readers. */
export function toast(message: string): void {
  setToastText(message);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setToastText(undefined), 4000);
}

export function ToastRegion() {
  return (
    <div class="toast-region" role="status" aria-live="polite">
      <Show when={toastText()}>{text => <div class="toast">{text()}</div>}</Show>
    </div>
  );
}

/** Translate known error codes from providers, Google, and the converter. */
export function errorMessage(error: unknown): string {
  const code = (error as { code?: string } | undefined)?.code;
  switch (code) {
    case 'rate_limited': return t('Too many requests. Please wait a minute and try again.');
    case 'network': return t('You seem to be offline. Check your connection.');
    case 'not_found': return t('This item is no longer available.');
    case 'upstream': return t('The source is not responding. Try again later.');
    case 'unsupported_format': return t('This file type is not supported. Use CBZ, ZIP, or images.');
    case 'empty_archive': return t('No images were found in this file.');
    case 'not_configured': return t('Google integration is not configured on this site.');
    case 'popup_blocked': return t('The Google window was blocked. Allow pop-ups and try again.');
    case 'popup_closed': return t('The Google window was closed before finishing.');
    case 'interaction_required': return t('Reconnect your Google account to continue.');
    case 'access_denied': return t('Google access was not granted.');
    case 'too_large': return t('The file is too large to email. Download it instead.');
    case 'quota': return t('Google rejected the request because a limit was reached.');
    case 'aborted': return t('Cancelled.');
    case 'image_decode_failed': return t('A page image could not be read.');
    case 'unsupported_browser': return t('This browser cannot convert files. Try a recent Chrome, Edge, Firefox, or Safari.');
    case 'page_missing': return t('A page is missing from the offline copy. Download the chapter again.');
    default:
      if (typeof navigator !== 'undefined' && !navigator.onLine) return t('You seem to be offline. Check your connection.');
      return t('Something went wrong. Please try again.');
  }
}
