const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash, randomUUID } = require('node:crypto');
const piexif = require('piexifjs');

const IMAGE_LIMIT = 50 * 1024 * 1024;
const SNAPSHOT_ID = /^snap_[\w.-]+\.jpg$/;

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function checkedPath(root, target) {
  if (!contained(root, target)) throw new Error('작업 폴더 밖의 경로는 사용할 수 없습니다.');
  let current = root;
  for (const part of ['', ...path.relative(root, target).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) {
      throw new Error('심볼릭 링크를 통한 파일 접근은 허용되지 않습니다.');
    }
  }
  return target;
}

function atomicWrite(file, data) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, data, { flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function jpegBytes(image) {
  if (typeof image !== 'string' || image.length > IMAGE_LIMIT * 1.4 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image)) {
    throw new Error('올바른 JPEG 이미지가 필요합니다.');
  }
  const bytes = Buffer.from(image.slice('data:image/jpeg;base64,'.length), 'base64');
  if (bytes.length > IMAGE_LIMIT || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
    throw new Error('올바른 JPEG 이미지가 필요합니다.');
  }
  return bytes;
}

function noteInJPEG(bytes, note) {
  let exif;
  const image = `data:image/jpeg;base64,${bytes.toString('base64')}`;
  try { exif = piexif.load(image); } catch { exif = { '0th': {}, Exif: {}, GPS: {} }; }
  delete exif['0th'][piexif.ImageIFD.ImageDescription];
  delete exif['0th'][piexif.ImageIFD.XPComment];
  delete exif.Exif[piexif.ExifIFD.UserComment];
  if (note) {
    // ImageDescription is ASCII. UserComment and XPComment retain Korean/emoji.
    if (/^[\x00-\x7f]*$/.test(note)) exif['0th'][piexif.ImageIFD.ImageDescription] = note;
    const unicode = Buffer.from(note, 'utf16le');
    const bigEndian = Buffer.from(unicode).swap16();
    exif.Exif[piexif.ExifIFD.UserComment] = [...Buffer.concat([Buffer.from('UNICODE\0'), Buffer.from([0xfe, 0xff]), bigEndian])];
    exif['0th'][piexif.ImageIFD.XPComment] = [...Buffer.concat([unicode, Buffer.alloc(2)])];
  }
  const updated = piexif.insert(piexif.dump(exif), image);
  return Buffer.from(updated.slice('data:image/jpeg;base64,'.length), 'base64');
}

class WorkspaceStore {
  constructor() {
    this.root = null;
    this.videos = new Map();
    this.states = new Map();
  }

