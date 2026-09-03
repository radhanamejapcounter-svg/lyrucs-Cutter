# HCJ Audio Cutter

A browser-based PWA that lets you play a video, mark timestamps, and export audio segments as MP3 files — all processed locally in your browser.

## Features

- Mark timestamps while a video plays (or press **Space**)
- Auto-creates clips from your marks
- Rename each clip with the `hcj_N.mp3` naming scheme
- Extract clips as MP3 using FFmpeg (runs in-browser, no server)
- Download individually or as a ZIP

## How to host on GitHub Pages

1. Upload all files in this folder to a GitHub repository
2. Go to **Settings → Pages**
3. Set source to **Deploy from a branch**, choose `main` (or `master`), root `/`
4. Click **Save** — your app will be live at `https://<username>.github.io/<repo>/`

> **Important:** The `.nojekyll` file is required so GitHub Pages doesn't interfere with the `_` files used by FFmpeg.

## Usage

1. Open the app and drop or browse for a video file (MP4, MKV, MOV, etc.)
2. Click **Play** and then click **Mark** (or press **Space**) at each cut point
3. A list of clips appears on the right — rename each with the number you want (e.g. `1` → `hcj_1.mp3`)
4. Click **Extract MP3** to process selected clips
5. Click **⬇** next to a clip or **Download Selected** to save (multiple = ZIP)

## Notes

- Large files (200 MB+) are supported — everything is processed locally
- First load downloads ~5 MB of FFmpeg WebAssembly (cached after that)
- Works offline after first visit (PWA)
