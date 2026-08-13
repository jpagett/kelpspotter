# Saving session state to a Google login — a sketch

**Status: not built. A design sketch only.** This maps out what it would take to
let a signed-in Google user carry their POIs, paths, and settings across devices
and browsers, instead of the current per-browser `localStorage`. Nothing here is
wired up yet.

## What we already have to build on

The hard parts are done. Two seams make this small:

- **State is already one serialisable object.** `Session.snapshot()`
  (`js/session.js`) returns `{ pois, paths, view, user }` — the exact JSON the
  export-to-file feature writes. That is the payload to store remotely, verbatim.
- **Merging two states is already solved.** `Session.parse` → `Session.diff` →
  `Session.apply` (`js/session.js`) exist precisely because import has to
  reconcile someone else's file with the working set, matching records by a
  content hash (`poiUid`/`pathUid`), not by session-local ids. A remote session
  from another device is the *same problem* — it is just a file that came over
  the wire instead of through a file picker.
- **A save trigger already exists.** `persistNow()` (`js/app.js`) is the one
  debounced writer that fires on the tail of any interaction and writes
  `localStorage`. A remote push hooks in right beside it.
- **Google sign-in is already on the page.** `accounts.google.com/gsi/client`
  loads in `index.html`, and `CLIENT_ID` is set in `config.js` for Earth Engine.

So the work is: an identity, a place to put the bytes, and a sync policy. The
data model and the merge engine are reused as-is.

## Decision 1 — identity: decouple it from Earth Engine

Earth Engine sign-in (`connectEE` → `KelpEngine.login`) is a heavy, rarely-taken
path: it mints an EE-scoped OAuth token, and most visitors never touch it because
the public backend serves live imagery with no sign-in. "Save my stuff to Google"
must **not** ride on it — a diver who never signs into EE should still be able to
save.

So this is a *separate, lightweight* Google sign-in whose only job is to name the
user and authorise the store. Use GIS directly:

```js
const tokenClient = google.accounts.oauth2.initTokenClient({
  client_id: cfg.CLIENT_ID,
  scope: 'https://www.googleapis.com/auth/drive.appdata',   // see Decision 2
  callback: (resp) => { /* resp.access_token → read/write the store */ },
});
```

The Connect button stays EE-only. A new, separate "Sign in to sync" affordance
(header menu, or the ⚙ settings list next to Export/Import session) drives this.

## Decision 2 — where the bytes live

| Option | Backend needed? | Extra OAuth scope | Notes |
|---|---|---|---|
| **Google Drive `appDataFolder`** | **no** | `drive.appdata` (narrow: app's own hidden folder only, cannot see the user's files) | One JSON file per user, written straight from the browser. Recommended. |
| Firestore / datastore via the existing Cloud Run `api` | yes | none extra (verify the ID token server-side) | More control, server-side merge, but a new service surface, cost, and a schema to own. |
| Google Sheets / Docs | no | broad, scary scopes | Wrong tool. Rejected. |

**Recommended: Drive `appDataFolder`.** It needs no new backend, the scope is the
least alarming Google offers (the consent screen says the app can only touch data
it created), and it matches the app's zero-backend-for-the-common-path ethos. The
whole store is one file, e.g. `kelpspotter-session.json`, holding a
`Session.snapshot()`.

Reads and writes are two REST calls with the access token:

- find/create the file: `GET drive/v3/files?spaces=appDataFolder`
- read: `GET drive/v3/files/{id}?alt=media`
- write: `PATCH upload/drive/v3/files/{id}?uploadType=media`

## Decision 3 — sync policy: local is the source of truth, Drive is a mirror

The app is offline-first (`sw.js` caches the shell; everything works with no
network). Remote sync must never be load-bearing. So:

- **On sign-in / boot (if already signed in):** pull the remote snapshot, run it
  through `Session.diff` against the live state, and apply. Two sub-options:
  - *Silent last-write-wins by timestamp* — simplest; the newer `exported`
    stamp wins wholesale. Fine for a single user on two devices.
  - *Show the existing import review sheet* (`SessionUI`) when the diff is
    non-empty — reuses the whole merge UI for free, and never surprises the user
    by dropping a path. **Preferred**, because the merge machinery already draws
    that sheet.
- **On change:** in `persistNow()`, after the `localStorage` writes, schedule a
  debounced push of `Session.snapshot()` to Drive (a longer debounce than the
  500 ms local one — say 3–5 s — to batch bursts and spare quota). Guard it
  behind "signed in and online"; a failed push is logged to the Activity panel
  and retried on the next change, never thrown.
- **Conflict across devices:** stamp each snapshot with `exported` (already
  present) plus a monotonic device-local revision. On push, if the remote stamp
  is newer than the base we pulled, re-pull and re-diff before writing — the same
  reconcile path as boot, not a blind overwrite.

## What the user sees

1. A "Sign in to sync" item appears (settings menu). Signing in shows Google's
   consent screen once (the narrow `drive.appdata` scope).
2. After that, POIs/paths/settings silently follow them to any browser where they
   sign in. First sign-in on a device with existing local work shows the import
   review sheet so nothing is clobbered.
3. Signing out stops syncing; local `localStorage` keeps working exactly as today.
4. "Clear persistent data" gains a companion "Forget synced copy" (delete the
   Drive file) — otherwise a clear-then-reload just re-pulls the cloud copy.

## Open questions / liabilities

- **Token lifetime.** GIS access tokens are short-lived (~1 h) and there is no
  refresh token in the browser implicit flow. Re-consent is silent while the
  Google session is alive, but a push can fail mid-session on an expired token —
  it must re-request quietly and retry, not error at the user.
- **One file vs. per-collection files.** One file is simplest and matches the
  export format. If POI lists ever get large (thousands of imported placemarks),
  splitting paths and POIs into separate Drive files would cut write size.
- **Multi-tab.** Two tabs of the same user racing pushes — the revision check in
  Decision 3 handles it, but it is worth a test.
- **Scope creep into a real backend.** If server-side merge, sharing between
  users, or audit history is ever wanted, the Drive approach caps out and the
  Firestore option (Decision 2) becomes the answer. Start with Drive; it is
  reversible.

## Smallest first step

Behind an off-by-default flag: a "Sign in to sync" action that (1) gets a
`drive.appdata` token, (2) on success pushes `Session.snapshot()` to a single
Drive file, and (3) on boot, if signed in, pulls that file and runs it through the
existing `SessionUI` review sheet. That is a few dozen lines against seams that
already exist, and it proves the round trip before any policy is hardened.
