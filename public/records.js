/* หน้ารายการ: ดึงข้อมูลจาก /api/readings แล้ววางคู่กับแผนที่ */

const listEl = document.getElementById('list');
const countEl = document.getElementById('count');
const statsEl = document.getElementById('stats');
const qEl = document.getElementById('q');

let map, markers = {}, layer;

function initMap() {
  map = L.map('map').setView([19.9, 99.83], 11);   // ค่าเริ่มต้น: เชียงราย
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap'
  }).addTo(map);
  layer = L.layerGroup().addTo(map);
}

const fmtTime = (iso) => new Date(iso).toLocaleString('th-TH', {
  day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit'
});

function digitsHtml(v) {
  return v.slice(0, -1) + '<b>' + v.slice(-1) + '</b>';
}

async function load() {
  const q = qEl.value.trim();
  const res = await fetch('/api/readings' + (q ? '?q=' + encodeURIComponent(q) : ''));
  const { items } = await res.json();

  countEl.textContent = `${items.length} รายการ`;
  layer.clearLayers();
  markers = {};

  if (!items.length) {
    listEl.innerHTML = `<div class="empty">${q ? 'ไม่พบรายการที่ตรงกับคำค้น' : 'ยังไม่มีข้อมูล ไปที่หน้าสแกนเพื่อถ่ายมิเตอร์ตัวแรก'}</div>`;
    return;
  }

  listEl.innerHTML = items.map((r) => `
    <article class="rec" id="rec-${r.id}">
      <img src="${r.imageUrl}" alt="มิเตอร์ ${r.meterValue}" loading="lazy" data-zoom="${r.imageUrl}">
      <div>
        <div class="val">${digitsHtml(r.meterValue)}</div>
        <div class="meta">
          ${fmtTime(r.createdAt)}
          ${r.meterNo ? ' · มิเตอร์ ' + r.meterNo : ''}
          ${r.confidence != null ? ' · ความมั่นใจ ' + r.confidence + '%' : ''}
        </div>
        <div class="meta">
          ${r.lat != null
            ? `<code>${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}</code>
               <button class="go" data-focus="${r.id}">ดูบนแผนที่</button>`
            : 'ไม่มีพิกัด'}
        </div>
        ${r.note ? `<div class="meta">${escapeHtml(r.note)}</div>` : ''}
      </div>
      <button class="danger" data-del="${r.id}">ลบ</button>
    </article>
  `).join('');

  const pts = [];
  items.filter((r) => r.lat != null).forEach((r) => {
    const m = L.marker([r.lat, r.lng]).addTo(layer).bindPopup(`
      <b style="font-family:monospace;font-size:16px">${r.meterValue}</b><br>
      ${fmtTime(r.createdAt)}<br>
      <img src="${r.imageUrl}" style="width:180px;margin-top:6px;border-radius:4px">
    `);
    m.on('click', () => highlight(r.id));
    markers[r.id] = m;
    pts.push([r.lat, r.lng]);
  });
  if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 17 });
}

function highlight(id) {
  document.querySelectorAll('.rec.active').forEach((e) => e.classList.remove('active'));
  const el = document.getElementById('rec-' + id);
  if (el) { el.classList.add('active'); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

listEl.addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  const focus = e.target.closest('[data-focus]');
  const zoom = e.target.closest('[data-zoom]');

  if (del) {
    if (!confirm('ลบรายการนี้ออกจากฐานข้อมูล?')) return;
    await fetch('/api/readings/' + del.dataset.del, { method: 'DELETE' });
    load(); loadStats();
  } else if (focus) {
    const m = markers[focus.dataset.focus];
    if (m) { map.setView(m.getLatLng(), 18); m.openPopup(); highlight(focus.dataset.focus); }
  } else if (zoom) {
    const box = document.createElement('div');
    box.className = 'lightbox';
    box.innerHTML = `<img src="${zoom.dataset.zoom}" alt="">`;
    box.addEventListener('click', () => box.remove());
    document.body.appendChild(box);
  }
});

async function loadStats() {
  const s = await (await fetch('/api/stats')).json();
  statsEl.textContent = s.total
    ? `ทั้งหมด ${s.total} รายการ · มีพิกัด ${s.withGps} รายการ · ล่าสุด ${fmtTime(s.latest)}`
    : 'ยังไม่มีข้อมูลในฐานข้อมูล';
}

let timer;
qEl.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });

initMap();
load();
loadStats();
