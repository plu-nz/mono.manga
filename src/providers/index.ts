import type { MangaProvider, ProviderId } from '../core/types';
import { createMangaDexProvider } from './mangadex';
import { localProvider } from './local';

const providers: Record<ProviderId, MangaProvider> = {
  mangadex: createMangaDexProvider(),
  local: localProvider,
};

export function getProvider(id: ProviderId): MangaProvider {
  const provider = providers[id];
  if (!provider) throw Object.assign(new Error(`Unknown provider ${id}`), { code: 'not_found' });
  return provider;
}

/** Providers that can search a catalog, in display order. */
export function searchableProviders(): MangaProvider[] {
  return Object.values(providers).filter(provider => provider.capabilities.search);
}

export function isProviderId(value: string): value is ProviderId {
  return value in providers;
}
