# Social Credit

*Bureau of Civic Standing · Est. 2026*

A satirical website where friends rate each other. You commend people for merits ("Brought snacks", +20) and report infractions ("Hit reply-all", −15). Each citizen's photo becomes a **3D Gaussian-splat portrait** you can orbit, and their standing changes how the site treats them.

One citizen is beyond reproach: **The Creator**, whose score is permanently ∞.

## Features

- **Photo → 3D Gaussian splat.** Everything runs in the browser, in four steps:
  1. MediaPipe Face Landmarker finds 478 3D facial landmarks.
  2. MediaPipe Selfie Segmenter separates the person from the background.
  3. A depth map is estimated: the canonical face mesh where the face is, a fitted head ellipsoid for hair and ears, and a curved torso for neck and shoulders, all blended so they meet smoothly.
  4. About 75,000 anisotropic 3D gaussians are placed on that surface. They are dense on the face and coarser elsewhere, and each one is shaped from the surface's own tangents so they tile without gaps from any angle.
- **The renderer.** It is WebGL2 EWA splatting, the projection used by 3D Gaussian Splatting: each gaussian's covariance is projected to a screen-space ellipse, depth-sorted with a 16-bit counting sort whenever the view turns, and alpha-composited.
- **Download `.splat`.** Every portrait can be downloaded as a standard 32-byte-per-splat `.splat` file that other Gaussian-splat viewers can open.
- **Webcam or upload.** You can take a selfie or drop in a photo. Only the cropped portrait, the landmarks, the person mask and an avatar thumbnail (about 130 KB in total) are uploaded. Splats are rebuilt deterministically in each visitor's browser.
- **Standing is visible.** Exemplary Citizens get a gold seal beside their name. A Persona Non Grata's portrait is shown in grayscale.
- **Live feed and registry.** Rankings, 24-hour deltas, a score-history sparkline, and an official record of every change.

## What happens with good or bad credit

Everyone starts at **1,000**. Your tier decides how much *your* opinion is worth and how pleasant the site is for you.

| Tier | Score | Rating weight | Ratings/day | What it does |
|---|---|---|---|---|
| ∞ **The Creator** | ∞ | ×3 | unlimited | Score fixed. Criticism bounces back onto the critic at 2×. Praise earns the praiser +5. Can issue site-wide decrees and grant amnesty. |
| **AAA** Exemplary Citizen | 1300+ | ×2 | 30 | Gold seal beside your name. Anyone who reports you pays a −5 *envy tax*. |
| **AA** Model Citizen | 1150–1299 | ×1.5 | 20 | |
| **A** Good Standing | 1000–1149 | ×1 | 12 | |
| **B** Under Observation | 850–999 | ×0.75 | 8 | A small eye follows your cursor around the site. |
| **C** Cause for Concern | 600–849 | ×0.5 | 5 | Your portrait fades toward grayscale. The site turns grayscale for you. Pages "load slower" (bandwidth reallocated to better citizens). |
| **D** Persona Non Grata | 0–599 | ×0.25 | 3 | You may only praise, never criticise. Anyone who praises you pays a −5 *fraternization fee*. Your portrait is shown in grayscale. The site is set in Comic Sans. |

Other rules:

- **Re-education.** Citizens below 1,000 can take a three-question loyalty quiz every 12 hours. All three correct earns +40. ("The Bureau's algorithm is best described as: *Flawless*.")
- **Cooling off.** You can rate the same person once every 30 minutes. Self-rating is not allowed.
- **Declining to submit a portrait** costs −50.

All the rules live in [`lib/rules.js`](lib/rules.js). Change the numbers, add merits and infractions, or write new quiz questions there.

## Who becomes The Creator

The **first account to enroll** becomes The Creator. To reserve the title before going public, set `CREATOR_USERNAME`:

```bash
CREATOR_USERNAME=yourname bun start
```

## Run it

Requires [Bun](https://bun.sh) 1.2.3 or newer (`curl -fsSL https://bun.sh/install | bash`). There is no framework: the server is plain `Bun.serve`, and the only dependencies are Three.js and MediaPipe.

```bash
bun install     # also downloads the two MediaPipe models (~4 MB) into models/ (optional; falls back to Google's CDN)
bun start       # http://localhost (port 80)
bun run dev     # same, restarting on file changes
```

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `80` | HTTP port |
| `DATA_DIR` | `./data` | Where the JSON database and uploaded portraits live |
| `CREATOR_USERNAME` | (unset) | Reserve The Creator title for this username |
| `TRUST_PROXY` | (unset) | Set when running behind a reverse proxy / HTTPS terminator, so cookies get `Secure` |

Port 80 is a privileged port on Linux, so either run `sudo bun start`, or allow Bun to bind it once with `sudo setcap 'cap_net_bind_service=+ep' "$(command -v bun)"`. macOS and Windows allow it without extra steps. To use another port: `PORT=3000 bun start`.

The webcam only works on `https://` or `localhost`. That's a browser rule.

## Design choices worth knowing

- **Opt-in only.** You can only upload *your own* face, during your own enrollment. Nobody can create a profile of someone else, so everyone on the registry chose to be there.
- **No free-text ratings.** Ratings come from a fixed catalogue of merits and infractions, which keeps the game funny rather than mean.
- **Every rating is attributed.** The feed shows who rated whom.

## How it's built

- `server.js`: `Bun.serve` routes for the API (accounts, ratings, re-education, decrees) and `Bun.file` static hosting
- `lib/rules.js`: tiers, weights, merits, infractions, quiz
- `lib/store.js`: a small JSON-file database with atomic writes, enough for a friend group. Swap in SQLite or Postgres if it grows.
- `lib/auth.js`: `Bun.password` (argon2id) hashing, session cookies, login rate limiting
- `public/js/splats.js`: portrait → depth map → Gaussian splats, plus `.splat` export
- `public/js/splat-viewer.js`: WebGL2 Gaussian-splat renderer (EWA projection, depth sorting)
- `public/js/scan.js`: MediaPipe landmarks and segmentation, portrait and avatar crops, webcam capture
- `public/js/face-topology.js`: generated by `bun run build:topology` from MediaPipe's canonical mesh
- `public/js/app.js`: hash router and views. No build step: ES modules plus an import map.

It's satire. Please don't build this for real.
