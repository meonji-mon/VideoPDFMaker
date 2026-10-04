// Real Electron integration checks. All media, metadata and profile writes are disposable.
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'videopdf-smoke-'));
const media = path.join(temporary, 'media');
fs.mkdirSync(media);
const videoName = process.platform === 'win32' ? '강의 # 100% & 검증.mp4' : '강의 # 100% & <검증>.mp4';
// Grayscale avoids decoder chroma interpolation at color/black boundaries.
// Lossless encoding keeps the 20-pixel padding exact for crop assertions.
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=12', '-t', '12', '-vf', 'hue=s=0,pad=680:400:20:20:black', '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv420p', path.join(media, videoName)]);
app.setPath('userData', path.join(temporary, 'profile'));
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [media] });
const errors = [];
let holdQuitForCloseChecks = false;
let quitRequested = false;
app.on('before-quit', event => {
  // Windows normally quits when its last window closes. Finish disk assertions first.
  if (holdQuitForCloseChecks) { event.preventDefault(); quitRequested = true; }
});
app.on('browser-window-created', (_event, win) => {
  win.webContents.session.enableNetworkEmulation({ offline: true });
  win.webContents.on('console-message', (_event, ...args) => {
    const details = typeof args[0] === 'object' ? args[0] : { level: args[0], message: args[1] };
    if (details.level === 'error' || details.level === 3) errors.push(details.message);
  });
});
require(process.env.VIDEOPDF_APP_MAIN || '../main');

