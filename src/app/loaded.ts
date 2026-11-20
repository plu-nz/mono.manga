import { createEffect, createSignal, type Accessor } from 'solid-js';

export interface Loaded<T> {
  /** The last answer; undefined until the first one, and after an error. */
  (): T | undefined;
  loading: Accessor<boolean>;
  error: Accessor<unknown>;
  /** Asks again for the same input. */
  refetch: () => void;
  /** Replaces the shown answer without asking. */
  mutate: (update: (current: T | undefined) => T | undefined) => void;
}

/**
 * Data loaded beside a screen instead of holding it: the screen renders at
 * once and shows the answer when it lands, keeping the last answer while a
 * newer one loads. Nothing is asked while the input is undefined, null or
 * false. An answer for an input that changed meanwhile is dropped.
 */
export function createLoaded<S, T>(source: Accessor<S | undefined | null | false>, load: (input: S) => Promise<T>): Loaded<T> {
  const [value, setValue] = createSignal<T | undefined>(undefined);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<unknown>(undefined);
  const [attempt, setAttempt] = createSignal(0);

  createEffect(
    () => [source(), attempt()] as const,
    ([input]) => {
      if (input === undefined || input === null || input === false) return;
      let current = true;
      setLoading(true);
      setError(undefined);
      // Started after the effect returns: the loader reads current settings
      // imperatively, outside the reactive system.
      Promise.resolve(input).then(load).then(
        result => {
          if (!current) return;
          setValue(() => result);
          setLoading(false);
        },
        failure => {
          if (!current) return;
          setValue(undefined);
          setError(() => failure ?? new Error('failed'));
          setLoading(false);
        },
      );
      return () => {
        current = false;
      };
    },
  );

  const loaded = (() => value()) as Loaded<T>;
  loaded.loading = loading;
  loaded.error = error;
  loaded.refetch = () => setAttempt(count => count + 1);
  loaded.mutate = update => setValue(current => update(current));
  return loaded;
}
