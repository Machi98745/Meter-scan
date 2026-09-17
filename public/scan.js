/* Meter Scan — อ่านเลขมิเตอร์จากภาพกล้องด้วย Tesseract.js (ทำงานในเครื่องผู้ใช้ทั้งหมด)
   ขั้นตอน: ดึงเฟรมจากกล้อง -> ตัดเฉพาะกรอบเล็ง -> ขยาย -> เทาและ threshold (Otsu)
            -> OCR เฉพาะตัวเลข -> ตรวจรูปแบบ -> ต้องได้ค่าเดิมซ้ำ 2 ครั้งจึงยอมรับ
   ถ้ายังไม่ผ่าน ระบบจะวนถ่ายเฟรมใหม่ไปเรื่อย ๆ เอง */

const $ = (id) => document.getElementById(id);
const els = {
  video: $('video'), shot: $('shot'), roi: $('roi'), hint: $('hint'), flash: $('flash'),
  spin: $('spin'), statusText: $('statusText'), tries: $('tries'),
  register: $('register'), btnScan: $('btnScan'), saveBox: $('saveBox'),
  fValue: $('fValue'), fMeterNo: $('fMeterNo'), fNote: $('fNote'),
  gpsText: $('gpsText'), btnGps: $('btnGps'), mapMini: $('mapMini'),
  btnSave: $('btnSave'), btnRetake: $('btnRetake'),
  btnTorch: $('btnTorch'), btnSwap: $('btnSwap'),
  btnZoomIn: $('btnZoomIn'), btnZoomOut: $('btnZoomOut')
};

const CFG = {
  minDigits: 4,          // จำนวนหลักต่ำสุดที่ยอมรับ
  maxDigits: 8,          // จำนวนหลักสูงสุด
  minConfidence: 55,     // ความมั่นใจขั้นต่ำของ OCR
  needSameTimes: 2,      // ต้องอ่านได้ค่าเดิมกี่ครั้งติดจึงยอมรับ
  frameDelayMs: 280,     // พักระหว่างเฟรม
  storeWidth: 1280       // ความกว้างรูปที่เก็บลง DB
};

const state = {
  stream: null, track: null, worker: null,
  scanning: false, attempts: 0, torchOn: false,
  facing: 'environment', roiH: 18,
  history: [], shotDataUrl: null, value: null, confidence: null,
  gps: null, map: null, marker: null
};

/* ---------------- กล้อง ---------------- */
async function startCamera() {
  stopCamera();
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('เบราว์เซอร์นี้เปิดกล้องไม่ได้');
  }
  state.stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: state.facing },
      width: { ideal: 1920 }, height: { ideal: 1080 }
    },
    audio: false
  });
  state.track = state.stream.getVideoTracks()[0];
  els.video.srcObject = state.stream;
  await els.video.play();
  els.hint.classList.add('hidden');

  const caps = state.track.getCapabilities ? state.track.getCapabilities() : {};
  els.btnTorch.disabled = !caps.torch;
  els.btnSwap.disabled = false;
  els.btnZoomIn.disabled = els.btnZoomOut.disabled = false;
}

function stopCamera() {
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = state.track = null;
}

/* ---------------- ประมวลผลภาพก่อน OCR ---------------- */

/** รอให้เบราว์เซอร์ "มีเฟรมจริง" พร้อมแสดงก่อนค่อยวาดลง canvas
 *  บางเบราว์เซอร์ (โดยเฉพาะ Safari/iOS และเว็บวิวในแอปอย่าง LINE, Facebook)
 *  ถ้าวาดจาก <video> เร็วเกินไปหรือวาดตอน DOM เพิ่งเปลี่ยน จะได้ภาพดำสนิทออกมา */
function waitForFreshFrame(video) {
  return new Promise((resolve) => {
    if (video.requestVideoFrameCallback) {
      video.requestVideoFrameCallback(() => resolve());
    } else {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }
  });
}

/** สุ่มตรวจความสว่างเฉลี่ยของ canvas — ถ้าเกือบดำสนิททั้งภาพ ถือว่าเฟรมนี้ใช้ไม่ได้ */
function isBlankCanvas(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let sum = 0, n = 0;
  for (let p = 0; p < data.length; p += 4 * 37) { sum += data[p] + data[p + 1] + data[p + 2]; n++; }
  return n > 0 && sum / (n * 3) < 4;
}

