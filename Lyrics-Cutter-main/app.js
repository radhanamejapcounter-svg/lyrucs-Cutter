// ─── State ───────────────────────────────────────────────────────────────────
let mainFile = null;    // the loaded video OR audio file (marking system applies to this)
let videoDuration = 0;  // duration of mainFile, whichever kind it is
let marks = [];
let markHistory = [];   // stack of timestamps for undo
let clips = [];
let decodedAudioBuffer = null;
let nativeFileMeta = null; // {path,name,size,url} set when loaded via NativeBridge.pickFile() /* native-ffmpeg-patch */

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const dropZone        = document.getElementById('drop-zone');
const fileInput       = document.getElementById('file-input');
const importZone      = document.getElementById('import-zone');
const importInput     = document.getElementById('import-input');
const prefixInput     = document.getElementById('prefix-input');
const videoWrapper    = document.getElementById('video-wrapper');
const video           = document.getElementById('video');
const audioShell      = document.getElementById('audio-player-shell');
const audioPlayer     = document.getElementById('audio-player');
let   mediaEl         = video; // whichever of video/audioPlayer is currently active
const timelineSection = document.getElementById('timeline-section');
const timelineBar     = document.getElementById('timeline-bar');
const timelineProgress= document.getElementById('timeline-progress');
const marksList       = document.getElementById('marks-list');
const clipsList       = document.getElementById('clips-list');
const btnMark         = document.getElementById('btn-mark');
const btnUndo         = document.getElementById('btn-undo');
const btnPlay         = document.getElementById('btn-play');
const btnClearMarks   = document.getElementById('btn-clear-marks');
const btnProcess      = document.getElementById('btn-process');
const btnDownloadAll  = document.getElementById('btn-download-all');
const btnSelectAll    = document.getElementById('btn-select-all');
const timeDisplay     = document.getElementById('time-display');
const statusText      = document.getElementById('status-text');
const progressWrap    = document.getElementById('progress-wrap');
const progressFill    = document.getElementById('progress-fill');
const procLoading     = document.getElementById('proc-loading');
const procLoadText    = document.getElementById('proc-load-text');
const toastContainer  = document.getElementById('toast-container');

