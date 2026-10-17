# Header background loops

The header (`header_bg.js`) plays self-hosted native `<video>` loops from this folder.
Drop the encoded files here and they work — no code changes needed.

## Files the code expects

| Mood    | Desktop (required) | Mobile (optional) | Poster (optional) |
| ------- | ------------------ | ----------------- | ----------------- |
| Bullish | `bull.mp4`         | `bull-mobile.mp4`    | `bull.webp`       |
| Neutral | `neutral.mp4`      | `neutral-mobile.mp4` | `neutral.webp`    |
| Bearish | `bear.mp4`         | `bear-mobile.mp4`    | `bear.webp`       |

- Mobile viewports (?640px) load `*-mobile.mp4` if present, else fall back to the desktop file.
- If a clip is missing, the header shows the poster (or the gradient treatment) — it never blanks.
- `bull-*` covers tiers +1/+2/+3, `bear-*` covers ?1/?2/?3, `neutral` is the resting state.
  Per-tier zoom and ±3 speed-up are applied in CSS/JS — one clip per mood family is enough.

## 1. Download the source videos (yt-dlp)

```bash
# bull / neutral / bear sources currently used in prod
yt-dlp -f "bv*[height<=1080][ext=mp4]" -o "src-bull.%(ext)s"    "https://www.youtube.com/watch?v=EGEluEqnKks"
yt-dlp -f "bv*[height<=1080][ext=mp4]" -o "src-neutral.%(ext)s" "https://www.youtube.com/watch?v=m1YUmZRfgqU"
yt-dlp -f "bv*[height<=1080][ext=mp4]" -o "src-bear.%(ext)s"    "https://www.youtube.com/watch?v=vC-ZeUBqjaE"
```

`bv*` grabs video-only (no audio) — the header is muted, so we don't need an audio track.

## 2. Cut a clean section + make it seamless

A "seamless" loop just means the last frame flows into the first. Two reliable ways:

**A. Pick a naturally looping section** (best for abstract/flowing footage):

```bash
# grab ~8s starting at 00:00:05 — adjust -ss / -t per clip until it loops cleanly
ffmpeg -ss 00:00:05 -t 8 -i src-bull.mp4 -an -c:v libx264 -crf 20 cut-bull.mp4
```

**B. Crossfade the end back into the start** (forces any clip to loop):

```bash
# 1s crossfade between the clip and itself, trimmed to hide the seam
ffmpeg -i cut-bull.mp4 -filter_complex \
 "[0]split[a][b];[a]trim=0:7,setpts=PTS-STARTPTS[main];\
  [b]trim=7:8,setpts=PTS-STARTPTS[tail];\
  [main][tail]xfade=transition=fade:duration=1:offset=6" \
 -an -c:v libx264 -crf 20 loop-bull.mp4
```

## 3. Encode the web-ready desktop file

```bash
ffmpeg -i loop-bull.mp4 -an \
  -vf "scale=1280:-2:flags=lanczos,fps=30" \
  -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 23 \
  -movflags +faststart -g 60 \
  bull.mp4
```

- `-movflags +faststart` puts the index up front so it starts instantly.
- `-pix_fmt yuv420p` is required for Safari/iOS.
- Keep desktop files ~1–3 MB. Repeat for `neutral.mp4` and `bear.mp4`.

## 4. (Optional) Mobile variant — smaller + cheaper

```bash
ffmpeg -i loop-bull.mp4 -an \
  -vf "scale=720:-2:flags=lanczos,fps=30" \
  -c:v libx264 -pix_fmt yuv420p -crf 26 -movflags +faststart -g 60 \
  bull-mobile.mp4
```

## 5. (Optional) Poster frame — shown before/while the loop loads

```bash
ffmpeg -i bull.mp4 -frames:v 1 -q:v 2 bull-frame.png
cwebp -q 80 bull-frame.png -o bull.webp   # or: ffmpeg -i bull-frame.png bull.webp
```

## 6. (Optional) Mobile lite GIF — Chart row on phone

On mobile, the **Chart** snap row uses a lightweight GIF loop instead of full MP4 decode
(`RMHeaderBg.setMediaTier('lite')`). Generate once from each `*-mobile.mp4`:

```bash
# ~12 fps, 480px wide, palette-optimized; target <500 KB each
ffmpeg -i bull-mobile.mp4 -an \
  -vf "fps=12,scale=480:-2:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" \
  bull-lite.gif
```

Repeat for `neutral-lite.gif`, `bear-lite.gif`, and `extended-lite.gif`.
If a GIF is missing, the lite tier falls back to the static poster.

| Mood    | Lite GIF (mobile Chart row) |
| ------- | --------------------------- |
| Bullish | `bull-lite.gif`             |
| Neutral | `neutral-lite.gif`          |
| Bearish | `bear-lite.gif`             |
| Extended (pre/post snow) | `extended-lite.gif` |

## 6b. Mobile boot preload GIF

While the workspace boots on phone, the header shows a smaller neutral loop + static logo,
then resolves to the static `*.webp` poster for the live mood family.

```bash
ffmpeg -i neutral-mobile.mp4 -t 6 -an \
  -vf "fps=8,scale=240:-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4" \
  neutral-preload.gif
```

Or run `generate_lite_gifs.ps1` (includes `neutral-preload.gif`). Fallback chain in app:
`neutral-preload.gif` → `neutral-lite.gif` → `neutral.webp`.

## 7. Commit

```bash
git add tools/rm_report/morning_app/assets/header/*.mp4 tools/rm_report/morning_app/assets/header/*.webp tools/rm_report/morning_app/assets/header/*-lite.gif
git commit -m "feat(morning): add self-hosted header loop clips"
```

> Note: the GitHub Pages deploy mirror lives in `docs/morning/assets/header/`.
> The build/sync step copies this folder; if you deploy manually, copy the same files there too.
