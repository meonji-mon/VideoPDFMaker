const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const piexif = require('piexifjs');
const { WorkspaceStore, checkedPath, noteInJPEG } = require('../workspace-store');
const Timecode = require('../timecode');
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjExLjEwMAD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABLAAEBAAAAAAAAAAAAAAAAAAAABwEBAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIABAAEAMBIgACEQADEQD/2gAMAwEAAhEDEQA/AL+AD//Z', 'base64');
const image = `data:image/jpeg;base64,${JPEG.toString('base64')}`;

function fixture(t, names = ['lesson.mp4']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'videopdf-test-'));
  // These files are disposable fixtures, never a selected user workspace.
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of names) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), 'fixture');
  }
  const store = new WorkspaceStore();
  const workspace = store.selectRoot(root);
  return { root, store, videos: workspace.videos };
}

test('six sequential digits format HH:MM:SS; invalid fields are rejected', () => {
  assert.deepEqual(['1', '12', '123', '1234', '12345', '123455'].map(Timecode.formatDigits), ['1', '12', '12:3', '12:34', '12:34:5', '12:34:55']);
  assert.equal(Timecode.parse('12:34:55'), 45295);
  assert.equal(Timecode.parse('00:00:00'), 0);
  for (const input of ['12:60:00', '00:00:60', '12:3', '123455', '-1:00:00', '']) assert.equal(Timecode.parse(input), null);
  assert.equal(Timecode.format(45295.9), '12:34:55');
});

test('same-named videos and different extensions have separate images, notes and PDFs', t => {
  const { store, videos } = fixture(t, ['A/lesson.mp4', 'B/lesson.mp4', 'A/lesson.webm']);
  assert.equal(new Set(videos.map(v => v.id)).size, 3);
  const snapshots = videos.map(video => store.capture(video.id, image, 1));
  videos.forEach((video, i) => store.saveSnapshots(video.id, [{ ...snapshots[i], note: `note ${i}` }]));
  videos.forEach((video, i) => assert.equal(store.openVideo(video.id).snapshots[0].note, `note ${i}`));
  const pdf = new TextEncoder().encode('%PDF-1.4\nfixture').buffer;
  assert.equal(new Set(videos.map(v => store.savePDF(v.id, pdf).path)).size, 3);
});

test('reordering and deletion remain saved after reopening the workspace', t => {
  const { root, store, videos: [video] } = fixture(t);
  const first = store.capture(video.id, image, 1), second = store.capture(video.id, image, 2);
  store.saveSnapshots(video.id, [second, first]);
  store.selectRoot(root);
  assert.deepEqual(store.openVideo(video.id).snapshots.map(s => s.time), [2, 1]);
  store.deleteSnapshot(video.id, second.id);
  store.selectRoot(root);
  assert.deepEqual(store.openVideo(video.id).snapshots.map(s => s.time), [1]);
});

test('reset preserves image files and notes, including after restart and restore', t => {
  const { root, store, videos: [video] } = fixture(t);
  const item = store.capture(video.id, image, 5);
  store.saveSnapshots(video.id, [{ ...item, note: '한글 메모 😊' }]);
  store.reset(video.id);
  assert.ok(fs.existsSync(store.imagePath(video.id, item.id)));
  store.selectRoot(root);
  assert.equal(store.openVideo(video.id).snapshots.length, 0);
  assert.equal(store.openVideo(video.id).hasArchived, true);
  assert.equal(store.restoreSnapshots(video.id).snapshots[0].note, '한글 메모 😊');
});

test('copied legacy absolute paths are rebased to the copy; originals are untouched', t => {
  const { root, store, videos: [video] } = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'videopdf-original-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'lesson'));
  fs.writeFileSync(path.join(outside, 'snap_1_original.jpg'), JPEG);
  fs.writeFileSync(path.join(root, 'lesson', 'snap_1_original.jpg'), JPEG);
  fs.writeFileSync(path.join(root, 'lesson', 'workspace_data.json'), JSON.stringify([{ filePath: path.join(outside, 'snap_1_original.jpg'), time: 1, note: 'original note' }]));
  const imported = store.openVideo(video.id).snapshots;
  assert.equal(imported[0].note, 'original note');
  store.deleteSnapshot(video.id, imported[0].id);
  assert.ok(fs.existsSync(path.join(outside, imported[0].id)));
  assert.ok(fs.existsSync(path.join(root, 'lesson', imported[0].id)));
});

