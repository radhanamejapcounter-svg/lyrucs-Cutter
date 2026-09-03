// native-bridge.js
// Loaded only inside the Capacitor (Android) shell. On plain web/PWA,
// window.Capacitor is undefined, so NativeBridge.isNative stays false and
// app.js's existing decodeAudioData/lamejs path runs unchanged — this file
// changes nothing about the browser build.
//
// Requires (npm):
//   @capacitor/core
//   @capacitor/filesystem
//   @capawesome/capacitor-file-picker
//
// Include this <script> in index.html BEFORE app.js.

(function () {
  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

  const NativeBridge = { isNative, inputPath: null };

  if (isNative) {
    const { FilePicker } = window.CapawesomeCapacitorFilePicker || {};
    const { Filesystem, Directory } = window.CapacitorFilesystem || {};
    const FfmpegCutter = window.Capacitor.Plugins.FfmpegCutter;

    // Opens the native file picker, returns a real on-device path.
    // No bytes are read into JS here — that's the whole point.
    NativeBridge.pickFile = async function () {
      const result = await FilePicker.pickFiles({
        types: [
          'video/*', 'audio/*',
          'video/mp4', 'video/x-matroska', 'video/quicktime', 'video/x-msvideo', 'video/webm',
          'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/aac', 'audio/ogg', 'audio/flac'
        ],
        multiple: false,
        readData: false // critical: do NOT base64 the whole file into JS memory
      });
      const file = result.files && result.files[0];
      if (!file || !file.path) throw new Error('No file path returned by picker');

      NativeBridge.inputPath = file.path;
      // convertFileSrc gives a WebView-loadable URL that streams from disk —
      // the <video>/<audio> element reads it natively, same as it already
      // does for blob: URLs, so marking/timeline code needs zero changes.
      const streamUrl = window.Capacitor.convertFileSrc(file.path);
      return { path: file.path, name: file.name, size: file.size, url: streamUrl };
    };

    // Cuts one clip natively via FFmpeg-Kit. Returns a blob: URL so the rest
    // of app.js (renderClips, download links, etc.) works exactly as before.
    NativeBridge.cutClip = async function (startSec, endSec, outName) {
      if (!NativeBridge.inputPath) throw new Error('No native input file loaded');

      const outputPath = `${Directory.Cache}/${outName}-${Date.now()}.mp3`;
      // Filesystem plugin wants a relative path + directory enum; ask it for
      // the real absolute path first so we can hand FFmpeg a plain path.
      const uriResult = await Filesystem.getUri({
        directory: Directory.Cache,
        path: `${outName}-${Date.now()}.mp3`
      });
      const absoluteOutPath = uriResult.uri.replace('file://', '');

      const res = await FfmpegCutter.cut({
        inputPath: NativeBridge.inputPath,
        outputPath: absoluteOutPath,
        startSec,
        endSec
      });

      // Clip output files are small (a few MB at most) — reading just this
      // one back as base64 is fine; it's the multi-GB *source* file we're
      // avoiding, not this.
      const read = await Filesystem.readFile({ path: res.outputPath });
      const byteChars = atob(read.data);
      const bytes = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'audio/mpeg' });
      return URL.createObjectURL(blob);
    };
  }

  window.NativeBridge = NativeBridge;
})();
