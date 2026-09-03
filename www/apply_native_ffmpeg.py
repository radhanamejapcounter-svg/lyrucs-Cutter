#!/usr/bin/env python3
"""
apply_native_ffmpeg.py
Patches app.js + index.html to use the native FfmpegCutter plugin when
running inside Capacitor (Android), falling back to the existing
decodeAudioData/lamejs path on plain web/PWA. Idempotent — safe to re-run.

Usage:
    python3 apply_native_ffmpeg.py            # patches ./app.js and ./index.html
    python3 apply_native_ffmpeg.py --www      # also patches ./www/app.js, ./www/index.html

Matches the project convention: makes .bak backups, patches root + www/ copy.
"""
import re
import shutil
import sys
from pathlib import Path

MARK = "/* native-ffmpeg-patch */"

APP_JS_STATE_ANCHOR = "let decodedAudioBuffer = null;"
APP_JS_STATE_ADD = f"""let decodedAudioBuffer = null;
let nativeFileMeta = null; // {{path,name,size,url}} set when loaded via NativeBridge.pickFile() {MARK}"""

LOAD_ANCHOR = "dropZone.addEventListener('click', () => fileInput.click());"
LOAD_ADD = f"""{MARK}
dropZone.addEventListener('click', () => {{
  if (window.NativeBridge && window.NativeBridge.isNative) {{
    window.NativeBridge.pickFile().then(loadNativeFile).catch(err => {{
      toast('Pick failed: ' + (err && err.message ? err.message : err), 'error');
    }});
  }} else {{
    fileInput.click();
  }}
}});

// Mirrors loadVideoFile()'s UI setup but skips the JS File object entirely —
// mediaEl streams straight from the on-device path via Capacitor.convertFileSrc.
function loadNativeFile(meta) {{
  nativeFileMeta = meta;
  mainFile = null;
  decodedAudioBuffer = null;
  marks = [];
  markHistory = [];
  clips = [];
  syncUndoBtn();
  renderMarks();
  renderClips();

  const audioOnly = /\\.(mp3|wav|m4a|aac|ogg|flac|wma)$/i.test(meta.name);
  if (audioOnly) {{
    mediaEl = audioPlayer;
    video.removeAttribute('src');
    video.style.display = 'none';
    audioShell.style.display = 'flex';
    audioPlayer.src = meta.url;
    audioPlayer.load();
  }} else {{
    mediaEl = video;
    audioPlayer.removeAttribute('src');
    audioShell.style.display = 'none';
    video.style.display = '';
    video.src = meta.url;
    video.load();
  }}

  dropZone.style.display = 'none';
  videoWrapper.style.display = 'flex';
  timelineSection.style.display = 'block';
  btnProcess.disabled = true;

  toast(`Loaded: ${{meta.name}} (${{(meta.size / 1024 / 1024).toFixed(1)}} MB)`, 'success');
  setStatus('Media loaded — play and click Mark to add timestamps');
}}
{MARK}
{LOAD_ANCHOR}"""

PROCESS_ANCHOR = "btnProcess.addEventListener('click', async () => {\n  if (!mainFile && !clips.some(c => c.file)) return;"
PROCESS_ADD = f"""btnProcess.addEventListener('click', async () => {{
  if (!mainFile && !nativeFileMeta && !clips.some(c => c.file)) return;

  {MARK}
  if (window.NativeBridge && window.NativeBridge.isNative && nativeFileMeta) {{
    const toProcessNative = clips.filter(c => c.selected);
    if (toProcessNative.length === 0) {{ toast('No clips selected', 'info'); return; }}
    btnProcess.disabled = true;
    btnDownloadAll.disabled = true;
    try {{
      for (let i = 0; i < toProcessNative.length; i++) {{
        const c = toProcessNative[i];
        setStatus(`Encoding clip ${{i + 1}}/${{toProcessNative.length}}: ${{prefix()}}_${{c.name}}.mp3…`, i / toProcessNative.length);
        await yieldToUI();
        const url = await window.NativeBridge.cutClip(c.start, c.end, c.name);
        if (c.url) URL.revokeObjectURL(c.url);
        c.url = url;
        c.blob = null; // native path already wrote the file; url is enough for playback/download
      }}
      renderClips();
      setStatus(`✓ ${{toProcessNative.length}} clip${{toProcessNative.length !== 1 ? 's' : ''}} extracted`);
      toast(`Done! ${{toProcessNative.length}} MP3 file${{toProcessNative.length !== 1 ? 's' : ''}} ready`, 'success');
    }} catch (err) {{
      const detail = (err && err.name ? `${{err.name}}: ` : '') + (err && err.message ? err.message : String(err));
      setStatus('Error: ' + detail);
      toast('Failed: ' + detail, 'error', 8000);
      console.error(err);
    }} finally {{
      btnProcess.disabled = false;
      btnDownloadAll.disabled = false;
    }}
    return;
  }}
  {MARK}
"""

INDEX_HEAD_ANCHOR = '<script type="module" src="app.js"></script>'
INDEX_HEAD_ADD = f'<!-- {MARK} --><script src="native-bridge.js"></script>\n<script type="module" src="app.js"></script>'


def patch_file(path: Path, anchor: str, replacement: str, label: str) -> bool:
    text = path.read_text(encoding="utf-8")
    if MARK in text and label not in ("state",):
        pass  # allow multiple checks below to still short circuit per-anchor
    if replacement.strip() in text or (MARK in text and anchor not in text):
        print(f"  [skip] {path.name}: {label} already patched")
        return False
    if anchor not in text:
        print(f"  [WARN] {path.name}: anchor not found for {label} — skipping (already patched differently, or file changed)")
        return False
    shutil.copy(path, path.with_suffix(path.suffix + ".bak"))
    text = text.replace(anchor, replacement, 1)
    path.write_text(text, encoding="utf-8")
    print(f"  [ok]   {path.name}: patched {label}")
    return True


def patch_app_js(app_js: Path):
    if not app_js.exists():
        print(f"  [WARN] {app_js} not found, skipping")
        return
    text = app_js.read_text(encoding="utf-8")
    if MARK in text:
        print(f"  [skip] {app_js}: already patched")
        return
    shutil.copy(app_js, app_js.with_suffix(".js.bak"))
    text = text.replace(APP_JS_STATE_ANCHOR, APP_JS_STATE_ADD, 1)
    text = text.replace(LOAD_ANCHOR, LOAD_ADD, 1)
    text = text.replace(
        "btnProcess.addEventListener('click', async () => {\n  if (!mainFile && !clips.some(c => c.file)) return;",
        PROCESS_ADD,
        1,
    )
    app_js.write_text(text, encoding="utf-8")
    print(f"  [ok]   {app_js}: patched (state, native picker, native extract branch)")


def patch_index_html(index_html: Path):
    if not index_html.exists():
        print(f"  [WARN] {index_html} not found, skipping")
        return
    patch_file(index_html, INDEX_HEAD_ANCHOR, INDEX_HEAD_ADD, "native-bridge.js script tag")


def main():
    targets = [Path(".")]
    if "--www" in sys.argv and Path("www").is_dir():
        targets.append(Path("www"))

    for base in targets:
        print(f"Patching in {base}/ ...")
        patch_app_js(base / "app.js")
        patch_index_html(base / "index.html")


if __name__ == "__main__":
    main()
