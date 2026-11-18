/**
 * Google Drive `appDataFolder`: a hidden per-app folder in the user's Drive,
 * invisible in the Drive UI and reachable only with the `drive.appdata`
 * scope. Used to store small JSON documents for synchronization.
 */
import { authorizedFetch } from './auth';
import { GoogleError, ensureOk } from './errors';

const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';

export interface AppDataFile {
  id: string;
  name: string;
  modifiedTime: string;
}

export interface DriveOptions {
  /** Allow a consent popup (only from a user gesture). Defaults to false. */
  interactive?: boolean;
}

/** Minimal store the sync engine needs. */
export interface DriveStore {
  read<T>(name: string): Promise<{ id: string; data: T } | null>;
  /** Writes `data` as JSON; updates `id` when given, otherwise creates. Returns the file id. */
  write(name: string, data: unknown, id?: string): Promise<string>;
}

function driveFetch(url: string, init: RequestInit, options: DriveOptions): Promise<Response> {
  return authorizedFetch(['drive'], url, init, { interactive: options.interactive ?? false });
}

/** Escapes a value for a Drive `q` string literal. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

async function listFiles(query: string | undefined, options: DriveOptions): Promise<AppDataFile[]> {
  const files: AppDataFile[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      spaces: 'appDataFolder',
      fields: 'nextPageToken,files(id,name,modifiedTime)',
      pageSize: '1000',
      // Oldest first: if two devices raced to create the same name, everyone converges on the first.
      orderBy: 'createdTime',
    });
    if (query) params.set('q', query);
    if (pageToken) params.set('pageToken', pageToken);
    const response = await ensureOk(await driveFetch(`${FILES_URL}?${params}`, {}, options), 'Drive list');
    const body = (await response.json()) as { nextPageToken?: string; files?: AppDataFile[] };
    files.push(...(body.files ?? []));
    pageToken = body.nextPageToken;
  } while (pageToken);
  return files;
}

export function listAppDataFiles(options: DriveOptions = {}): Promise<AppDataFile[]> {
  return listFiles('trashed = false', options);
}

async function findByName(name: string, options: DriveOptions): Promise<AppDataFile | null> {
  const files = await listFiles(`name = ${quote(name)} and trashed = false`, options);
  return files[0] ?? null;
}

async function downloadJson<T>(id: string, options: DriveOptions): Promise<T | null> {
  const response = await driveFetch(`${FILES_URL}/${encodeURIComponent(id)}?alt=media`, {}, options);
  if (response.status === 404) return null;
  await ensureOk(response, 'Drive download');
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new GoogleError('api', `Drive file ${id} is not valid JSON`, { cause: error });
  }
}

export async function readAppDataJson<T>(
  name: string,
  options: DriveOptions = {},
): Promise<{ id: string; data: T; modifiedTime: string } | null> {
  const file = await findByName(name, options);
  if (!file) return null;
  const data = await downloadJson<T>(file.id, options);
  return data === null ? null : { id: file.id, data, modifiedTime: file.modifiedTime };
}

function multipartBody(metadata: object, json: string): { body: Blob; contentType: string } {
  const boundary = `manga-${crypto.randomUUID()}`;
  const body = new Blob(
    [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${json}\r\n`,
      `--${boundary}--\r\n`,
    ],
    { type: `multipart/related; boundary=${boundary}` },
  );
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

async function createJson(name: string, json: string, options: DriveOptions): Promise<string> {
  const { body, contentType } = multipartBody({ name, parents: ['appDataFolder'], mimeType: 'application/json' }, json);
  const response = await ensureOk(
    await driveFetch(`${UPLOAD_URL}?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': contentType }, body }, options),
    'Drive create',
  );
  const created = (await response.json()) as { id?: string };
  if (!created.id) throw new GoogleError('api', 'Drive create returned no file id');
  return created.id;
}

/** Creates or updates `name` in appDataFolder. Returns the file id. */
export async function writeAppDataJson(name: string, data: unknown, existingId?: string, options: DriveOptions = {}): Promise<string> {
  const json = JSON.stringify(data);
  if (existingId) {
    const response = await driveFetch(
      `${UPLOAD_URL}/${encodeURIComponent(existingId)}?uploadType=media&fields=id`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: json },
      options,
    );
    // The file vanished (deleted from another device): recreate it.
    if (response.status !== 404) {
      await ensureOk(response, 'Drive update');
      return existingId;
    }
  }
  return createJson(name, json, options);
}

/** Deletes every file in appDataFolder ("delete synced data"). */
export async function deleteAppData(options: DriveOptions = {}): Promise<number> {
  const files = await listFiles(undefined, options);
  for (const file of files) {
    const response = await driveFetch(`${FILES_URL}/${encodeURIComponent(file.id)}`, { method: 'DELETE' }, options);
    if (response.status !== 404) await ensureOk(response, 'Drive delete');
  }
  return files.length;
}

/** Drive-backed store for the sync engine. Remembers file ids by name. */
export function createDriveStore(options: DriveOptions = {}): DriveStore {
  const ids = new Map<string, string>();
  return {
    async read<T>(name: string) {
      const known = ids.get(name);
      if (known) {
        const data = await downloadJson<T>(known, options);
        if (data !== null) return { id: known, data };
        ids.delete(name);
      }
      const found = await readAppDataJson<T>(name, options);
      if (found) ids.set(name, found.id);
      return found ? { id: found.id, data: found.data } : null;
    },
    async write(name, data, id) {
      const written = await writeAppDataJson(name, data, id ?? ids.get(name), options);
      ids.set(name, written);
      return written;
    },
  };
}