/** วาดวิดีโอลง canvas ตามพิกัดที่กำหนด ลองใหม่สูงสุด `tries` ครั้งถ้าได้เฟรมดำ */
async function drawVideoRegion(video, sx, sy, sw, sh, dw, dh, tries = 4) {
  const c = document.createElement('canvas');
  c.width = dw; c.height = dh;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  for (let i = 0; i < tries; i++) {
    await waitForFreshFrame(video);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh);
    if (!isBlankCanvas(c)) return c;
  }
  return null; // ลองครบแล้วยังดำอยู่ — ให้ผู้เรียกจัดการเอง
}

async function grabRoiCanvas() {
  const v = els.video;
  const vw = v.videoWidth, vh = v.videoHeight;
  if (!vw || !vh) return null;

  // กรอบเล็งบนจอ = สัดส่วนเดียวกับเฟรมจริง (วิดีโอใช้ object-fit: cover)
  const box = els.roi.getBoundingClientRect();
  const view = v.getBoundingClientRect();
  const scale = Math.max(view.width / vw, view.height / vh);
  const offX = (view.width - vw * scale) / 2;
  const offY = (view.height - vh * scale) / 2;

  const sx = Math.max(0, (box.left - view.left - offX) / scale);
  const sy = Math.max(0, (box.top - view.top - offY) / scale);
  const sw = Math.min(vw - sx, box.width / scale);
  const sh = Math.min(vh - sy, box.height / scale);

  const factor = Math.min(3, 1000 / sw);
  return drawVideoRegion(v, sx, sy, sw, sh, Math.round(sw * factor), Math.round(sh * factor));
}

