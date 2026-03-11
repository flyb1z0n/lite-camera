if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js");
}

(function () {
  "use strict";

  // --- DOM refs ---
  const video = document.getElementById("viewfinder");
  const cameraSelect = document.getElementById("camera-select");
  const captureBtn = document.getElementById("capture-btn");
  const timerButtons = document.querySelectorAll(".btn-timer");
  const countdownOverlay = document.getElementById("countdown-overlay");
  const flashOverlay = document.getElementById("flash-overlay");
  const filmstrip = document.getElementById("filmstrip");
  const lightbox = document.getElementById("lightbox");
  const lightboxImg = document.getElementById("lightbox-img");
  const lightboxDelete = document.getElementById("lightbox-delete");
  const lightboxClose = document.getElementById("lightbox-close");
  const errorMessage = document.getElementById("error-message");
  const errorText = document.getElementById("error-text");
  const errorAction = document.getElementById("error-action");
  const folderBanner = document.getElementById("folder-banner");
  const pickFolderBtn = document.getElementById("pick-folder-btn");
  const unsupportedOverlay = document.getElementById("unsupported-overlay");

  // --- State ---
  let currentStream = null;
  let timerSeconds = 0;
  let countdownInterval = null;
  let dirHandle = null;
  let photos = []; // { name, thumbUrl, fileHandle } or { name, thumbUrl, blob } in IDB mode
  let lightboxIndex = -1;

  // --- Storage mode ---
  const hasFileSystemAccess = "showDirectoryPicker" in window;

  // --- Init ---
  init();

  async function init() {
    if (hasFileSystemAccess) {
      await restoreDirHandle();
    }
    updateFolderBanner();
    const savedDeviceId = localStorage.getItem("lite-camera-deviceId");
    await startCamera(savedDeviceId || undefined);
    await loadPhotosFromDir();
    bindEvents();
  }

  // --- File System Access: persist directory handle in IndexedDB ---
  function openHandleDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("lite-camera-handles", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("handles");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function persistDirHandle(handle) {
    const db = await openHandleDB();
    const tx = db.transaction("handles", "readwrite");
    tx.objectStore("handles").put(handle, "dir");
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async function restoreDirHandle() {
    try {
      const db = await openHandleDB();
      const tx = db.transaction("handles", "readonly");
      const req = tx.objectStore("handles").get("dir");
      const handle = await new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      if (handle) {
        // Always restore the handle — permission will be requested on user gesture if needed
        dirHandle = handle;
      }
    } catch {
      // No stored handle or permission denied — that's fine
    }
    updateFolderBanner();
  }

  // --- IndexedDB photo storage (fallback when File System Access API unavailable) ---
  function openPhotoDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("lite-camera-photos", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("photos", { keyPath: "name" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function savePhotoToIDB(name, blob, thumbUrl) {
    const db = await openPhotoDB();
    const tx = db.transaction("photos", "readwrite");
    tx.objectStore("photos").put({ name, blob, thumbUrl, timestamp: Date.now() });
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async function loadPhotosFromIDB() {
    const db = await openPhotoDB();
    const tx = db.transaction("photos", "readonly");
    const req = tx.objectStore("photos").getAll();
    const records = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    records.sort((a, b) => b.timestamp - a.timestamp);
    photos = records.map((r) => ({ name: r.name, thumbUrl: r.thumbUrl, blob: r.blob }));
    renderFilmstrip();
  }

  async function deletePhotoFromIDB(name) {
    const db = await openPhotoDB();
    const tx = db.transaction("photos", "readwrite");
    tx.objectStore("photos").delete(name);
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async function pickDirectory() {
    try {
      dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      await persistDirHandle(dirHandle);
      updateFolderBanner();
      await loadPhotosFromDir();
    } catch (err) {
      if (err.name !== "AbortError") {
        console.error("Failed to pick directory:", err);
      }
    }
  }

  async function ensureDirHandle() {
    if (dirHandle) {
      const perm = await dirHandle.requestPermission({ mode: "readwrite" });
      if (perm === "granted") return true;
    }
    await pickDirectory();
    return dirHandle !== null;
  }

  function updateFolderBanner() {
    if (!hasFileSystemAccess) {
      folderBanner.classList.add("hidden");
      return;
    }
    folderBanner.classList.toggle("hidden", dirHandle !== null);
  }

  // --- Camera ---
  async function startCamera(deviceId) {
    try {
      if (currentStream) {
        currentStream.getTracks().forEach((t) => t.stop());
      }

      const constraints = {
        video: {
          width: { ideal: 3840 },
          height: { ideal: 2160 },
          aspectRatio: { ideal: 16 / 9 },
        },
        audio: false,
      };

      if (deviceId) {
        constraints.video.deviceId = { exact: deviceId };
      }

      currentStream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = currentStream;

      hideError();
      await refreshCameraList();
    } catch (err) {
      if (deviceId && err.name === "OverconstrainedError") {
        localStorage.removeItem("lite-camera-deviceId");
        return startCamera();
      }
      showError(
        err.name === "NotAllowedError"
          ? "Camera access was denied. Please allow camera access in your browser settings and try again."
          : "No camera found. Please connect a camera and try again.",
        () => startCamera(deviceId)
      );
    }
  }

  async function refreshCameraList() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((d) => d.kind === "videoinput");

    const activeTrack = currentStream?.getVideoTracks()[0];
    const activeDeviceId = activeTrack?.getSettings().deviceId;

    cameraSelect.innerHTML = "";
    cameras.forEach((cam, i) => {
      const opt = document.createElement("option");
      opt.value = cam.deviceId;
      const label = (cam.label || `Camera ${i + 1}`).replace(/\s*\([\da-f]{4}:[\da-f]{4}\)\s*/gi, "").trim();
      opt.textContent = label;
      if (cam.deviceId === activeDeviceId) opt.selected = true;
      cameraSelect.appendChild(opt);
    });
  }

  navigator.mediaDevices.addEventListener("devicechange", async () => {
    await refreshCameraList();
  });

  // --- Error display ---
  function showError(message, retryFn) {
    errorText.textContent = message;
    errorMessage.classList.remove("hidden");
    errorAction.onclick = () => {
      hideError();
      retryFn();
    };
  }

  function hideError() {
    errorMessage.classList.add("hidden");
  }

  // --- Timer ---
  function setTimer(seconds) {
    if (timerSeconds === seconds) {
      timerSeconds = 0;
    } else {
      timerSeconds = seconds;
    }
    timerButtons.forEach((btn) => {
      btn.classList.toggle(
        "active",
        parseInt(btn.dataset.seconds) === timerSeconds
      );
    });
  }

  function startCountdown() {
    return new Promise((resolve) => {
      let remaining = timerSeconds;
      captureBtn.classList.add("cancel");

      function tick() {
        if (remaining <= 0) {
          countdownOverlay.classList.add("hidden");
          captureBtn.classList.remove("cancel");
          countdownInterval = null;
          resolve(true);
          return;
        }
        countdownOverlay.textContent = remaining;
        countdownOverlay.classList.remove("hidden");
        playTickSound();
        // Re-trigger animation
        countdownOverlay.style.animation = "none";
        countdownOverlay.offsetHeight; // force reflow
        countdownOverlay.style.animation = "";
        remaining--;
        countdownInterval = setTimeout(tick, 1000);
      }

      tick();
    });
  }

  function cancelCountdown() {
    if (countdownInterval !== null) {
      clearTimeout(countdownInterval);
      countdownInterval = null;
      countdownOverlay.classList.add("hidden");
      captureBtn.classList.remove("cancel");
    }
  }

  // --- Shutter sound ---
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  function playTickSound() {
    const now = audioCtx.currentTime;
    const len = 0.06;
    const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * len, audioCtx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const t = i / audioCtx.sampleRate;
      data[i] = Math.sin(2 * Math.PI * 800 * t) * Math.exp(-t * 60) * 0.4;
    }
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    src.start(now);
  }

  function playShutterSound() {
    const now = audioCtx.currentTime;

    // --- First click (shutter open) ---
    const clickLen = 0.015;
    const clickBuf = audioCtx.createBuffer(1, audioCtx.sampleRate * clickLen, audioCtx.sampleRate);
    const clickData = clickBuf.getChannelData(0);
    for (let i = 0; i < clickData.length; i++) {
      const t = i / clickData.length;
      // Sharp transient — exponential decay with a subtle sine thump
      clickData[i] = (Math.random() * 2 - 1) * Math.exp(-t * 30) * 0.6
        + Math.sin(2 * Math.PI * 1200 * t) * Math.exp(-t * 40) * 0.3;
    }

    const click1 = audioCtx.createBufferSource();
    click1.buffer = clickBuf;

    const click1Filter = audioCtx.createBiquadFilter();
    click1Filter.type = "highpass";
    click1Filter.frequency.value = 1500;

    const click1Gain = audioCtx.createGain();
    click1Gain.gain.setValueAtTime(0.6, now);

    click1.connect(click1Filter);
    click1Filter.connect(click1Gain);
    click1Gain.connect(audioCtx.destination);
    click1.start(now);

    // --- Mechanical body resonance (subtle) ---
    const bodyOsc = audioCtx.createOscillator();
    bodyOsc.type = "sine";
    bodyOsc.frequency.setValueAtTime(600, now);
    bodyOsc.frequency.exponentialRampToValueAtTime(300, now + 0.02);

    const bodyGain = audioCtx.createGain();
    bodyGain.gain.setValueAtTime(0.05, now);
    bodyGain.gain.exponentialRampToValueAtTime(0.001, now + 0.02);

    bodyOsc.connect(bodyGain);
    bodyGain.connect(audioCtx.destination);
    bodyOsc.start(now);
    bodyOsc.stop(now + 0.03);

    // --- Second click (shutter close) — slightly delayed ---
    const click2 = audioCtx.createBufferSource();
    click2.buffer = clickBuf;

    const click2Filter = audioCtx.createBiquadFilter();
    click2Filter.type = "highpass";
    click2Filter.frequency.value = 1800;

    const click2Gain = audioCtx.createGain();
    click2Gain.gain.setValueAtTime(0.4, now + 0.04);

    click2.connect(click2Filter);
    click2Filter.connect(click2Gain);
    click2Gain.connect(audioCtx.destination);
    click2.start(now + 0.04);
  }

  // --- Capture ---
  let isCapturing = false;

  async function capture() {
    if (isCapturing) {
      cancelCountdown();
      isCapturing = false;
      return;
    }

    isCapturing = true;

    if (timerSeconds > 0) {
      const completed = await startCountdown();
      if (!completed) {
        isCapturing = false;
        return;
      }
    }

    // Capture frame to canvas
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");

    ctx.drawImage(video, 0, 0);

    // Flash + shutter sound
    flashOverlay.classList.add("active");
    setTimeout(() => flashOverlay.classList.remove("active"), 150);
    playShutterSound();

    // Export as PNG blob
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));

    // Generate filename
    const now = new Date();
    const name = `photo-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;

    // Save to disk or IndexedDB
    if (!hasFileSystemAccess) {
      try {
        const thumbUrl = await createThumbnail(blob);
        await savePhotoToIDB(name, blob, thumbUrl);
        photos.unshift({ name, thumbUrl, blob });
        renderFilmstrip();
      } catch (err) {
        console.error("Failed to save photo to IndexedDB:", err);
      }
    } else {
      const hasDirHandle = await ensureDirHandle();
      if (hasDirHandle) {
        try {
          const fileHandle = await dirHandle.getFileHandle(name, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(blob);
          await writable.close();

          // Generate thumbnail
          const thumbUrl = await createThumbnail(blob);
          const photo = { name, thumbUrl, fileHandle };
          photos.unshift(photo);
          renderFilmstrip();
        } catch (err) {
          console.error("Failed to save photo:", err);
          // Directory might be gone — reset handle and re-prompt
          dirHandle = null;
          updateFolderBanner();
        }
      }
    }

    isCapturing = false;
  }

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  async function createThumbnail(blob) {
    const img = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    const scale = 200 / img.width;
    canvas.width = 200;
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    img.close();
    return canvas.toDataURL("image/jpeg", 0.7);
  }

  // --- Filmstrip ---
  function addFilmstripItem(photo, index) {
    // Remove empty message if present
    const empty = filmstrip.querySelector(".filmstrip-empty");
    if (empty) empty.remove();

    const item = document.createElement("div");
    item.className = "filmstrip-item";
    item.dataset.index = index;

    const img = document.createElement("img");
    img.src = photo.thumbUrl;
    img.alt = photo.name;
    item.appendChild(img);

    item.addEventListener("click", () => openLightbox(index));
    filmstrip.prepend(item);

    // Scroll to newest (leftmost)
    filmstrip.scrollLeft = 0;
  }

  function renderFilmstrip() {
    filmstrip.innerHTML = "";
    if (photos.length === 0) {
      const empty = document.createElement("div");
      empty.className = "filmstrip-empty";
      empty.textContent = "No photos yet — capture one!";
      filmstrip.appendChild(empty);
      return;
    }
    // Photos array is already sorted newest-first, render in order
    photos.forEach((photo, i) => {
      const empty = filmstrip.querySelector(".filmstrip-empty");
      if (empty) empty.remove();

      const item = document.createElement("div");
      item.className = "filmstrip-item";
      item.dataset.index = i;

      const img = document.createElement("img");
      img.src = photo.thumbUrl;
      img.alt = photo.name;
      item.appendChild(img);

      item.addEventListener("click", () => openLightbox(i));
      filmstrip.appendChild(item);
    });
  }

  async function loadPhotosFromDir() {
    photos = [];
    if (!hasFileSystemAccess) {
      await loadPhotosFromIDB();
      return;
    }
    if (!dirHandle) {
      renderFilmstrip();
      return;
    }

    // Check permission before trying to read
    const perm = await dirHandle.queryPermission({ mode: "readwrite" });
    if (perm !== "granted") {
      renderFilmstrip();
      return;
    }

    try {
      const entries = [];
      for await (const entry of dirHandle.values()) {
        if (entry.kind === "file" && entry.name.endsWith(".png") && entry.name.startsWith("photo-")) {
          entries.push(entry);
        }
      }

      // Read file metadata to sort by creation date
      const filesWithMeta = [];
      for (const fileHandle of entries) {
        try {
          const file = await fileHandle.getFile();
          filesWithMeta.push({ fileHandle, file, lastModified: file.lastModified });
        } catch (err) {
          console.warn("Skipping unreadable file:", fileHandle.name, err);
        }
      }

      // Sort by date descending (newest first)
      filesWithMeta.sort((a, b) => b.lastModified - a.lastModified);

      for (const { fileHandle, file } of filesWithMeta) {
        try {
          const thumbUrl = await createThumbnail(file);
          photos.push({ name: fileHandle.name, thumbUrl, fileHandle });
        } catch (err) {
          console.warn("Skipping unreadable file:", fileHandle.name, err);
        }
      }
    } catch (err) {
      console.error("Failed to load photos from directory:", err);
      dirHandle = null;
      updateFolderBanner();
    }

    renderFilmstrip();
  }

  // --- Lightbox ---
  function openLightbox(index) {
    lightboxIndex = index;
    const photo = photos[index];

    // Load full-res image from file handle or IDB blob
    if (photo.fileHandle) {
      photo.fileHandle.getFile().then((file) => {
        const url = URL.createObjectURL(file);
        lightboxImg.onload = () => URL.revokeObjectURL(url);
        lightboxImg.src = url;
      });
    } else {
      const url = URL.createObjectURL(photo.blob);
      lightboxImg.onload = () => URL.revokeObjectURL(url);
      lightboxImg.src = url;
    }

    lightbox.classList.remove("hidden");
    lightboxDelete.textContent = "Delete";
    lightboxDelete.classList.remove("confirm");

    // Mark selected in filmstrip
    filmstrip.querySelectorAll(".filmstrip-item").forEach((el) => {
      el.classList.toggle("selected", parseInt(el.dataset.index) === index);
    });
  }

  function closeLightbox() {
    lightbox.classList.add("hidden");
    lightboxIndex = -1;
    filmstrip.querySelectorAll(".filmstrip-item").forEach((el) => {
      el.classList.remove("selected");
    });
  }

  async function deleteCurrentPhoto() {
    if (lightboxIndex < 0) return;
    if (hasFileSystemAccess && !dirHandle) return;

    // Two-click confirmation
    if (!lightboxDelete.classList.contains("confirm")) {
      lightboxDelete.textContent = "Confirm Delete";
      lightboxDelete.classList.add("confirm");
      return;
    }

    const photo = photos[lightboxIndex];
    try {
      if (hasFileSystemAccess) {
        await dirHandle.removeEntry(photo.name);
      } else {
        await deletePhotoFromIDB(photo.name);
      }
    } catch (err) {
      console.error("Failed to delete photo:", err);
    }

    photos.splice(lightboxIndex, 1);
    closeLightbox();
    renderFilmstrip();
  }

  function navigateLightbox(direction) {
    if (lightboxIndex < 0 || photos.length === 0) return;
    let next = lightboxIndex + direction;
    if (next < 0) next = photos.length - 1;
    if (next >= photos.length) next = 0;
    openLightbox(next);
  }

  // --- Fullscreen ---
  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen();
    }
  }


  // --- Events ---
  function bindEvents() {
    cameraSelect.addEventListener("change", (e) => {
      localStorage.setItem("lite-camera-deviceId", e.target.value);
      startCamera(e.target.value);
    });

    timerButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        setTimer(parseInt(btn.dataset.seconds));
      });
    });

    captureBtn.addEventListener("click", capture);
    if (hasFileSystemAccess) {
      pickFolderBtn.addEventListener("click", pickDirectory);
    }

    const filmstripToggle = document.getElementById("filmstrip-toggle");
    const filmstripContainer = document.querySelector(".filmstrip-container");
    if (localStorage.getItem("lite-camera-filmstrip-hidden") === "true") {
      filmstripContainer.classList.add("hidden");
      filmstripToggle.classList.add("collapsed");
    }
    filmstripToggle.addEventListener("click", () => {
      const hidden = filmstripContainer.classList.toggle("hidden");
      filmstripToggle.classList.toggle("collapsed", hidden);
      localStorage.setItem("lite-camera-filmstrip-hidden", hidden);
    });



    lightboxClose.addEventListener("click", closeLightbox);
    lightboxDelete.addEventListener("click", deleteCurrentPhoto);

    lightbox.querySelector(".lightbox-backdrop").addEventListener("click", closeLightbox);

    document.addEventListener("keydown", (e) => {
      // Don't handle keys if there's an input focused
      if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;

      switch (e.code) {
        case "Space":
          e.preventDefault();
          capture();
          break;
        case "Escape":
          if (!lightbox.classList.contains("hidden")) {
            closeLightbox();
          } else if (isCapturing) {
            cancelCountdown();
            isCapturing = false;
          }
          break;
        case "KeyF":
          toggleFullscreen();
          break;
        case "ArrowLeft":
          if (!lightbox.classList.contains("hidden")) {
            e.preventDefault();
            navigateLightbox(-1);
          }
          break;
        case "ArrowRight":
          if (!lightbox.classList.contains("hidden")) {
            e.preventDefault();
            navigateLightbox(1);
          }
          break;
      }
    });
  }
})();
