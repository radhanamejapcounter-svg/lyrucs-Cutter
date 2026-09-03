# Native FFmpeg cutting — setup

What this removes: the JS-side `decodeAudioData` + `lamejs` step, which loads
the *entire* source file into raw PCM in browser memory. That's what caps
your practical duration around ~28 min on-device. The native path below cuts
FFmpeg directly on the file on disk — the limit becomes disk space, not RAM.

Web/PWA build (`radharadharadha.vercel.app`) is untouched — `native-bridge.js`
detects `Capacitor.isNativePlatform()` and no-ops there, so the existing
decode/lamejs path still runs in the browser exactly as before.

## 1. Files in this package

```
Lyrics-Cutter-main/         ← already-patched web source (app.js, index.html,
                                native-bridge.js) — this is your new www/
native-plugin/
  FfmpegCutterPlugin.java   ← the native Android plugin
  MainActivity_snippet.java← 2 lines to add to your MainActivity
```

`apply_native_ffmpeg.py` is included inside `Lyrics-Cutter-main/` too, in
case you pull a fresh copy of the original repo later and want to re-apply
these changes — it's idempotent and makes `.bak` files, same convention as
your other `apply_*.py` scripts.

## 2. Scaffold the Capacitor project (do this in Codespaces — needs network)

```bash
npm init -y
npm install @capacitor/core @capacitor/android
npm install @capacitor/filesystem @capawesome/capacitor-file-picker
npx cap init "Lyrics Cutter" "com.lyricscutter.app" --web-dir=www
mkdir www && cp -r Lyrics-Cutter-main/* www/
npx cap add android
```

## 3. Wire in the native plugin

```bash
mkdir -p android/app/src/main/java/com/lyricscutter/ffmpeg
cp native-plugin/FfmpegCutterPlugin.java android/app/src/main/java/com/lyricscutter/ffmpeg/
```

Edit `android/app/src/main/java/.../MainActivity.java` per
`native-plugin/MainActivity_snippet.java` — add the import and the
`registerPlugin(FfmpegCutterPlugin.class);` call before `super.onCreate()`.

Add the FFmpeg-Kit dependency to `android/app/build.gradle` (audio-only
variant — much smaller APK than the full build, which is all you need here):

```gradle
dependencies {
    implementation 'com.arthenica:ffmpeg-kit-audio:6.0-2'
    // ...existing deps
}
```

## 4. Build (same pipeline you already use)

```bash
npx cap sync android
cd android && ./gradlew assembleRelease
cp app/build/outputs/apk/release/app-release.apk /tmp/LyricsCutter.apk
```

## 5. What changed in the JS

- `native-bridge.js` (new file): only active inside Capacitor. Uses the
  native file picker (`@capawesome/capacitor-file-picker`, `readData: false`
  so it never reads bytes into JS) to get a real on-device path, and
  `Capacitor.convertFileSrc()` to stream that path into the existing
  `<video>`/`<audio>` element — your marking/timeline UI needs zero changes,
  it already just reads `mediaEl.duration`/`currentTime`.
- `app.js`: patched (marked `/* native-ffmpeg-patch */`) to route file
  loading and the Extract step through `NativeBridge` when running natively;
  falls through to the original code on web.
- Extract, on native, calls the `FfmpegCutter.cut` plugin per clip — FFmpeg
  seeks/trims/encodes directly from the source file on disk, so nothing
  proportional to the *source* file's duration ever touches JS memory. Each
  output clip (small) is read back as a blob for playback/download, same as
  before.

## Known limits after this change

- Duration cap becomes effectively device storage, not RAM.
- `readFile`/base64 round-trip is still used for the small *output* clips —
  fine at clip-length scale (seconds to a few minutes), not source-file scale.
- If you ever want to skip even that round-trip, `Filesystem` can also just
  hand back a `file://` URI directly for playback instead of reading bytes —
  worth doing later if you add a "preview clip before download" feature.