  selectRoot(directory) {
    const root = fs.realpathSync(directory);
    if (!fs.statSync(root).isDirectory()) throw new Error('폴더를 선택해주세요.');
    const videos = new Map();
    const scan = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || entry.name === '.videopdf') continue;
        const absolutePath = path.join(dir, entry.name);
        if (entry.isDirectory()) scan(absolutePath);
        else if (/\.(mp4|m4v|webm)$/i.test(entry.name)) {
          const relativePath = path.relative(root, absolutePath);
          const id = createHash('sha256').update(relativePath).digest('hex').slice(0, 24);
          videos.set(id, { id, name: entry.name, relativePath, mediaURL: pathToFileURL(absolutePath).href });
        }
      }
    };
    scan(root);
    this.root = root;
    this.videos = videos;
    this.states.clear();
    return { name: path.basename(root), videos: [...videos.values()] };
  }

  video(id) {
    const video = this.videos.get(id);
    if (!this.root || !video) throw new Error('작업 폴더에서 영상을 먼저 선택해주세요.');
    checkedPath(this.root, path.join(this.root, video.relativePath));
    return video;
  }

  directory(id) {
    this.video(id);
    return checkedPath(this.root, path.join(this.root, '.videopdf', id));
  }

  imagePath(videoId, id) {
    if (typeof id !== 'string' || !SNAPSHOT_ID.test(id)) throw new Error('올바르지 않은 캡처 파일입니다.');
    const directory = this.directory(videoId);
    return checkedPath(directory, path.join(directory, id));
  }

  persist(id, state) {
    const directory = this.directory(id);
    fs.mkdirSync(directory, { recursive: true });
    const file = checkedPath(directory, path.join(directory, 'workspace_data.json'));
    atomicWrite(file, JSON.stringify(state, null, 2));
    this.states.set(id, state);
  }

  validateSnapshot(item) {
    if (!item || !SNAPSHOT_ID.test(item.id) || !Number.isFinite(item.time) || item.time < 0 || typeof item.note !== 'string' || item.note.length > 10000) {
      throw new Error('저장된 캡처 데이터가 올바르지 않습니다.');
    }
    return { id: item.id, time: item.time, note: item.note };
  }

  state(id) {
    if (this.states.has(id)) return this.states.get(id);
    const video = this.video(id);
    const directory = this.directory(id);
    const json = checkedPath(directory, path.join(directory, 'workspace_data.json'));
    let state = { version: 2, video: video.relativePath, snapshots: [], archived: [] };
    if (fs.existsSync(json)) {
      const saved = JSON.parse(fs.readFileSync(json, 'utf8'));
      if (saved.version !== 2 || saved.video !== video.relativePath || !Array.isArray(saved.snapshots) || !Array.isArray(saved.archived)) {
        throw new Error('저장된 작업 데이터 형식이 올바르지 않습니다.');
      }
      state.snapshots = saved.snapshots.map(item => this.validateSnapshot(item));
      state.archived = saved.archived.map(item => this.validateSnapshot(item));
    } else {
      const basename = path.parse(video.name).name;
      const legacy = checkedPath(this.root, path.join(this.root, basename));
      const legacyJSON = checkedPath(this.root, path.join(legacy, 'workspace_data.json'));
      const sameNames = [...this.videos.values()].filter(v => path.parse(v.name).name === basename);
      if (fs.existsSync(legacyJSON)) {
        if (sameNames.length > 1) {
          state.warning = '같은 이름의 영상이 여러 개여서 이전 공용 캡처는 자동으로 가져오지 않았습니다. 이전 파일은 그대로 보존됩니다.';
        } else {
          const items = JSON.parse(fs.readFileSync(legacyJSON, 'utf8'));
          if (!Array.isArray(items)) throw new Error('이전 작업 데이터 형식이 올바르지 않습니다.');
          fs.mkdirSync(directory, { recursive: true });
          for (const item of items) {
            // Rebase legacy absolute paths to the selected copy, never the original folder.
            const filename = path.win32.basename(path.basename(String(item.filePath || '')));
            const clean = this.validateSnapshot({ id: filename, time: item.time, note: item.note || '' });
            const source = checkedPath(legacy, path.join(legacy, filename));
            if (!fs.existsSync(source)) continue;
            const destination = this.imagePath(id, filename);
            if (!fs.existsSync(destination)) fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
            state.snapshots.push(clean);
          }
          this.persist(id, state);
        }
      }
    }
    this.states.set(id, state);
    return state;
  }

  openVideo(id) {
    let state = this.state(id);
    const missing = state.snapshots.filter(item => !fs.existsSync(this.imagePath(id, item.id)));
    if (missing.length) {
      const archived = new Map(state.archived.map(item => [item.id, item]));
      missing.forEach(item => archived.set(item.id, item));
      const missingIds = new Set(missing.map(item => item.id));
      state = { ...state, snapshots: state.snapshots.filter(item => !missingIds.has(item.id)), archived: [...archived.values()] };
      this.persist(id, state);
    }
    const hasMissing = state.archived.some(item => !fs.existsSync(this.imagePath(id, item.id)));
    const snapshots = state.snapshots.map(item => ({
      ...item, image: `data:image/jpeg;base64,${fs.readFileSync(this.imagePath(id, item.id)).toString('base64')}`
    }));
    const warning = hasMissing ? '일부 캡처 이미지가 없어 메모를 보관했습니다. 이미지를 되돌린 뒤 “보관 목록 복원”으로 불러올 수 있습니다.' : state.warning || '';
    return { ...this.video(id), snapshots, hasArchived: state.archived.length > 0, warning, saveDirectory: this.directory(id) };
  }

  capture(videoId, image, time) {
    if (!Number.isFinite(time) || time < 0) throw new Error('영상 시간 정보가 올바르지 않습니다.');
    const state = this.state(videoId);
    const id = `snap_${time.toFixed(2)}_${randomUUID()}.jpg`;
    const directory = this.directory(videoId);
    fs.mkdirSync(directory, { recursive: true });
    const imagePath = this.imagePath(videoId, id);
    fs.writeFileSync(imagePath, jpegBytes(image), { flag: 'wx' });
    const item = { id, time, note: '' };
    try { this.persist(videoId, { ...state, snapshots: [...state.snapshots, item] }); }
    catch (error) { fs.unlinkSync(imagePath); throw error; }
    return { ...item, image };
  }

  saveSnapshots(videoId, items) {
    const state = this.state(videoId);
    if (!Array.isArray(items) || items.length !== state.snapshots.length) throw new Error('캡처 목록이 변경되었습니다. 영상을 다시 열어주세요.');
    const known = new Map(state.snapshots.map(item => [item.id, item]));
    const seen = new Set();
    const snapshots = items.map(item => {
      const clean = this.validateSnapshot(item);
      const previous = known.get(clean.id);
      if (!previous || seen.has(clean.id) || clean.time !== previous.time) throw new Error('캡처 목록이 올바르지 않습니다.');
      seen.add(clean.id);
      return clean;
    });
    this.persist(videoId, { ...state, snapshots });
    // JSON is authoritative; an EXIF failure never removes the saved note.
    const warnings = [];
    for (const item of snapshots) {
      if (item.note === known.get(item.id).note) continue;
      try {
        const image = this.imagePath(videoId, item.id);
        atomicWrite(image, noteInJPEG(fs.readFileSync(image), item.note));
      } catch { warnings.push('메모는 저장했지만 일부 이미지의 EXIF 메모는 저장하지 못했습니다.'); }
    }
    return { warning: warnings[0] || '' };
  }

  deleteSnapshot(videoId, id) {
    const state = this.state(videoId);
    if (!state.snapshots.some(item => item.id === id)) throw new Error('캡처를 찾을 수 없습니다.');
    const image = this.imagePath(videoId, id);
    this.persist(videoId, { ...state, snapshots: state.snapshots.filter(item => item.id !== id) });
    try { if (fs.existsSync(image)) fs.unlinkSync(image); }
    catch (error) { this.persist(videoId, state); throw error; }
  }

  reset(videoId) {
    const state = this.state(videoId);
    const archived = new Map(state.archived.map(item => [item.id, item]));
    state.snapshots.forEach(item => archived.set(item.id, item));
    this.persist(videoId, { ...state, snapshots: [], archived: [...archived.values()] });
    return { hasArchived: archived.size > 0 };
  }

  restoreSnapshots(videoId) {
    const state = this.state(videoId);
    const active = new Set(state.snapshots.map(item => item.id));
    this.persist(videoId, { ...state, snapshots: [...state.archived.filter(item => !active.has(item.id)), ...state.snapshots], archived: [] });
    return this.openVideo(videoId);
  }

  saveDrawing(videoId, id, image) {
    const item = this.state(videoId).snapshots.find(item => item.id === id);
    if (!item) throw new Error('캡처를 찾을 수 없습니다.');
    let bytes = jpegBytes(image);
    if (item.note) bytes = noteInJPEG(bytes, item.note);
    atomicWrite(this.imagePath(videoId, id), bytes);
  }

  savePDF(videoId, data) {
    if (!(data instanceof ArrayBuffer) || data.byteLength > 250 * 1024 * 1024) throw new Error('PDF 데이터가 올바르지 않습니다.');
    const bytes = Buffer.from(data);
    if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('PDF 데이터가 올바르지 않습니다.');
    const directory = this.directory(videoId);
    fs.mkdirSync(directory, { recursive: true });
    const file = checkedPath(directory, path.join(directory, `${path.parse(this.video(videoId).name).name}_강의노트.pdf`));
    atomicWrite(file, bytes);
    return { path: file };
  }
}

module.exports = { WorkspaceStore, checkedPath, jpegBytes, noteInJPEG };