test('forged IDs, traversal and symlinks cannot read, overwrite or delete external files', t => {
  const { root, store, videos: [video] } = fixture(t);
  assert.throws(() => store.openVideo('forged'));
  assert.throws(() => store.imagePath(video.id, '../outside.jpg'));
  assert.throws(() => checkedPath(root, path.join(root, '..', 'outside')));
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(os.tmpdir(), path.join(root, '.videopdf'), linkType);
  assert.throws(() => store.capture(video.id, image, 1), /심볼릭/);
  fs.unlinkSync(path.join(root, '.videopdf'));
  fs.symlinkSync(path.join(root, 'missing'), path.join(root, '.videopdf'), linkType);
  assert.throws(() => store.capture(video.id, image, 1), /심볼릭/);
});

test('malformed image, PDF and snapshot payloads fail before writing', t => {
  const { store, videos: [video] } = fixture(t);
  assert.throws(() => store.capture(video.id, 'data:text/plain;base64,AA==', 1));
  assert.throws(() => store.capture(video.id, image, NaN));
  assert.throws(() => store.savePDF(video.id, new Uint8Array([1, 2, 3]).buffer));
  const item = store.capture(video.id, image, 1);
  assert.throws(() => store.saveSnapshots(video.id, [{ ...item, id: 'snap_forged.jpg' }]));
  assert.throws(() => store.saveSnapshots(video.id, [{ ...item, time: 9 }]));
  assert.equal(store.openVideo(video.id).snapshots[0].time, 1);
});

test('Korean and emoji notes roundtrip in JPEG metadata without corruption', () => {
  const note = '한글 메모 😊';
  const metadata = piexif.load(noteInJPEG(JPEG, note).toString('binary'));
  assert.equal(Buffer.from(metadata['0th'][piexif.ImageIFD.XPComment]).toString('utf16le').replace(/\0$/, ''), note);
});

test('a missing image preserves its note without blocking the remaining workspace', t => {
  const { root, store, videos: [video] } = fixture(t);
  const missing = store.capture(video.id, image, 1), remaining = store.capture(video.id, image, 2);
  store.saveSnapshots(video.id, [{ ...missing, note: 'missing image note' }, remaining]);
  fs.unlinkSync(store.imagePath(video.id, missing.id));
  store.selectRoot(root);
  const opened = store.openVideo(video.id);
  assert.deepEqual(opened.snapshots.map(item => item.id), [remaining.id]);
  assert.match(opened.warning, /메모를 보관/);
  store.saveSnapshots(video.id, [{ ...remaining, note: 'remaining note' }]);
  store.capture(video.id, image, 3);
  store.savePDF(video.id, new TextEncoder().encode('%PDF-1.4\nfixture').buffer);
  store.reset(video.id);
  assert.equal(store.restoreSnapshots(video.id).snapshots.length, 2);
  assert.equal(store.state(video.id).archived[0].note, 'missing image note');
  fs.writeFileSync(store.imagePath(video.id, missing.id), JPEG);
  const recovered = store.restoreSnapshots(video.id);
  assert.equal(recovered.snapshots.find(item => item.id === missing.id).note, 'missing image note');
  assert.equal(recovered.warning, '');
});

test('delete failures preserve the visible item and metadata', t => {
  const { store, videos: [video] } = fixture(t);
  const item = store.capture(video.id, image, 1);
  const target = store.imagePath(video.id, item.id);
  const unlink = fs.unlinkSync;
  fs.unlinkSync = file => { if (file === target) throw new Error('fixture: permission denied'); return unlink(file); };
  try { assert.throws(() => store.deleteSnapshot(video.id, item.id), /permission denied/); }
  finally { fs.unlinkSync = unlink; }
  assert.equal(store.openVideo(video.id).snapshots.length, 1);
  assert.ok(fs.existsSync(target));
});

test('metadata write failure prevents deletion of the image', t => {
  const { store, videos: [video] } = fixture(t);
  const item = store.capture(video.id, image, 1);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to.endsWith('workspace_data.json')) throw new Error('fixture: disk write failed'); return rename(from, to); };
  try { assert.throws(() => store.deleteSnapshot(video.id, item.id), /disk write failed/); }
  finally { fs.renameSync = rename; }
  assert.equal(store.openVideo(video.id).snapshots.length, 1);
  assert.ok(fs.existsSync(store.imagePath(video.id, item.id)));
});
