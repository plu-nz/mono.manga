# google

Optional Google integrations, run entirely in the browser (no backend holds
tokens). The app works fully without signing in.

- `auth.ts` — Google Identity Services token model: `connect`, `getAccessToken`,
  `authorizedFetch`, `disconnect`, observable `getGoogleState` /
  `subscribeGoogleState`. Client id from `VITE_GOOGLE_CLIENT_ID`.
- `drive.ts` — JSON files in the hidden Drive `appDataFolder` (scope
  `drive.appdata`) and the `DriveStore` used by `src/sync`.
- `gmail.ts` — builds a MIME message with one attachment and sends it from the
  user's own account through a resumable upload (scope `gmail.send`).
- `errors.ts` — `GoogleError` with a `code` the UI translates.

## Scopes

Requested progressively with `include_granted_scopes: true`: `identity`
(`openid email`) always, plus `drive` and/or `gmail` when a feature needs it.

## Token storage

`localStorage` keeps `{ connected, email, grantedScopes }` (no token).
The access token stays in memory and in `sessionStorage` with its expiry, so a
reload in the same tab skips the popup. Any script on the origin could read it
during its lifetime; that is the accepted trade-off of having no backend.

## Known limitations

- The GIS token model has **no refresh tokens**. Access tokens last about one
  hour. Background renewal uses `prompt: 'none'`, which still needs a popup
  window and fails when the browser blocks it, the Google session expired, or
  third-party cookies are restricted. Failures surface as
  `GoogleError('interaction_required')`.
- Popups in installed iOS PWAs (standalone mode) can open in a separate
  context or fail to return. The UI must always offer a visible **Reconnect**
  action when `interaction_required` occurs; reconnecting calls `connect(...)`
  from a click.
- Popups only open reliably when `requestAccessToken` runs synchronously in
  the click handler. Call `preloadGoogle()` when a screen that may connect
  renders, and call `connect` / `getAccessToken({ interactive: true })` before
  any `await` in the handler.
- `disconnect()` revokes the grant only while a token is cached; otherwise it
  clears local state and the user can remove access at
  <https://myaccount.google.com/permissions>.
- Gmail `messages.send` accepts up to 35 MiB per message (discovery document
  `maxSize: 36700160`) after base64, so the raw attachment limit is about
  26.7 MB (`maxAttachmentBytes()`). Failed uploads are not resumed; retry the send.
