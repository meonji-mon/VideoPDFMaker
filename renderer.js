'use strict';
const api = window.videoPDF;
    // --- State & Variables ---
    let currentVideoId = '';
    let saveDirectory = '';
    let hasArchived = false;
    let busy = false;
    let saveQueue = Promise.resolve();
    let noteTimer;
    let loadGeneration = 0;
    let editRevision = 0;
    let savedRevision = 0;
    let currentVideoName = ''; // 현재 재생중인 영상 파일명
    let snapshots = [];

    // DOM Elements
    const video = document.getElementById('main-video');
    const playIcon = document.getElementById('play-icon');
    const seekBar = document.getElementById('seek-bar');
    const timeCurrent = document.getElementById('time-current');
    const timeDuration = document.getElementById('time-duration');
    const snapshotList = document.getElementById('snapshot-list');
    const emptyState = document.getElementById('empty-state');
    const countBadge = document.getElementById('snapshot-count');
    const headerTitle = document.getElementById('header-title');
    const headerActions = document.getElementById('header-actions');
    const viewHome = document.getElementById('view-home');
    const viewWorkspace = document.getElementById('view-workspace');
    const navHome = document.getElementById('nav-home');
    const navWorkspace = document.getElementById('nav-workspace');
    const playerContainer = document.getElementById('player-container');
    const btnFullscreen = document.getElementById('btn-fullscreen');

    let draggedItemIndex = null;

    // --- Navigation ---
    function switchView(view) {
      if (view === 'home') {
        viewHome.classList.remove('hidden');
        viewWorkspace.classList.add('hidden');
        viewWorkspace.classList.remove('grid');
        navHome.classList.replace('text-toss-grey500', 'text-toss-grey900');
        navHome.classList.replace('hover:bg-toss-grey100', 'bg-toss-grey100');
        navWorkspace.classList.replace('text-toss-grey900', 'text-toss-grey500');
        navWorkspace.classList.replace('bg-toss-grey100', 'hover:bg-toss-grey100');
        headerTitle.textContent = '';
        headerActions.classList.add('hidden');
        video.pause();
      } else {
        viewHome.classList.add('hidden');
        viewWorkspace.classList.remove('hidden');
        viewWorkspace.classList.add('grid');
        navWorkspace.classList.replace('text-toss-grey500', 'text-toss-grey900');
        navWorkspace.classList.replace('hover:bg-toss-grey100', 'bg-toss-grey100');
        navHome.classList.replace('text-toss-grey900', 'text-toss-grey500');
        navHome.classList.replace('bg-toss-grey100', 'hover:bg-toss-grey100');
        headerTitle.textContent = currentVideoName;
        headerActions.classList.remove('hidden');
      }
    }

    navHome.addEventListener('click', () => switchView('home'));
    navWorkspace.addEventListener('click', () => {
      if (currentVideoName) switchView('workspace');
      else showToast('홈에서 영상을 먼저 선택해주세요.');
    });

    const formatTime = Timecode.format;

    function showToast(msg) {
      const toast = document.getElementById('toast');
      toast.textContent = msg;
      toast.classList.remove('opacity-0', 'translate-y-4');
      toast.classList.add('opacity-100', 'translate-y-0');
      setTimeout(() => {
        toast.classList.remove('opacity-100', 'translate-y-0');
        toast.classList.add('opacity-0', 'translate-y-4');
      }, 3000);
    }

    function showError(error) {
      console.error(error);
      showToast(error.message || '작업을 완료하지 못했습니다.');
    }

    function setBusy(value) {
      busy = value;
      for (const id of ['btn-select-folder', 'btn-capture', 'btn-reset', 'btn-export-pdf', 'btn-restore']) {
        document.getElementById(id).disabled = value;
      }
      snapshotList.inert = value;
      document.getElementById('btn-time-jump').disabled = value || !Number.isFinite(video.duration) || !video.videoWidth;
    }

    function serialSave() {
      clearTimeout(noteTimer);
      const id = currentVideoId;
      const revision = editRevision;
      const data = snapshots.map(({ id, time, note }) => ({ id, time, note }));
      const next = saveQueue.catch(() => {}).then(() => api.saveSnapshots(id, data));
      saveQueue = next;
      next.then(result => {
        if (id === currentVideoId) savedRevision = Math.max(savedRevision, revision);
        if (result.warning) showToast(result.warning);
      }).catch(showError);
      return next;
    }

    window.addEventListener('beforeunload', event => {
      if (!currentVideoId || editRevision === savedRevision) return;
      event.preventDefault();
      event.returnValue = false;
      serialSave().then(() => window.close()).catch(() => {});
    });

    async function withBusy(action) {
      if (busy) return;
      setBusy(true);
      try {
        if (currentVideoId) await serialSave();
        await action();
      } catch (error) { showError(error); }
      finally { setBusy(false); }
    }

    function renderHomeGrid(files) {
      const grid = document.getElementById('video-grid');
      const empty = document.getElementById('home-empty-state');
      grid.replaceChildren();
      empty.classList.toggle('hidden', files.length > 0);
      grid.classList.toggle('hidden', files.length === 0);
      for (const file of files) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'flex flex-col gap-3 cursor-pointer group text-left';
        card.innerHTML = `
          <div class="w-full aspect-video bg-toss-grey900 rounded-2xl overflow-hidden relative border border-toss-grey200 flex items-center justify-center">
            <img class="thumbnail-img w-full h-full object-cover hidden" alt="영상 미리보기" />
            <div class="loader-icon text-white opacity-50"><i class="ph-bold ph-spinner animate-spin text-3xl"></i></div>
            <span class="video-format absolute bottom-2 right-2 bg-black bg-opacity-80 text-white text-xs px-1.5 py-0.5 rounded"></span>
          </div>
          <div class="px-1 w-full"><h3 class="video-name t5 font-bold truncate"></h3><p class="video-folder st12 mt-0.5 truncate"></p></div>`;
        card.querySelector('.video-name').textContent = file.name;
        card.querySelector('.video-name').title = file.name;
        card.querySelector('.video-folder').textContent = file.relativePath;
        card.querySelector('.video-folder').title = file.relativePath;
        card.querySelector('.video-format').textContent = file.name.split('.').at(-1).toUpperCase();
        const preview = document.createElement('video');
        preview.preload = 'metadata';
        preview.muted = true;
        preview.src = file.mediaURL;
        const release = () => { preview.removeAttribute('src'); preview.load(); };
        preview.addEventListener('loadeddata', () => { preview.currentTime = Math.min(1, preview.duration / 2); }, { once: true });
        preview.addEventListener('seeked', () => {
          if (preview.videoWidth) {
            const canvas = document.createElement('canvas');
            canvas.width = 320;
            canvas.height = 320 * preview.videoHeight / preview.videoWidth;
            canvas.getContext('2d').drawImage(preview, 0, 0, canvas.width, canvas.height);
            const thumbnail = card.querySelector('.thumbnail-img');
            thumbnail.src = canvas.toDataURL('image/jpeg', 0.7);
            thumbnail.classList.remove('hidden');
          }
          card.querySelector('.loader-icon').classList.add('hidden');
          release();
        }, { once: true });
        preview.addEventListener('error', () => {
          card.querySelector('.loader-icon').textContent = '미리보기 없음';
          release();
        }, { once: true });
        card.addEventListener('click', () => withBusy(() => loadVideoToWorkspace(file.id)));
        grid.appendChild(card);
      }
    }

    async function loadVideoToWorkspace(id) {
      const generation = ++loadGeneration;
      const state = await api.openVideo(id);
      if (generation !== loadGeneration) return;
      video.pause();
      currentVideoId = state.id;
      currentVideoName = state.name;
      saveDirectory = state.saveDirectory;
      hasArchived = state.hasArchived;
      snapshots = state.snapshots;
      editRevision = savedRevision = 0;
      video.src = state.mediaURL;
      video.load();
      seekBar.value = 0;
      seekBar.max = 0;
      timeCurrent.textContent = timeDuration.textContent = '00:00:00';
      document.getElementById('time-jump-input').value = '';
      document.getElementById('time-jump-error').textContent = '';
      document.getElementById('playback-rate').value = '1';
      switchView('workspace');
      renderSnapshots();
      if (state.warning) showToast(state.warning);
    }

    document.getElementById('btn-select-folder').addEventListener('click', () => withBusy(async () => {
      const workspace = await api.chooseWorkspace();
      if (!workspace) return;
      video.pause();
      video.removeAttribute('src');
      video.load();
      currentVideoId = currentVideoName = '';
      snapshots = [];
      switchView('home');
      renderSnapshots();
      renderHomeGrid(workspace.videos);
      showToast(`${workspace.videos.length}개의 영상을 찾았습니다.`);
    }));

    // --- Fullscreen Feature & Cinematic Controls ---
    let hideControlsTimeout;

    function showFullscreenControls() {
      if (!document.fullscreenElement) return;

      const videoControls = document.getElementById('video-controls');
      videoControls.classList.add('show');
      playerContainer.style.cursor = 'default';

      clearTimeout(hideControlsTimeout);

      // 영상 재생 중일 때만 2.5초 뒤에 컨트롤러와 마우스를 숨김
      hideControlsTimeout = setTimeout(() => {
        if (!video.paused) {
          videoControls.classList.remove('show');
          playerContainer.style.cursor = 'none'; // 마우스 커서 숨김
        }
      }, 2500);
    }

    // 마우스를 움직이거나 클릭하면 컨트롤러 다시 표시
    playerContainer.addEventListener('mousemove', showFullscreenControls);
    playerContainer.addEventListener('click', showFullscreenControls);
    video.addEventListener('play', showFullscreenControls);
    video.addEventListener('pause', showFullscreenControls);

    btnFullscreen.addEventListener('click', async () => {
      try {
        if (!document.fullscreenElement) await playerContainer.requestFullscreen();
        else await document.exitFullscreen();
      } catch (error) { showError(error); }
    });

    document.addEventListener('fullscreenchange', () => {
      const icon = btnFullscreen.querySelector('i');
      const videoControls = document.getElementById('video-controls');
      const videoWrapper = document.getElementById('video-wrapper');

      if (document.fullscreenElement) {
        icon.className = "ph-bold ph-corners-in text-xl";

        // 전체화면 전용 클래스 부착 및 불필요한 배경/여백 제거
        playerContainer.classList.remove('toss-card', 'p-4', 'pb-5', 'bg-white');
        playerContainer.classList.add('bg-black', 'p-0', 'fullscreen-player', 'overflow-hidden');

        videoWrapper.classList.remove('mb-4', 'rounded-xl', 'aspect-video');
        videoWrapper.classList.add('flex-1', 'h-full');

        // 하단 컨트롤바를 영상 위 반투명 블러 스타일로 변경
        videoControls.classList.remove('px-2');
        videoControls.classList.add('fullscreen-controls', 'show');

        showFullscreenControls();
      } else {
        icon.className = "ph-bold ph-corners-out text-xl";

        // 기존 UI 스타일로 복구
        playerContainer.classList.add('toss-card', 'p-4', 'pb-5', 'bg-white');
        playerContainer.classList.remove('bg-black', 'p-0', 'fullscreen-player', 'overflow-hidden');

        videoWrapper.classList.add('mb-4', 'rounded-xl', 'aspect-video');
        videoWrapper.classList.remove('flex-1', 'h-full');

        // 하단 컨트롤바 스타일 복구
        videoControls.classList.remove('fullscreen-controls', 'show');
        videoControls.classList.add('px-2');

        // 상태 초기화
        clearTimeout(hideControlsTimeout);
        playerContainer.style.cursor = 'default';
      }
    });

    // --- Video Controls ---
    const togglePlay = () => {
      if (video.paused) {
        video.play().then(() => {
          playIcon.className = "ph-fill ph-pause text-2xl";
        }).catch(err => console.error(err));
      } else {
        video.pause();
        playIcon.className = "ph-fill ph-play text-2xl";
      }
    };

    document.getElementById('btn-play-pause').addEventListener('click', togglePlay);
    video.addEventListener('click', togglePlay);

    video.addEventListener('loadedmetadata', () => {
      seekBar.max = video.duration;
      timeDuration.textContent = formatTime(video.duration);
      document.getElementById('btn-time-jump').disabled = busy || !Number.isFinite(video.duration);
    });
    video.addEventListener('emptied', () => {
      document.getElementById('btn-time-jump').disabled = true;
      playIcon.className = 'ph-fill ph-play text-2xl';
    });
    video.addEventListener('play', () => { playIcon.className = 'ph-fill ph-pause text-2xl'; });
    video.addEventListener('pause', () => { playIcon.className = 'ph-fill ph-play text-2xl'; });
    video.addEventListener('error', () => showToast('영상을 재생할 수 없습니다. 파일과 코덱을 확인해주세요.'));
    video.addEventListener('timeupdate', () => {
      seekBar.value = video.currentTime;
      timeCurrent.textContent = formatTime(video.currentTime);
    });
    seekBar.addEventListener('input', () => {
      if (Number.isFinite(video.duration)) video.currentTime = Number(seekBar.value);
    });

    const jumpInput = document.getElementById('time-jump-input');
    const jumpError = document.getElementById('time-jump-error');
    jumpInput.addEventListener('input', () => {
      const digitsBeforeCursor = jumpInput.value.slice(0, jumpInput.selectionStart).replace(/\D/g, '').length;
      jumpInput.value = Timecode.formatDigits(jumpInput.value);
      const cursor = Math.min(jumpInput.value.length, digitsBeforeCursor + Math.max(0, Math.floor((digitsBeforeCursor - 1) / 2)));
      jumpInput.setSelectionRange(cursor, cursor);
      jumpInput.removeAttribute('aria-invalid');
      jumpError.textContent = '';
    });
    document.getElementById('time-jump-form').addEventListener('submit', event => {
      event.preventDefault();
      if (busy) return;
      const seconds = Timecode.parse(jumpInput.value);
      let message = '';
      if (!currentVideoId || !Number.isFinite(video.duration)) message = '영상 로딩이 끝난 뒤 이동해주세요.';
      else if (seconds === null) message = '시·분·초를 숫자 6자리로 입력해주세요. 분과 초는 00~59입니다.';
      else if (seconds > video.duration) message = `영상 길이(${formatTime(video.duration)}) 안의 시간을 입력해주세요.`;
      if (message) {
        jumpError.textContent = message;
        jumpInput.setAttribute('aria-invalid', 'true');
        return;
      }
      video.currentTime = seconds;
      jumpInput.removeAttribute('aria-invalid');
      jumpError.textContent = '';
      showToast(`${Timecode.format(seconds)} 위치로 이동했습니다.`);
    });

    // --- Playback Rate Control ---
    document.getElementById('playback-rate').addEventListener('change', (e) => {
      video.playbackRate = parseFloat(e.target.value);
    });

    // --- Auto Crop Bounds Calculation ---
    function getCropBounds(ctx, width, height) {
      const imageData = ctx.getImageData(0, 0, width, height);
      const data = imageData.data;
      let top = 0, bottom = height - 1, left = 0, right = width - 1;
      const threshold = 15; // RGB 값이 모두 이 수치 이하이면 검은색으로 간주

      function isRowBlack(y) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (data[i] > threshold || data[i + 1] > threshold || data[i + 2] > threshold) return false;
        }
        return true;
      }

      function isColBlack(x, t, b) {
        for (let y = t; y <= b; y++) {
          const i = (y * width + x) * 4;
          if (data[i] > threshold || data[i + 1] > threshold || data[i + 2] > threshold) return false;
        }
        return true;
      }

      while (top < height && isRowBlack(top)) top++;
      while (bottom > top && isRowBlack(bottom)) bottom--;
      while (left < width && isColBlack(left, top, bottom)) left++;
      while (right > left && isColBlack(right, top, bottom)) right--;

      // 전체가 검은 화면인 경우 원본 유지
      if (top >= bottom || left >= right) return { x: 0, y: 0, w: width, h: height };

      return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
    }

    // Captures are JPEG data from the local video, saved by the native process.
    async function captureFrame() {
      if (!currentVideoId || busy) return;
      if (video.readyState < 2 || !video.videoWidth || video.seeking) {
        showToast('영상 로딩이나 이동이 끝난 뒤 캡처해주세요.');
        return;
      }
      await withBusy(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0);
        let finalCanvas = canvas;
        if (document.getElementById('auto-crop-checkbox').checked) {
          const bounds = getCropBounds(ctx, canvas.width, canvas.height);
          if (bounds.w !== canvas.width || bounds.h !== canvas.height) {
            finalCanvas = document.createElement('canvas');
            finalCanvas.width = bounds.w;
            finalCanvas.height = bounds.h;
            finalCanvas.getContext('2d').drawImage(canvas, bounds.x, bounds.y, bounds.w, bounds.h, 0, 0, bounds.w, bounds.h);
          }
        }
        const item = await api.capture(currentVideoId, finalCanvas.toDataURL('image/jpeg', 0.9), video.currentTime);
        snapshots.push(item);
        renderSnapshots();
        const flash = document.getElementById('flash-overlay');
        flash.classList.remove('flash-active');
        void flash.offsetWidth;
        flash.classList.add('flash-active');
        showToast('캡처 이미지를 로컬 작업 폴더에 저장했습니다.');
        snapshotList.scrollTop = snapshotList.scrollHeight;
      });
    }
    document.getElementById('btn-capture').addEventListener('click', captureFrame);

    window.addEventListener('keydown', (e) => {
      const tag = e.target.tagName.toLowerCase();
      if (!currentVideoId || busy || !drawModal.classList.contains('hidden') || tag === 'select' || tag === 'button') return;
      if (tag === 'textarea' || tag === 'input') return; // 텍스트 입력 중일 때 예외 처리

      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      }
      else if (e.code === 'KeyC') {
        e.preventDefault();
        captureFrame();
      }
      else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 5);
      }
      else if (e.code === 'ArrowRight') {
        e.preventDefault();
        video.currentTime = Math.min(video.duration, video.currentTime + 5);
      }
      else if (e.key === ',' || e.key === '<') {
        e.preventDefault();
        const newRate = Math.max(0.5, video.playbackRate - 0.25);
        video.playbackRate = newRate;
        document.getElementById('playback-rate').value = newRate; // UI 동기화
        showToast(`재생 속도: ${newRate}x`);
      }
      else if (e.key === '.' || e.key === '>') {
        e.preventDefault();
        const newRate = Math.min(2.0, video.playbackRate + 0.25);
        video.playbackRate = newRate;
        document.getElementById('playback-rate').value = newRate; // UI 동기화
        showToast(`재생 속도: ${newRate}x`);
      }
      else if (e.code === 'KeyF') {
        e.preventDefault();
        btnFullscreen.click();
      }
    });

    // --- Snapshot UI Rendering & Drag and Drop ---
    function renderSnapshots() {
      countBadge.textContent = snapshots.length;
      document.getElementById('btn-restore').classList.toggle('hidden', !hasArchived);

      if (snapshots.length === 0) {
        emptyState.style.display = 'flex';
        document.querySelectorAll('.snapshot-card').forEach(c => c.remove());
        return;
      }

      emptyState.style.display = 'none';
      document.querySelectorAll('.snapshot-card').forEach(c => c.remove());

      snapshots.forEach((snap, index) => {
        const card = document.createElement('div');
        card.draggable = true;
        card.className = 'snapshot-card bg-white p-4 rounded-xl border border-toss-grey200 shadow-sm flex flex-col gap-3 relative group transition-all cursor-move';
        card.dataset.index = index;

        card.innerHTML = `
          <div class="flex gap-4 items-start">
            <div class="mt-8 text-toss-grey300 group-hover:text-toss-grey500 flex-shrink-0">
              <i class="ph ph-dots-six-vertical text-xl"></i>
            </div>
            <div class="w-40 bg-toss-grey100 rounded-lg overflow-hidden flex-shrink-0 relative border border-toss-grey200 cursor-pointer hover:border-toss-blue transition" data-action="seek">
              <img class="w-full h-auto aspect-video object-cover pointer-events-none" alt="Captured Frame">
              <div class="absolute bottom-1 right-1 bg-black bg-opacity-70 text-white text-[10px] px-1.5 py-0.5 rounded font-mono font-bold pointer-events-none">
                ${formatTime(snap.time)}
              </div>
            </div>
            
            <div class="flex-1 flex flex-col">
              <textarea 
                class="w-full flex-1 bg-toss-grey50 border border-transparent focus:border-toss-blue hover:bg-toss-grey100 focus:bg-white rounded-lg p-3 t6 text-toss-grey900 outline-none resize-none transition" 
                placeholder="메모를 입력" maxlength="10000"></textarea>
            </div>
          </div>
          
          <div class="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition">
            <button class="draw-btn w-8 h-8 rounded-full bg-white text-toss-grey500 border border-toss-grey200 flex items-center justify-center hover:text-toss-blue hover:border-toss-blue shadow-sm transition cursor-pointer" title="화면에 그리기">
              <i class="ph-bold ph-pencil-simple text-lg pointer-events-none"></i>
            </button>
            <button class="delete-btn w-8 h-8 rounded-full bg-white text-toss-grey400 border border-toss-grey200 flex items-center justify-center hover:text-toss-red hover:border-toss-red shadow-sm transition cursor-pointer" title="삭제 (폴더에서도 완전히 삭제됩니다)">
              <i class="ph ph-trash text-lg pointer-events-none"></i>
            </button>
          </div>
        `;

        card.querySelector('img').src = snap.image;
        card.querySelector('[data-action="seek"]').addEventListener('click', () => {
          video.currentTime = snap.time;
          video.pause();
        });
        const textarea = card.querySelector('textarea');
        textarea.value = snap.note;
        textarea.addEventListener('input', event => {
          snap.note = event.target.value;
          editRevision++;
          clearTimeout(noteTimer);
          noteTimer = setTimeout(() => serialSave(), 300);
        });
        textarea.addEventListener('blur', () => serialSave());

      card.querySelector('.draw-btn').addEventListener('click', () => {
        if (window.openDrawModal) window.openDrawModal(index);
      });

      card.querySelector('.delete-btn').addEventListener('click', () => {
        if (!confirm('이 캡처 이미지를 목록과 로컬 폴더에서 완전히 삭제하시겠습니까?')) return;
        withBusy(async () => {
          await api.deleteSnapshot(currentVideoId, snap.id);
          snapshots = snapshots.filter(item => item.id !== snap.id);
          renderSnapshots();
        });
      });

      card.addEventListener('dragstart', (e) => {
        draggedItemIndex = index;
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => card.classList.add('dragging'), 0);
      });

      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        draggedItemIndex = null;
        document.querySelectorAll('.snapshot-card').forEach(c => c.classList.remove('drag-over'));
      });

      card.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const bounding = card.getBoundingClientRect();
        const offset = bounding.y + (bounding.height / 2);
        if (e.clientY - offset > 0) { card.style.borderBottom = "4px solid #3182F6"; card.style.borderTop = ""; }
        else { card.style.borderTop = "4px solid #3182F6"; card.style.borderBottom = ""; }
      });

      card.addEventListener('dragleave', () => { card.style.borderTop = ""; card.style.borderBottom = ""; });

      card.addEventListener('drop', (e) => {
        e.preventDefault();
        card.style.borderTop = ""; card.style.borderBottom = "";
        if (busy || draggedItemIndex === null || draggedItemIndex === index) return;

        const bounding = card.getBoundingClientRect();
        const offset = bounding.y + (bounding.height / 2);
        let targetIndex = index;
        if (e.clientY - offset > 0) targetIndex = index + 1;
        if (draggedItemIndex < targetIndex) targetIndex--;

        const item = snapshots.splice(draggedItemIndex, 1)[0];
        snapshots.splice(targetIndex, 0, item);
        editRevision++;
        renderSnapshots();
        serialSave();
      });

      snapshotList.appendChild(card);
    });
  }

    // Render all note lines, continuing onto additional pages when necessary.
    document.getElementById('btn-export-pdf').addEventListener('click', () => withBusy(async () => {
      if (!snapshots.length) { showToast('먼저 화면을 캡처해주세요.'); return; }
      const exportId = currentVideoId;
      const exportName = currentVideoName;
      const items = snapshots.map(item => ({ ...item }));
      const btn = document.getElementById('btn-export-pdf');
      const originalText = btn.innerHTML;
      btn.textContent = 'PDF 생성 중…';
      try {
        await document.fonts.ready;
        const doc = new window.jspdf.jsPDF('l', 'mm', 'a4');
        const width = 297, height = 210, scale = 5, margin = 15;
        let pageNumber = 0;
        function newPage(time) {
          const canvas = document.createElement('canvas');
          canvas.width = width * scale;
          canvas.height = height * scale;
          const ctx = canvas.getContext('2d');
          ctx.scale(scale, scale);
          ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height);
          ctx.fillStyle = '#666666'; ctx.font = '600 5px Pretendard, sans-serif';
          ctx.fillText(exportName, margin, 15, width - margin * 2);
          ctx.font = '4px Pretendard, sans-serif';
          ctx.fillText(`재생 시간: ${formatTime(time)}`, margin, 23);
          return { canvas, ctx };
        }
        function finish(page) {
          pageNumber++;
          page.ctx.font = '4px Pretendard, sans-serif';
          page.ctx.fillStyle = '#999999'; page.ctx.textAlign = 'center';
          page.ctx.fillText(`- ${pageNumber} -`, width / 2, height - 8);
          if (pageNumber > 1) doc.addPage();
          doc.addImage(page.canvas.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, width, height);
        }
        for (const item of items) {
          let page = newPage(item.time);
          const image = await new Promise((resolve, reject) => {
            const img = new Image(); img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('캡처 이미지를 불러오지 못했습니다.'));
            img.src = item.image;
          });
          const factor = Math.min((width - margin * 2) / image.width, 125 / image.height);
          const imageWidth = image.width * factor, imageHeight = image.height * factor;
          page.ctx.drawImage(image, (width - imageWidth) / 2, 30, imageWidth, imageHeight);
          let y = 30 + imageHeight + 10;
          page.ctx.font = '5px Pretendard, sans-serif';
          const lines = [];
          for (const paragraph of item.note.split('\n')) {
            let line = '';
            for (const character of Array.from(paragraph)) {
              if (line && page.ctx.measureText(line + character).width > width - margin * 2) {
                lines.push(line); line = '';
              }
              line += character;
            }
            lines.push(line);
          }
          for (const line of lines) {
            if (y > height - 20) { finish(page); page = newPage(item.time); y = 35; }
            page.ctx.font = '5px Pretendard, sans-serif';
            page.ctx.fillStyle = '#333333';
            page.ctx.fillText(line, margin, y);
            y += 8;
          }
          finish(page);
        }
        const result = await api.savePDF(exportId, doc.output('arraybuffer'));
        showToast(`PDF를 저장했습니다: ${result.path}`);
      } finally { btn.innerHTML = originalText; }
    }));

    document.getElementById('btn-reset').addEventListener('click', () => {
      if (!snapshots.length || !confirm('현재 캡처 목록을 비우시겠습니까? 이미지와 메모는 보관되며 “보관 목록 복원”으로 다시 가져올 수 있습니다.')) return;
      withBusy(async () => {
        const result = await api.reset(currentVideoId);
        snapshots = [];
        hasArchived = result.hasArchived;
        renderSnapshots();
        showToast('이미지와 메모를 보관하고 목록을 비웠습니다.');
      });
    });
    document.getElementById('btn-restore').addEventListener('click', () => withBusy(async () => {
      const state = await api.restoreSnapshots(currentVideoId);
      snapshots = state.snapshots; hasArchived = state.hasArchived;
      renderSnapshots();
      showToast('보관한 캡처와 메모를 복원했습니다.');
    }));

    (async function restoreLastWorkspace() {
      if (!api) { showToast('앱을 실행해 로컬 작업 폴더를 선택해주세요.'); return; }
      const loader = document.getElementById('global-loader');
      loader.classList.remove('hidden'); loader.classList.add('flex');
      try {
        const workspace = await api.restoreWorkspace();
        if (workspace) renderHomeGrid(workspace.videos);
      } catch (error) { showError(error); }
      finally { loader.classList.add('hidden'); loader.classList.remove('flex'); }
    })();

    // --- Drawing Modal Logic ---
    const drawModal = document.getElementById('drawing-modal');
    const bgCanvas = document.getElementById('bg-canvas');
    const drawCanvas = document.getElementById('draw-canvas');
    const bgCtx = bgCanvas ? bgCanvas.getContext('2d') : null;
    const drawCtx = drawCanvas ? drawCanvas.getContext('2d', { willReadFrequently: true }) : null;

    let currentDrawingIndex = -1;
    let isDrawing = false;
    let drawColor = '#EF4444';
    let drawSize = 4;
    let isEraser = false;

    if (drawModal && bgCanvas && drawCanvas) {
      document.querySelectorAll('#draw-colors button').forEach(btn => {
        btn.addEventListener('click', (e) => {
          document.querySelectorAll('#draw-colors button').forEach(b => b.classList.remove('active-color', 'border-black'));
          btn.classList.add('active-color', 'border-black');
          drawColor = btn.dataset.color;
          isEraser = false;
          document.getElementById('btn-draw-eraser').classList.remove('bg-toss-grey200', 'text-toss-grey900');
          document.getElementById('draw-canvas-wrapper').style.cursor = 'crosshair';
        });
      });

      document.getElementById('draw-size').addEventListener('input', (e) => {
        drawSize = e.target.value;
      });

      document.getElementById('btn-draw-eraser').addEventListener('click', (e) => {
        isEraser = true;
        document.querySelectorAll('#draw-colors button').forEach(b => b.classList.remove('active-color', 'border-black'));
        e.currentTarget.classList.add('bg-toss-grey200', 'text-toss-grey900');
        document.getElementById('draw-canvas-wrapper').style.cursor = 'cell';
      });

      document.getElementById('btn-draw-clear').addEventListener('click', () => {
        drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
      });

      function getCanvasPos(e) {
        const rect = drawCanvas.getBoundingClientRect();
        const scaleX = drawCanvas.width / rect.width;
        const scaleY = drawCanvas.height / rect.height;
        return {
          x: (e.clientX - rect.left) * scaleX,
          y: (e.clientY - rect.top) * scaleY
        };
      }

      drawCanvas.addEventListener('mousedown', (e) => {
        isDrawing = true;
        const pos = getCanvasPos(e);
        drawCtx.beginPath();
        drawCtx.moveTo(pos.x, pos.y);
        drawCtx.lineCap = 'round';
        drawCtx.lineJoin = 'round';
      });

      drawCanvas.addEventListener('mousemove', (e) => {
        if (!isDrawing) return;
        const pos = getCanvasPos(e);
        drawCtx.lineTo(pos.x, pos.y);

        if (isEraser) {
          drawCtx.globalCompositeOperation = 'destination-out';
          drawCtx.lineWidth = drawSize * 2;
          drawCtx.stroke();
        } else {
          drawCtx.globalCompositeOperation = 'source-over';
          drawCtx.strokeStyle = drawColor;
          drawCtx.lineWidth = drawSize;
          drawCtx.stroke();
        }
      });

      const stopDrawing = () => {
        if (isDrawing) drawCtx.closePath();
        isDrawing = false;
      };

      drawCanvas.addEventListener('mouseup', stopDrawing);
      drawCanvas.addEventListener('mouseleave', stopDrawing);

      window.openDrawModal = function (index) {
        currentDrawingIndex = index;
        const snap = snapshots[index];
        const img = new Image();
        
        drawModal.classList.remove('hidden'); // 모달을 먼저 표시해야 DOM 크기가 유효함

        img.onload = () => {
          bgCanvas.width = img.width;
          bgCanvas.height = img.height;
          drawCanvas.width = img.width;
          drawCanvas.height = img.height;

          // CSS가 max-width/max-height 비율을 자동 계산하도록 기존 인라인 스타일 초기화
          drawCanvas.style.width = '';
          drawCanvas.style.height = '';
          bgCanvas.style.width = '';
          bgCanvas.style.height = '';

          bgCtx.drawImage(img, 0, 0);
          drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
        };
        img.src = snap.image;
      };

      document.getElementById('btn-draw-cancel').addEventListener('click', () => {
        drawModal.classList.add('hidden');
      });

      document.getElementById('btn-draw-save').addEventListener('click', () => withBusy(async () => {
        if (currentDrawingIndex === -1) return;
        bgCtx.drawImage(drawCanvas, 0, 0);
        const dataUrl = bgCanvas.toDataURL('image/jpeg', 0.9);
        const snap = snapshots[currentDrawingIndex];
        await api.saveDrawing(currentVideoId, snap.id, dataUrl);
        snap.image = dataUrl;
        renderSnapshots();
        drawModal.classList.add('hidden');
        currentDrawingIndex = -1;
      }));
    }