// ─── Utils ────────────────────────────────────────────────────────────────────
function fmt(s, decimals = 0) {
  if (!isFinite(s)) return '0:00';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const secStr = decimals > 0
    ? sec.toFixed(decimals).padStart(4 + decimals, '0')
    : String(Math.floor(sec)).padStart(2, '0');
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${secStr}`
    : `${m}:${secStr}`;
}

function fmtDur(s) {
  if (s < 60) return `${s.toFixed(1)}s`;
  return fmt(s);
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function uid() { return Math.random().toString(36).slice(2, 9); }

const VIDEO_EXT = /\.(mp4|mkv|mov|avi|webm|m4v|3gp|ts)$/i;
const AUDIO_EXT  = /\.(mp3|m4a|wav|aac|ogg|flac|wma)$/i;

// Some phone/instagram-saved files report an empty or generic MIME type
// (e.g. "application/octet-stream") instead of "video/mp4" — fall back to
// the file extension so those aren't silently rejected.
function isVideoFile(file) {
  return file.type.startsWith('video/') || (!file.type && VIDEO_EXT.test(file.name));
}
function isAudioFile(file) {
  return file.type.startsWith('audio/') || (!file.type && AUDIO_EXT.test(file.name));
}
function isMediaFile(file) {
  return isVideoFile(file) || isAudioFile(file) ||
    (file.type === 'application/octet-stream' && (VIDEO_EXT.test(file.name) || AUDIO_EXT.test(file.name)));
}

// ─── Pad (verse) number detection from filename ────────────────────────────────
const DEVANAGARI_DIGITS = '०१२३४५६७८९';
function devanagariToLatin(str) {
  return str.replace(/[०-९]/g, d => String(DEVANAGARI_DIGITS.indexOf(d)));
}

// Reads a verse number straight out of a filename like:
// "श्री हित चौरासी जी ❤️ पद ४.श्री हित हरिवंश ... .mp4" → 4
// Looks for a number right after "पद" (Devanagari or Latin digits) first,
// falling back to the first standalone number anywhere in the name.
function extractPadNumber(filename) {
  const nameOnly = filename.replace(/\.[a-zA-Z0-9]{2,4}$/, ''); // drop extension (avoids matching the "4" in ".mp4")
  let m = nameOnly.match(/पद[^0-9०-९]{0,12}([0-9०-९]+)/);
  if (!m) m = nameOnly.match(/([0-9०-९]+)/);
  if (!m) return null;
  const num = parseInt(devanagariToLatin(m[1]), 10);
  return isNaN(num) ? null : num;
}

function prefix() {
  const v = (prefixInput.value || '').trim().replace(/[^a-zA-Z0-9_]/g, '');
  return v || 'hcj';
}

function toast(msg, type = 'info', duration = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

function setStatus(msg, progress = null) {
  statusText.textContent = msg;
  if (progress !== null) {
    progressWrap.style.display = 'block';
    progressFill.style.width = `${Math.round(progress * 100)}%`;
  } else {
    progressWrap.style.display = 'none';
  }
}

function showOverlay(msg) {
  procLoadText.textContent = msg;
  procLoading.classList.add('show');
}

function hideOverlay() {
  procLoading.classList.remove('show');
}

// Surface otherwise-silent failures as an on-screen toast — there's no
// console to check on a phone/tablet, so this is the only way to see what
// went wrong when something breaks in the field.
window.addEventListener('error', e => {
  toast('Error: ' + (e.message || 'Unknown script error'), 'error', 8000);
});
window.addEventListener('unhandledrejection', e => {
  const reason = e.reason;
  const msg = reason && reason.message ? reason.message : String(reason);
  toast('Error: ' + msg, 'error', 8000);
});

// ─── File Loading ─────────────────────────────────────────────────────────────
// Handles both video files and audio-only files (mp3/wav/m4a/etc). Whichever
// kind is loaded, the same mark/timeline/cut system below operates on it —
// `mediaEl` just points at the <video> or <audio> element that's actually
// playing it.
function loadVideoFile(file) {
  if (!file || !isMediaFile(file)) {
    toast('Please select a valid video or audio file', 'error');
    return;
  }
  const audioOnly = isAudioFile(file) && !isVideoFile(file);

  mainFile = file;
  decodedAudioBuffer = null;
  marks = [];
  markHistory = [];
  clips = [];
  syncUndoBtn();
  renderMarks();
  renderClips();

  const url = URL.createObjectURL(file);

  if (audioOnly) {
    mediaEl = audioPlayer;
    video.removeAttribute('src');
    video.style.display = 'none';
    audioShell.style.display = 'flex';
    audioPlayer.src = url;
    audioPlayer.load();
  } else {
    mediaEl = video;
    audioPlayer.removeAttribute('src');
    audioShell.style.display = 'none';
    video.style.display = '';
    video.src = url;
    video.load();
  }

  dropZone.style.display = 'none';
  videoWrapper.style.display = 'flex';
  timelineSection.style.display = 'block';
  btnProcess.disabled = true;

  toast(`Loaded: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`, 'success');
  setStatus(`${audioOnly ? 'Audio' : 'Video'} loaded — play and click Mark to add timestamps`);
}

/* native-ffmpeg-patch */
dropZone.addEventListener('click', () => {
  if (window.NativeBridge && window.NativeBridge.isNative) {
    window.NativeBridge.pickFile().then(loadNativeFile).catch(err => {
      toast('Pick failed: ' + (err && err.message ? err.message : err), 'error');
    });
  } else {
    fileInput.click();
  }
});

// Mirrors loadVideoFile()'s UI setup but skips the JS File object entirely —
// mediaEl streams straight from the on-device path via Capacitor.convertFileSrc.
function loadNativeFile(meta) {
  nativeFileMeta = meta;
  mainFile = null;
  decodedAudioBuffer = null;
  marks = [];
  markHistory = [];
  clips = [];
  syncUndoBtn();
  renderMarks();
  renderClips();

  const audioOnly = /\.(mp3|wav|m4a|aac|ogg|flac|wma)$/i.test(meta.name);
  if (audioOnly) {
    mediaEl = audioPlayer;
    video.removeAttribute('src');
    video.style.display = 'none';
    audioShell.style.display = 'flex';
    audioPlayer.src = meta.url;
    audioPlayer.load();
  } else {
    mediaEl = video;
    audioPlayer.removeAttribute('src');
    audioShell.style.display = 'none';
    video.style.display = '';
    video.src = meta.url;
    video.load();
  }

  dropZone.style.display = 'none';
  videoWrapper.style.display = 'flex';
  timelineSection.style.display = 'block';
  btnProcess.disabled = true;

  toast(`Loaded: ${meta.name} (${(meta.size / 1024 / 1024).toFixed(1)} MB)`, 'success');
  setStatus('Media loaded — play and click Mark to add timestamps');
}
/* native-ffmpeg-patch */
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => loadVideoFile(e.target.files[0]));
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  loadVideoFile(e.dataTransfer.files[0]);
});

// ─── Import already-cut clips (one file per verse) ────────────────────────────
// Reads each file's own duration and appends it as a whole-file clip — no
// marking needed, since the file IS the verse already.
function loadFileDuration(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement(isAudioFile(file) ? 'audio' : 'video');
    el.preload = 'metadata';
    el.src = url;
    el.onloadedmetadata = () => { resolve(el.duration); URL.revokeObjectURL(url); };
    el.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read ' + file.name)); };
  });
}

async function addImportedClips(fileList) {
  const files = Array.from(fileList).filter(isMediaFile);
  if (files.length === 0) { toast('No video/audio files found', 'error'); return; }

  // Detect each file's pad (verse) number from its name up front, so both
  // the sort order and the auto-generated name can use it.
  const withPad = files.map(f => ({ file: f, pad: extractPadNumber(f.name) }));

  // Sort: files with a detected pad number go first, in numeric order;
  // anything undetected falls back to natural filename order at the end.
  withPad.sort((a, b) => {
    if (a.pad != null && b.pad != null) return a.pad - b.pad;
    if (a.pad != null) return -1;
    if (b.pad != null) return 1;
    return a.file.name.localeCompare(b.file.name, undefined, { numeric: true });
  });

  let nextIndex = clips.length ? Math.max(...clips.map(c => c.index)) + 1 : 1;
  let failed = 0;
  let detected = 0;

  for (const { file: f, pad } of withPad) {
    let dur = 0;
    try {
      dur = await loadFileDuration(f);
    } catch (e) {
      failed++;
      continue;
    }
    if (pad != null) detected++;
    clips.push({
      id: uid(),
      index: pad != null ? pad : nextIndex,
      start: 0,
      end: dur,
      file: f,
      name: pad != null ? String(pad) : String(nextIndex),
      // Lock detected pad numbers so the auto-cascade renumbering (used when
      // you manually rename a clip) doesn't overwrite a name read from file.
      locked: pad != null,
      padDetected: pad != null,
      blob: null,
      url: null,
      selected: true,
    });
    if (pad == null) nextIndex++;
  }

  timelineSection.style.display = 'none'; // marks don't apply to imported clips
  renderClips();
  btnProcess.disabled = clips.length === 0;
  const added = files.length - failed;
  setStatus(`${added} clip${added !== 1 ? 's' : ''} imported (${detected} pad number${detected !== 1 ? 's' : ''} auto-detected) — click "Extract MP3" to convert`);
  toast(`Imported ${added} clip${added !== 1 ? 's' : ''}${detected ? `, ${detected} pad number${detected !== 1 ? 's' : ''} detected` : ''}${failed ? `, ${failed} failed` : ''}`,
    failed ? 'info' : 'success');
}

importZone.addEventListener('click', () => importInput.click());
importInput.addEventListener('change', e => addImportedClips(e.target.files));
importZone.addEventListener('dragover', e => { e.preventDefault(); importZone.classList.add('dragover'); });
importZone.addEventListener('dragleave', () => importZone.classList.remove('dragover'));
importZone.addEventListener('drop', e => {
  e.preventDefault();
  importZone.classList.remove('dragover');
  addImportedClips(e.dataTransfer.files);
});

// ─── Media controls (shared by both <video> and <audio>) ─────────────────────
// Both elements get the same listeners; each handler checks that it's firing
// on whichever one is currently active (`mediaEl`) before touching shared state,
// so loading a new file — possibly of the other kind — can't leave stale
// listeners on an element nobody's looking at.
function bindMediaEvents(el) {
  el.addEventListener('loadedmetadata', () => {
    if (el !== mediaEl) return;
    videoDuration = el.duration;
    timeDisplay.textContent = `0:00.0 / ${fmt(videoDuration)}`;
  });

  el.addEventListener('timeupdate', () => {
    if (el !== mediaEl) return;
    updateTimeline();
    timeDisplay.textContent = `${fmt(el.currentTime, 1)} / ${fmt(videoDuration)}`;
  });

  el.addEventListener('play',  () => { if (el === mediaEl) btnPlay.textContent = '⏸ Pause'; });
  el.addEventListener('pause', () => { if (el === mediaEl) btnPlay.textContent = '▶ Play'; });
  el.addEventListener('ended', () => { if (el === mediaEl) btnPlay.textContent = '▶ Play'; });
}
bindMediaEvents(video);
bindMediaEvents(audioPlayer);

btnPlay.addEventListener('click', () => {
  if (mediaEl.paused) mediaEl.play(); else mediaEl.pause();
});

// ─── Timeline ────────────────────────────────────────────────────────────────
function updateTimeline() {
  if (!videoDuration) return;
  timelineProgress.style.width = ((mediaEl.currentTime / videoDuration) * 100) + '%';
  renderMarkerLines();
}

timelineBar.addEventListener('click', e => {
  if (!videoDuration) return;
  const rect = timelineBar.getBoundingClientRect();
  mediaEl.currentTime = ((e.clientX - rect.left) / rect.width) * videoDuration;
});

function renderMarkerLines() {
  timelineBar.querySelectorAll('.timeline-marker, .timeline-cursor').forEach(el => el.remove());

  const cursor = document.createElement('div');
  cursor.className = 'timeline-cursor';
  cursor.style.left = ((mediaEl.currentTime / videoDuration) * 100) + '%';
  timelineBar.appendChild(cursor);

  marks.forEach((t, i) => {
    const m = document.createElement('div');
    m.className = 'timeline-marker';
    m.dataset.index = i + 1;
    m.style.left = ((t / videoDuration) * 100) + '%';
    m.title = `Mark ${i + 1}: ${fmt(t, 2)}`;
    m.addEventListener('click', e => { e.stopPropagation(); mediaEl.currentTime = t; });
    timelineBar.appendChild(m);
  });
}

// ─── Marking ─────────────────────────────────────────────────────────────────
function syncUndoBtn() {
  btnUndo.disabled = markHistory.length === 0;
}

btnMark.addEventListener('click', () => {
  if (!mainFile) return;
  const t = parseFloat(mediaEl.currentTime.toFixed(3));
  if (marks.some(m => Math.abs(m - t) < 0.05)) { toast('Already marked near this time', 'info'); return; }
  marks.push(t);
  marks.sort((a, b) => a - b);
  markHistory.push(t);     // push to undo stack AFTER adding
  syncUndoBtn();
  renderMarks();
  rebuildClips();
  toast(`Mark ${marks.indexOf(t) + 1} at ${fmt(t, 2)}`, 'success');
});

btnUndo.addEventListener('click', undoLastMark);

function undoLastMark() {
  if (markHistory.length === 0) return;
  const last = markHistory.pop();
  const idx = marks.indexOf(last);
  if (idx !== -1) marks.splice(idx, 1);
  syncUndoBtn();
  renderMarks();
  rebuildClips();
  toast(`Undone mark at ${fmt(last, 2)}`, 'info');
}

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); btnMark.click(); }
  if (e.code === 'KeyP')  { if (mediaEl.paused) mediaEl.play(); else mediaEl.pause(); }
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); undoLastMark(); }
});

btnClearMarks.addEventListener('click', () => {
  marks = [];
  markHistory = [];
  syncUndoBtn();
  renderMarks();
  rebuildClips();
  toast('All marks cleared', 'info');
});

function renderMarks() {
  if (marks.length === 0) {
    marksList.innerHTML = '<span style="font-size:.78rem;color:var(--text-muted);font-style:italic;">No marks yet — play the video and click Mark</span>';
    return;
  }
  marksList.innerHTML = marks.map((t, i) => `
    <span class="mark-chip">
      <span onclick="seekTo(${t})">${i + 1}: ${fmt(t, 2)}</span>
      <span class="del" onclick="deleteMark(${i})">×</span>
    </span>
  `).join('');
}

window.seekTo = t => { mediaEl.currentTime = t; };
window.deleteMark = i => {
  const removed = marks[i];
  marks.splice(i, 1);
  // Remove from undo history too so it can't be "undone" back
  const hi = markHistory.lastIndexOf(removed);
  if (hi !== -1) markHistory.splice(hi, 1);
  syncUndoBtn();
  renderMarks();
  rebuildClips();
};

// ─── Clips ────────────────────────────────────────────────────────────────────
function rebuildClips() {
  // Imported (whole-file) clips aren't derived from marks — keep them as-is.
  const imported = clips.filter(c => c.file);
  const markBased = clips.filter(c => !c.file);

  // Preserve existing names & locked status by matching on position index
  const prevNames = {};
  markBased.forEach(c => { prevNames[c.index] = { name: c.name, locked: c.locked }; });
  markBased.forEach(c => { if (c.url) URL.revokeObjectURL(c.url); });

  if (!videoDuration || marks.length === 0) {
    clips = imported;
    renderClips();
    btnProcess.disabled = clips.length === 0;
    return;
  }

  const boundaries = [0, ...marks, videoDuration];
  const rebuilt = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end   = boundaries[i + 1];
    if (end - start < 0.05) continue;
    const prev = prevNames[i + 1];
    rebuilt.push({
      id:       uid(),
      index:    i + 1,
      start, end,
      name:     prev ? prev.name : String(i + 1),
      locked:   prev ? prev.locked : false,
      blob:     null,
      url:      null,
      selected: true,
    });
  }

  clips = [...rebuilt, ...imported];
  renderClips();
  btnProcess.disabled = clips.length === 0;
  setStatus(`${clips.length} clip${clips.length !== 1 ? 's' : ''} ready — click "Extract MP3" to process`);
}

function renderClips() {
  if (clips.length === 0) {
    clipsList.innerHTML = `
      <div class="empty-state">
        <div class="icon">✂️</div>
        <div>Load a video and add marks<br>to create clips</div>
      </div>`;
    btnDownloadAll.disabled = true;
    return;
  }

  clipsList.innerHTML = clips.map(c => `
    <div class="clip-card ${c.selected ? 'selected' : ''}" id="card-${c.id}">
      <div class="clip-card-top">
        <input type="checkbox" id="chk-${c.id}" ${c.selected ? 'checked' : ''}
          onchange="toggleSelect('${c.id}', this.checked)" />
        <span class="clip-label">
          ${c.file ? '📥 ' : ''}Clip ${c.index} &nbsp;·&nbsp; ${c.file ? escHtml(c.file.name) : `${fmt(c.start, 2)} → ${fmt(c.end, 2)}`} &nbsp;·&nbsp; ${fmtDur(c.end - c.start)}
        </span>
        ${c.url ? `
          <button class="btn btn-success btn-sm" onclick="downloadClip('${c.id}')" title="Download">⬇</button>
          <button class="btn btn-outline btn-sm" onclick="previewClip('${c.id}')" title="Preview">▶</button>
        ` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <div class="filename-input-wrap" title="${c.padDetected ? 'Pad number detected from filename' : c.locked ? 'Manually named' : 'Auto-numbered'}">
          <span class="filename-prefix">${prefix()}_</span>
          <input class="filename-input" type="text"
            value="${escHtml(c.name)}"
            placeholder="${c.index}"
            id="name-${c.id}"
            onchange="renameClip('${c.id}', this.value)"
            title="N in ${prefix()}_N.mp3" />
          <span class="filename-suffix">.mp3</span>
          ${c.padDetected ? '<span class="lock-icon" title="Pad number detected from filename · click to edit manually" onclick="unlockClip(\''+c.id+'\')">🔢</span>' : c.locked ? '<span class="lock-icon" title="Manually set · click to unlock" onclick="unlockClip(\''+c.id+'\')">🔒</span>' : ''}
        </div>
        <button class="btn btn-danger btn-sm" onclick="deleteClip('${c.id}')" title="Remove clip">✕</button>
      </div>
      ${c.url ? `<audio id="audio-${c.id}" src="${c.url}" style="display:none" preload="none"></audio>` : ''}
    </div>
  `).join('');

  updateDownloadBtn();
}

window.toggleSelect = (id, checked) => {
  const c = clips.find(x => x.id === id);
  if (!c) return;
  c.selected = checked;
  document.getElementById('card-' + id)?.classList.toggle('selected', checked);
  updateDownloadBtn();
};

// Auto-number subsequent unlocked clips when a clip is renamed
window.renameClip = (id, val) => {
  const idx = clips.findIndex(x => x.id === id);
  if (idx === -1) return;
  const trimmed = val.trim() || String(clips[idx].index);
  clips[idx].name   = trimmed;
  clips[idx].locked = true;
  clips[idx].padDetected = false; // user edited it, so it's a manual lock now

  // If the entered value is a number, cascade to subsequent unlocked clips
  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && String(num) === trimmed) {
    for (let j = idx + 1; j < clips.length; j++) {
      if (!clips[j].locked) {
        clips[j].name = String(num + (j - idx));
        // Update the input in-place without full re-render
        const inp = document.getElementById('name-' + clips[j].id);
        if (inp) inp.value = clips[j].name;
      }
    }
  }
  // Re-render only to update lock icons
  renderClips();
};

// Unlock a clip so auto-numbering can affect it again
window.unlockClip = id => {
  const c = clips.find(x => x.id === id);
  if (c) { c.locked = false; c.padDetected = false; renderClips(); }
};

window.deleteClip = id => {
  const i = clips.findIndex(x => x.id === id);
  if (i !== -1) { if (clips[i].url) URL.revokeObjectURL(clips[i].url); clips.splice(i, 1); }
  renderClips();
};

window.downloadClip = id => {
  const c = clips.find(x => x.id === id);
  if (!c?.url) { toast('Extract MP3 first', 'info'); return; }
  triggerDownload(c.url, `${prefix()}_${c.name}.mp3`);
};

window.previewClip = id => {
  const el = document.getElementById('audio-' + id);
  if (!el) return;
  if (el.paused) el.play(); else el.pause();
};

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
}

function updateDownloadBtn() {
  btnDownloadAll.disabled = !clips.some(c => c.selected && c.url);
}

btnSelectAll.addEventListener('click', () => {
  const allSelected = clips.every(c => c.selected);
  clips.forEach(c => { c.selected = !allSelected; });
  renderClips();
});

prefixInput.addEventListener('input', () => renderClips());

// ─── MP3 Encoding via Web Audio API + lamejs ──────────────────────────────────
// A single shared AudioContext, reused across every decode. This matters on
// iOS Safari — especially when the app is installed as a home-screen PWA —
// where an AudioContext only inherits the "started by a user tap" permission
// if it's created synchronously inside the click handler, before any `await`.
// Creating a fresh context later (after an await) leaves it silently suspended,
// so decodeAudioData never resolves with real audio. We create/resume this one
// context right at the top of the Extract click handler, then reuse it.
let sharedAudioCtx = null;
function getAudioCtx() {
  if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    sharedAudioCtx = new Ctor();
  }
  return sharedAudioCtx;
}

async function decodeAudio() {
  if (decodedAudioBuffer) return decodedAudioBuffer;
  showOverlay('Decoding audio… (this may take a moment for large files)');
  setStatus('Decoding audio…', 0.1);
  const arrayBuffer = await mainFile.arrayBuffer();
  const audioCtx = getAudioCtx();
  decodedAudioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  return decodedAudioBuffer;
}

// Resolves the AudioBuffer to encode a clip from — the shared main-video
// buffer for mark-based clips, or the clip's own file for imported clips
// (decoded once and cached on the clip).
async function getBufferForClip(c) {
  if (c.file) {
    if (c._buf) return c._buf;
    showOverlay(`Decoding ${c.file.name}…`);
    const arrayBuffer = await c.file.arrayBuffer();
    const ctx = getAudioCtx();
    c._buf = await ctx.decodeAudioData(arrayBuffer);
    return c._buf;
  }
  return decodeAudio();
}

function encodeClipToMp3(audioBuffer, start, end, onProgress) {
  const sr = audioBuffer.sampleRate;
  const startSample = Math.floor(start * sr);
  const endSample   = Math.min(Math.ceil(end * sr), audioBuffer.length);
  const length      = endSample - startSample;
  const numCh       = Math.min(audioBuffer.numberOfChannels, 2);

  const leftF32  = audioBuffer.getChannelData(0).subarray(startSample, endSample);
  const rightF32 = numCh > 1
    ? audioBuffer.getChannelData(1).subarray(startSample, endSample)
    : leftF32;

  function toInt16(f32) {
    const buf = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      buf[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return buf;
  }

  const leftI16  = toInt16(leftF32);
  const rightI16 = numCh > 1 ? toInt16(rightF32) : leftI16;

  const mp3enc   = new lamejs.Mp3Encoder(numCh, sr, 128);
  const chunkSz  = 1152;
  const mp3Parts = [];

  for (let i = 0; i < length; i += chunkSz) {
    const lChunk = leftI16.subarray(i, i + chunkSz);
    const rChunk = rightI16.subarray(i, i + chunkSz);
    const enc = numCh > 1 ? mp3enc.encodeBuffer(lChunk, rChunk) : mp3enc.encodeBuffer(lChunk);
    if (enc.length > 0) mp3Parts.push(new Uint8Array(enc));
    if (onProgress && i % (chunkSz * 100) === 0) onProgress(i / length);
  }

  const flush = mp3enc.flush();
  if (flush.length > 0) mp3Parts.push(new Uint8Array(flush));

  const total = mp3Parts.reduce((s, p) => s + p.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const p of mp3Parts) { merged.set(p, offset); offset += p.length; }

  return new Blob([merged], { type: 'audio/mpeg' });
}

function yieldToUI() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

btnProcess.addEventListener('click', async () => {
  if (!mainFile && !nativeFileMeta && !clips.some(c => c.file)) return;

  /* native-ffmpeg-patch */
  if (window.NativeBridge && window.NativeBridge.isNative && nativeFileMeta) {
    const toProcessNative = clips.filter(c => c.selected);
    if (toProcessNative.length === 0) { toast('No clips selected', 'info'); return; }
    btnProcess.disabled = true;
    btnDownloadAll.disabled = true;
    try {
      for (let i = 0; i < toProcessNative.length; i++) {
        const c = toProcessNative[i];
        setStatus(`Encoding clip ${i + 1}/${toProcessNative.length}: ${prefix()}_${c.name}.mp3…`, i / toProcessNative.length);
        await yieldToUI();
        const url = await window.NativeBridge.cutClip(c.start, c.end, c.name);
        if (c.url) URL.revokeObjectURL(c.url);
        c.url = url;
        c.blob = null; // native path already wrote the file; url is enough for playback/download
      }
      renderClips();
      setStatus(`✓ ${toProcessNative.length} clip${toProcessNative.length !== 1 ? 's' : ''} extracted`);
      toast(`Done! ${toProcessNative.length} MP3 file${toProcessNative.length !== 1 ? 's' : ''} ready`, 'success');
    } catch (err) {
      const detail = (err && err.name ? `${err.name}: ` : '') + (err && err.message ? err.message : String(err));
      setStatus('Error: ' + detail);
      toast('Failed: ' + detail, 'error', 8000);
      console.error(err);
    } finally {
      btnProcess.disabled = false;
      btnDownloadAll.disabled = false;
    }
    return;
  }
  /* native-ffmpeg-patch */


  const toProcess = clips.filter(c => c.selected);
  if (toProcess.length === 0) { toast('No clips selected', 'info'); return; }

  btnProcess.disabled = true;
  btnDownloadAll.disabled = true;

  // Create/resume the AudioContext synchronously, right here at the top of the
  // click handler and before any `await` — see note above getAudioCtx(). This
  // is what makes Extract work on iOS home-screen PWAs.
  const audioCtx = getAudioCtx();
  if (audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch (e) { console.error('AudioContext resume failed', e); }
  }

  try {
    for (let i = 0; i < toProcess.length; i++) {
      const c = toProcess[i];
      setStatus(`Encoding clip ${i + 1}/${toProcess.length}: ${prefix()}_${c.name}.mp3…`, i / toProcess.length);
      await yieldToUI();

      const audioBuffer = await getBufferForClip(c);
      hideOverlay();
      const start = c.file ? 0 : c.start;
      const end   = c.file ? audioBuffer.duration : c.end;

      const blob = encodeClipToMp3(audioBuffer, start, end, p => {
        const overall = (i + p) / toProcess.length;
        setStatus(`Encoding clip ${i + 1}/${toProcess.length}: ${Math.round(p * 100)}%…`, overall);
      });

      if (c.url) URL.revokeObjectURL(c.url);
      c.blob = blob;
      c.url  = URL.createObjectURL(blob);
    }

    renderClips();
    setStatus(`✓ ${toProcess.length} clip${toProcess.length !== 1 ? 's' : ''} extracted`);
    toast(`Done! ${toProcess.length} MP3 file${toProcess.length !== 1 ? 's' : ''} ready`, 'success');
  } catch (err) {
    hideOverlay();
    const detail = (err && err.name ? `${err.name}: ` : '') + (err && err.message ? err.message : String(err));
    setStatus('Error: ' + detail);
    toast('Failed: ' + detail, 'error', 8000);
    console.error(err);
  } finally {
    btnProcess.disabled = false;
    updateDownloadBtn();
  }
});

// ─── Download Selected (single or ZIP) ───────────────────────────────────────
btnDownloadAll.addEventListener('click', async () => {
  const ready = clips.filter(c => c.selected && c.url);
  if (ready.length === 0) { toast('No extracted clips selected', 'info'); return; }

  if (ready.length === 1) {
    triggerDownload(ready[0].url, `${prefix()}_${ready[0].name}.mp3`);
    return;
  }

  setStatus('Building ZIP…', 0);
  showOverlay('Building ZIP file…');
  try {
    const { default: JSZip } = await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm');
    const zip = new JSZip();
    for (const c of ready) zip.file(`${prefix()}_${c.name}.mp3`, c.blob);

    const blob = await zip.generateAsync({ type: 'blob' }, meta => {
      setStatus(`Building ZIP… ${Math.round(meta.percent)}%`, meta.percent / 100);
    });

    const url = URL.createObjectURL(blob);
    triggerDownload(url, `${prefix()}_clips.zip`);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    setStatus(`✓ ZIP downloaded (${ready.length} files)`);
    toast(`ZIP with ${ready.length} clips downloaded`, 'success');
  } catch (err) {
    setStatus('ZIP error: ' + err.message);
    toast('ZIP failed: ' + err.message, 'error', 6000);
  } finally {
    hideOverlay();
  }
});