async function waitFor(win, expression, timeout = 10000) {
  const start = Date.now();
  while (!await win.webContents.executeJavaScript(expression)) {
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${expression}`);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

app.whenReady().then(async () => {
  let win;
  try {
    win = BrowserWindow.getAllWindows()[0];
    if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    const evaluate = code => win.webContents.executeJavaScript(code, true);
    assert.deepEqual(await evaluate('({require:typeof require,module:typeof module,jspdf:typeof window.jspdf.jsPDF,bridge:typeof window.videoPDF.capture})'), { require: 'undefined', module: 'undefined', jspdf: 'function', bridge: 'function' });
    await evaluate("document.getElementById('btn-select-folder').click()");
    await waitFor(win, "document.querySelectorAll('#video-grid button').length === 1 && !busy");
    assert.equal(await evaluate("document.querySelector('.video-name').textContent"), videoName);
    await evaluate("document.querySelector('#video-grid button').click()");
    await waitFor(win, "video.readyState >= 2 && !busy");
    await evaluate("document.getElementById('time-jump-input').value='123455'; document.getElementById('time-jump-input').dispatchEvent(new Event('input',{bubbles:true}))");
    assert.equal(await evaluate("document.getElementById('time-jump-input').value"), '12:34:55');
    await evaluate("document.getElementById('time-jump-form').requestSubmit()");
    assert.match(await evaluate("document.getElementById('time-jump-error').textContent"), /영상 길이/);
    await evaluate("document.getElementById('time-jump-input').value='000005'; document.getElementById('time-jump-input').dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('time-jump-form').requestSubmit()");
    await waitFor(win, "!video.seeking && Math.abs(video.currentTime-5)<0.2");
    await evaluate("document.getElementById('playback-rate').value='2'; document.getElementById('playback-rate').dispatchEvent(new Event('change')); video.play()");
    await waitFor(win, 'video.currentTime > 5.5 && !video.paused');
    await evaluate('video.pause()');
    const pausedTime = await evaluate('video.currentTime');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await evaluate('video.currentTime'), pausedTime);
    assert.equal(await evaluate('video.playbackRate'), 2);
    await evaluate("document.getElementById('btn-fullscreen').click()");
    await waitFor(win, '!!document.fullscreenElement');
    await evaluate('document.exitFullscreen()');
    await waitFor(win, '!document.fullscreenElement');
    await evaluate("document.getElementById('btn-capture').click()");
    await waitFor(win, "snapshots.length === 1 && !busy");
    assert.deepEqual(await evaluate("new Promise(resolve => { const img=new Image(); img.onload=()=>resolve([img.width,img.height]); img.src=snapshots[0].image; })"), [640, 360]);
    const note = '</textarea><img src=x onerror="window.injected=1">\n한글 메모 😊\n' + Array.from({ length: 40 }, (_, i) => `메모 ${i + 1} — 마지막 줄까지 보존합니다.`).join('\n');
    await evaluate(`document.querySelector('.snapshot-card textarea').value=${JSON.stringify(note)}; document.querySelector('.snapshot-card textarea').dispatchEvent(new Event('input',{bubbles:true})); serialSave()`);
    assert.equal(await evaluate("window.injected"), undefined);
    await evaluate('renderSnapshots()');
    assert.equal(await evaluate("document.querySelector('.snapshot-card textarea').value"), note);
    assert.equal(await evaluate("window.injected"), undefined);
    await evaluate("document.getElementById('btn-export-pdf').click()");
    await waitFor(win, "!busy", 20000);
    const savedDirectory = await evaluate('saveDirectory');
    const pdf = path.join(savedDirectory, `${path.parse(videoName).name}_강의노트.pdf`);
    assert.ok(fs.existsSync(pdf), 'Offline PDF export wrote a real PDF');
    assert.match(fs.readFileSync(pdf).subarray(0, 5).toString(), /%PDF-/);
    const state = JSON.parse(fs.readFileSync(path.join(savedDirectory, 'workspace_data.json'), 'utf8'));
    assert.equal(state.snapshots[0].note, note);
    assert.ok(fs.statSync(path.join(savedDirectory, state.snapshots[0].id)).size > 100);
    await evaluate("window.confirm=()=>true; document.getElementById('btn-reset').click()");
    await waitFor(win, "!busy && snapshots.length === 0 && hasArchived");
    await evaluate("document.getElementById('btn-restore').click()");
    await waitFor(win, "!busy && snapshots.length === 1 && !hasArchived");
    assert.equal(await evaluate('snapshots[0].note'), note);
    const originalImage = await evaluate('snapshots[0].image');
    await evaluate("document.querySelector('.draw-btn').click()");
    await waitFor(win, "!document.getElementById('drawing-modal').classList.contains('hidden') && bgCanvas.width === 640");
    await evaluate("drawCtx.strokeStyle='#EF4444'; drawCtx.lineWidth=8; drawCtx.beginPath(); drawCtx.moveTo(30,30); drawCtx.lineTo(150,80); drawCtx.stroke(); document.getElementById('btn-draw-save').click()");
    await waitFor(win, "!busy && document.getElementById('drawing-modal').classList.contains('hidden')");
    await evaluate('loadVideoToWorkspace(currentVideoId)');
    await waitFor(win, 'video.readyState >= 2');
    assert.notEqual(await evaluate('snapshots[0].image'), originalImage);
    assert.equal(await evaluate('snapshots[0].note'), note);
    if (process.env.VIDEOPDF_KEEP_SMOKE !== '1') {
      // External removal affects only a disposable fixture; its note must remain recoverable.
      fs.unlinkSync(path.join(savedDirectory, state.snapshots[0].id));
      await evaluate('loadVideoToWorkspace(currentVideoId)');
      assert.equal(await evaluate('snapshots.length'), 0);
      assert.equal(await evaluate('hasArchived'), true);
      assert.equal(JSON.parse(fs.readFileSync(path.join(savedDirectory, 'workspace_data.json'), 'utf8')).archived[0].note, note);
      await waitFor(win, 'video.readyState >= 2');
      await evaluate("document.getElementById('auto-crop-checkbox').checked=false; document.getElementById('btn-capture').click()");
      await waitFor(win, 'snapshots.length === 1 && !busy');
      assert.deepEqual(await evaluate("new Promise(resolve => { const img=new Image(); img.onload=()=>resolve([img.width,img.height]); img.src=snapshots[0].image; })"), [680, 400]);
      await evaluate("document.getElementById('btn-export-pdf').click()");
      await waitFor(win, '!busy', 20000);
    }
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const screenshot = path.join(__dirname, '..', '.codex', 'screenshots', 'TIME_JUMP_영상작업_수정후.png');
    fs.mkdirSync(path.dirname(screenshot), { recursive: true });
    fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
    assert.deepEqual(errors, [], 'No renderer errors under offline network emulation');
    if (process.env.VIDEOPDF_KEEP_SMOKE !== '1') {
      const finalNote = note + '\n종료 직전 저장 검증';
      await evaluate(`document.querySelector('.snapshot-card textarea').value=${JSON.stringify(finalNote)}; document.querySelector('.snapshot-card textarea').dispatchEvent(new Event('input',{bubbles:true}))`);
      const closed = new Promise(resolve => win.once('closed', resolve));
      const quitting = process.platform === 'win32' ? new Promise(resolve => app.once('before-quit', resolve)) : null;
      holdQuitForCloseChecks = true;
      win.close();
      await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('Close flush timed out')), 10000))]);
      const finalState = JSON.parse(fs.readFileSync(path.join(savedDirectory, 'workspace_data.json'), 'utf8'));
      assert.equal(finalState.snapshots[0].note, finalNote);
      if (quitting) {
        await Promise.race([quitting, new Promise((_, reject) => setTimeout(() => reject(new Error('Windows quit event timed out')), 10000))]);
        assert.equal(quitRequested, true, 'Windows requested normal app shutdown');
      }
      holdQuitForCloseChecks = false;
    }
    console.log(JSON.stringify({ status: 'PASS', checks: ['isolated renderer', 'local libraries', 'special-character filenames', 'HH:MM:SS formatting', 'duration bounds', 'seek to 5 seconds', 'offline playback advances and pause stops it', '2x playback rate', 'fullscreen enter and exit', 'offline capture and black-border crop', 'HTML treated as text', 'offline multipage PDF', 'Korean/emoji notes', 'reset and restore', 'drawing save and reopen', ...(process.env.VIDEOPDF_KEEP_SMOKE === '1' ? [] : ['missing image note retained, new capture and PDF succeed', 'capture without crop', 'save before close'])], pdf, screenshot, temporary }));
    if (process.env.VIDEOPDF_KEEP_SMOKE === '1') return;
    app.quit();
  } catch (error) {
    console.error(error.stack);
    console.error(JSON.stringify({ errors, temporary }));
    app.exit(1);
  }
});