/** เทา + ยืดคอนทราสต์ + Otsu threshold + กลับสีถ้าพื้นเข้ม (จอ LCD ตัวเลขสว่าง) */
function binarize(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data, n = canvas.width * canvas.height;
  const gray = new Uint8Array(n);
  const hist = new Uint32Array(256);

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const g = (d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000 | 0;
    gray[i] = g; hist[g]++;
  }

  // ยืดคอนทราสต์โดยตัดหัวท้าย 2%
  const cut = n * 0.02;
  let lo = 0, hi = 255, acc = 0;
  for (let g = 0; g < 256; g++) { acc += hist[g]; if (acc > cut) { lo = g; break; } }
  acc = 0;
  for (let g = 255; g >= 0; g--) { acc += hist[g]; if (acc > cut) { hi = g; break; } }
  const span = Math.max(1, hi - lo);

  const h2 = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const g = Math.min(255, Math.max(0, ((gray[i] - lo) * 255 / span) | 0));
    gray[i] = g; h2[g]++;
  }

  // Otsu
  let sum = 0;
  for (let g = 0; g < 256; g++) sum += g * h2[g];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let g = 0; g < 256; g++) {
    wB += h2[g]; if (!wB) continue;
    const wF = n - wB; if (!wF) break;
    sumB += g * h2[g];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = g; }
  }

  let dark = 0;
  for (let i = 0; i < n; i++) if (gray[i] < thr) dark++;
  const invert = dark > n * 0.55;   // ตัวเลขสว่างบนพื้นเข้ม -> กลับสี

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    let on = gray[i] < thr;           // true = หมึก
    if (invert) on = !on;
    const v = on ? 0 : 255;
    d[p] = d[p + 1] = d[p + 2] = v; d[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/* ---------------- OCR ---------------- */
async function getWorker() {
  if (state.worker) return state.worker;
  setStatus('กำลังโหลดตัวอ่านตัวเลขครั้งแรก…', true);
  const w = await Tesseract.createWorker('eng', 1);
  await w.setParameters({
    tessedit_char_whitelist: '0123456789',
    tessedit_pageseg_mode: '7',          // บรรทัดเดียว
    classify_bln_numeric_mode: '1',
    user_defined_dpi: '300'
  });
  state.worker = w;
  return w;
}

function cleanDigits(text) {
  return String(text || '').replace(/\D/g, '');
}

async function readOnce() {
  const roi = await grabRoiCanvas();
  if (!roi) return null;
  const prepped = binarize(roi);
  const worker = await getWorker();
  const { data } = await worker.recognize(prepped);
  const digits = cleanDigits(data.text);
  const ok = digits.length >= CFG.minDigits &&
             digits.length <= CFG.maxDigits &&
             data.confidence >= CFG.minConfidence;
  return { digits, confidence: Math.round(data.confidence), ok };
}

/* ---------------- ลูปสแกน ---------------- */
async function scanLoop() {
  while (state.scanning) {
    state.attempts++;
    els.tries.textContent = `อ่านแล้ว ${state.attempts} ครั้ง`;

    let r = null;
    try { r = await readOnce(); } catch (e) { console.error(e); }

    if (r && r.ok) {
      state.history.push(r.digits);
      if (state.history.length > CFG.needSameTimes) state.history.shift();
      const stable = state.history.length === CFG.needSameTimes &&
                     state.history.every((v) => v === state.history[0]);
      showRegister(r.digits, !stable);
      els.roi.classList.add('live');

      if (stable) { await accept(r.digits, r.confidence); return; }
      setStatus(`อ่านได้ ${r.digits} — กำลังยืนยันซ้ำ ถือกล้องนิ่ง ๆ`, true);
    } else {
      state.history.length = 0;
      els.roi.classList.remove('live');
      setStatus(r && r.digits
        ? `ยังไม่ชัด (ได้ "${r.digits}" ${r.confidence}%) — ขยับให้ตัวเลขเต็มกรอบแล้วถือนิ่ง`
        : 'ยังไม่เจอตัวเลข — เข้าใกล้อีกนิด เปิดไฟฉายถ้าที่นั่นมืด', true);
    }
    await new Promise((res) => setTimeout(res, CFG.frameDelayMs));
  }
}

function showRegister(digits, provisional) {
  const chars = digits.split('');
  els.register.classList.remove('empty');
  els.register.style.opacity = provisional ? '.55' : '1';
  els.register.innerHTML = chars
    .map((c, i) => `<span class="${i === chars.length - 1 ? 'last' : ''}">${c}</span>`)
    .join('');
}

function setStatus(text, busy) {
  els.statusText.textContent = text;
  els.spin.classList.toggle('hidden', !busy);
}

/* ---------------- ยอมรับค่า -> แช่ภาพ -> ขอ GPS ---------------- */
async function accept(digits, confidence) {
  state.scanning = false;
  state.value = digits;
  state.confidence = confidence;
  state.shotDataUrl = captureFullFrame();

  els.flash.classList.add('on');
  setTimeout(() => els.flash.classList.remove('on'), 300);

  els.shot.src = state.shotDataUrl;
  els.shot.classList.remove('hidden');
  els.video.classList.add('hidden');
  els.roi.classList.add('hidden');
  stopCamera();

  setStatus(`อ่านสำเร็จ ความมั่นใจ ${confidence}%`, false);
  els.btnScan.classList.add('hidden');
  els.saveBox.classList.remove('hidden');
  els.fValue.value = digits;
  els.saveBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  requestGps();
}

function captureFullFrame() {
  const v = els.video;
  const w = Math.min(CFG.storeWidth, v.videoWidth);
  const h = Math.round(v.videoHeight * (w / v.videoWidth));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(v, 0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.86);
}

/* ---------------- พิกัด ---------------- */
function requestGps() {
  if (!navigator.geolocation) { els.gpsText.textContent = 'อุปกรณ์นี้ไม่รองรับการระบุพิกัด'; return; }
  els.gpsText.textContent = 'กำลังหาพิกัด…';
  navigator.geolocation.getCurrentPosition(
    (p) => {
      state.gps = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) };
      els.gpsText.innerHTML =
        `${state.gps.lat.toFixed(6)}, ${state.gps.lng.toFixed(6)} <span class="muted">คลาดเคลื่อน ±${state.gps.accuracy} ม.</span>`;
      drawMini();
    },
    (err) => {
      els.gpsText.textContent = err.code === 1
        ? 'ยังไม่อนุญาตให้ใช้ตำแหน่ง — บันทึกได้แต่จะไม่มีหมุดบนแผนที่'
        : 'หาพิกัดไม่สำเร็จ ลองใหม่อีกครั้งกลางแจ้ง';
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
  );
}

function drawMini() {
  els.mapMini.classList.remove('hidden');
  const { lat, lng } = state.gps;
  if (!state.map) {
    state.map = L.map('mapMini').setView([lat, lng], 17);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap'
    }).addTo(state.map);
    state.marker = L.marker([lat, lng]).addTo(state.map);
  } else {
    state.map.setView([lat, lng], 17);
    state.marker.setLatLng([lat, lng]);
  }
  setTimeout(() => state.map.invalidateSize(), 120);
}

/* ---------------- บันทึก ---------------- */
async function save() {
  const value = els.fValue.value.replace(/\D/g, '');
  if (!value) return toast('ยังไม่มีเลขมิเตอร์ให้บันทึก', 'bad');

  els.btnSave.disabled = true;
  els.btnSave.textContent = 'กำลังบันทึก…';
  try {
    const res = await fetch('/api/readings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meterValue: value,
        meterNo: els.fMeterNo.value.trim() || null,
        note: els.fNote.value.trim() || null,
        confidence: state.confidence,
        attempts: state.attempts,
        lat: state.gps?.lat ?? null,
        lng: state.gps?.lng ?? null,
        accuracy: state.gps?.accuracy ?? null,
        image: state.shotDataUrl
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'บันทึกไม่สำเร็จ');
    toast(`บันทึกแล้ว #${data.id} — ดูได้ที่หน้าข้อมูลที่บันทึก`);
    resetAll();
  } catch (e) {
    toast(e.message, 'bad');
  } finally {
    els.btnSave.disabled = false;
    els.btnSave.textContent = 'บันทึก';
  }
}

function resetAll() {
  state.history.length = 0;
  state.attempts = 0;
  state.value = state.shotDataUrl = state.gps = null;
  els.saveBox.classList.add('hidden');
  els.mapMini.classList.add('hidden');
  els.fValue.value = els.fMeterNo.value = els.fNote.value = '';
  els.gpsText.textContent = 'ยังไม่ได้พิกัด';
  els.shot.classList.add('hidden');
  els.video.classList.remove('hidden');
  els.roi.classList.remove('live', 'hidden');
  els.register.className = 'register empty';
  els.register.style.opacity = '1';
  els.register.innerHTML = '<span>–</span><span>–</span><span>–</span><span>–</span><span>–</span><span class="last">–</span>';
  els.tries.textContent = '';
  els.btnScan.classList.remove('hidden');
  els.btnScan.textContent = 'เปิดกล้องแล้วเริ่มอ่าน';
  setStatus('ยังไม่เริ่ม', false);
}

function toast(msg, kind) {
  const t = document.createElement('div');
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3600);
}

/* ---------------- ปุ่ม ---------------- */
els.btnScan.addEventListener('click', async () => {
  if (state.scanning) {           // กดซ้ำ = หยุด
    state.scanning = false;
    els.btnScan.textContent = 'เริ่มอ่านอีกครั้ง';
    setStatus('หยุดอ่านชั่วคราว', false);
    return;
  }
  try {
    if (!state.stream) await startCamera();
    state.scanning = true;
    state.history.length = 0;
    els.btnScan.textContent = 'หยุด';
    setStatus('กำลังอ่าน…', true);
    scanLoop();
  } catch (e) {
    setStatus('เปิดกล้องไม่ได้: ' + e.message, false);
    toast('เปิดกล้องไม่ได้ — ต้องเข้าผ่าน https หรือ localhost และอนุญาตให้ใช้กล้อง', 'bad');
  }
});

els.btnRetake.addEventListener('click', async () => {
  resetAll();
  await startCamera();
  state.scanning = true;
  els.btnScan.textContent = 'หยุด';
  setStatus('กำลังอ่านใหม่…', true);
  scanLoop();
});

els.btnGps.addEventListener('click', requestGps);
els.btnSave.addEventListener('click', save);

els.btnTorch.addEventListener('click', async () => {
  if (!state.track) return;
  state.torchOn = !state.torchOn;
  try {
    await state.track.applyConstraints({ advanced: [{ torch: state.torchOn }] });
    els.btnTorch.textContent = state.torchOn ? 'ปิดไฟฉาย' : 'เปิดไฟฉาย';
  } catch { toast('อุปกรณ์นี้สั่งไฟฉายไม่ได้', 'warn'); }
});

els.btnSwap.addEventListener('click', async () => {
  state.facing = state.facing === 'environment' ? 'user' : 'environment';
  await startCamera();
});

function setRoi(h) {
  state.roiH = Math.min(40, Math.max(10, h));
  els.roi.style.height = state.roiH + '%';
  els.roi.style.top = (50 - state.roiH / 2) + '%';
}
els.btnZoomIn.addEventListener('click', () => setRoi(state.roiH + 4));
els.btnZoomOut.addEventListener('click', () => setRoi(state.roiH - 4));

window.addEventListener('beforeunload', () => { state.scanning = false; stopCamera(); });
