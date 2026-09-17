'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const CERT_DIR = path.join(ROOT, 'certs');
const BUCKET = process.env.SUPABASE_BUCKET || 'meter-photos';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('ยังไม่ได้ตั้งค่า SUPABASE_URL / SUPABASE_SERVICE_KEY');
  console.error('ดูวิธีตั้งค่าใน README.md ก่อนรันอีกครั้ง');
  process.exitCode = 1;
  return;
}

console.log(`SUPABASE_URL ที่อ่านได้: "${SUPABASE_URL}"`); // ช่วยเช็คว่าพิมพ์/คัดลอกถูกไหม (ค่านี้ไม่ใช่ความลับ แสดงได้เต็ม)

try {
  const u = new URL(SUPABASE_URL);
  if (!u.hostname.endsWith('.supabase.co')) {
    console.error('SUPABASE_URL ดูไม่เหมือนลิงก์โปรเจกต์ Supabase (ต้องลงท้ายด้วย .supabase.co)');
  }
} catch {
  console.error(`SUPABASE_URL ไม่ใช่ลิงก์ที่ถูกต้อง: "${SUPABASE_URL}"`);
  console.error('ต้องเป็นรูปแบบ https://xxxxxxxx.supabase.co เท่านั้น ห้ามมีเครื่องหมายคำพูด ช่องว่าง หรือ / ต่อท้าย');
  console.error('คัดลอกใหม่จาก Project Settings > API > Project URL แล้วรันคำสั่ง $env:SUPABASE_URL=... ในหน้าต่าง PowerShell เดียวกับที่จะรัน npm start');
  process.exitCode = 1;
  return;
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

/** สร้าง Storage bucket ให้อัตโนมัติถ้ายังไม่มี (ตารางในฐานข้อมูลต้องสร้างเองครั้งเดียวผ่าน SQL Editor — ดู README) */
async function initStorage() {
  const { data: buckets, error: listErr } = await supabase.storage.listBuckets();
  if (listErr) throw listErr;
  if (!buckets?.some((b) => b.name === BUCKET)) {
    const { error } = await supabase.storage.createBucket(BUCKET, { public: true });
    if (error) throw error;
    console.log(`สร้าง Storage bucket "${BUCKET}" ให้แล้ว`);
  }
}

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(ROOT, 'public')));

/* ---------- helper ---------- */
function decodeDataUrl(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([\s\S]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  return { mime: m[1], buf: Buffer.from(m[2], 'base64') };
}

const extFromMime = (mime) => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mime] || 'jpg');

function publicUrlFor(imagePath) {
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(imagePath);
  return data.publicUrl;
}

const rowToJson = (r) => ({
  id: r.id,
  meterNo: r.meter_no,
  meterValue: r.meter_value,
  confidence: r.confidence == null ? null : Number(r.confidence),
  note: r.note,
  lat: r.lat,
  lng: r.lng,
  accuracy: r.accuracy,
  address: r.address,
  imageSize: r.image_size,
  attempts: r.attempts,
  createdAt: r.created_at,
  imageUrl: `/api/readings/${r.id}/image` // เส้นทางเดิม ฟรอนต์เอนด์ไม่ต้องแก้ — ข้างในจะ redirect ไป Supabase Storage
});

const COLS = 'id, meter_no, meter_value, confidence, note, lat, lng, accuracy, address, image_path, image_size, attempts, created_at';

/* ครอบ handler แบบ async ให้ error หลุดไปที่ Express เอง ไม่ทำให้เซิร์ฟเวอร์ค้าง */
const h = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err);
  res.status(500).json({ error: 'เชื่อมต่อ Supabase ไม่ได้ — ตรวจ SUPABASE_URL/SUPABASE_SERVICE_KEY และอินเทอร์เน็ต' });
});

/* ---------- บันทึกค่าที่อ่านได้ ---------- */
app.post('/api/readings', h(async (req, res) => {
  const b = req.body || {};
  const value = String(b.meterValue || '').trim();

  if (!/^\d{1,12}$/.test(value)) {
    return res.status(400).json({ error: 'เลขมิเตอร์ต้องเป็นตัวเลข 1-12 หลัก' });
  }
  const img = decodeDataUrl(b.image);
  if (!img) {
    return res.status(400).json({ error: 'ไม่พบรูปถ่าย หรือรูปไม่ใช่ JPEG/PNG/WebP' });
  }

  const imagePath = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${extFromMime(img.mime)}`;
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(imagePath, img.buf, {
    contentType: img.mime,
    upsert: false
  });
  if (upErr) return res.status(500).json({ error: 'อัปโหลดรูปไป Supabase Storage ไม่สำเร็จ: ' + upErr.message });

  const { data: row, error: insErr } = await supabase
    .from('readings')
    .insert({
      meter_no: b.meterNo ? String(b.meterNo).trim().slice(0, 40) : null,
      meter_value: value,
      confidence: b.confidence == null ? null : Number(b.confidence),
      note: b.note ? String(b.note).slice(0, 500) : null,
      lat: b.lat == null ? null : Number(b.lat),
      lng: b.lng == null ? null : Number(b.lng),
      accuracy: b.accuracy == null ? null : Number(b.accuracy),
      address: b.address ? String(b.address).slice(0, 300) : null,
      image_path: imagePath,
      image_mime: img.mime,
      image_size: img.buf.length,
      attempts: b.attempts == null ? null : Number(b.attempts)
    })
    .select(COLS)
    .single();

  if (insErr) {
    await supabase.storage.from(BUCKET).remove([imagePath]); // กันไฟล์ค้างถ้าบันทึกแถวไม่สำเร็จ
    return res.status(500).json({ error: 'บันทึกฐานข้อมูลไม่สำเร็จ: ' + insErr.message });
  }
  res.status(201).json(rowToJson(row));
}));

/* ---------- รายการทั้งหมด / ค้นหา ---------- */
app.get('/api/readings', h(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Math.min(Number(req.query.limit) || 200, 500);

  let query = supabase.from('readings').select(COLS).order('id', { ascending: false }).limit(limit);
  if (q) {
    const like = `%${q.replace(/[%,]/g, '')}%`;
    query = query.or(`meter_value.ilike.${like},meter_no.ilike.${like},note.ilike.${like}`);
  }
  const { data: rows, error } = await query;
  if (error) throw error;
  res.json({ count: rows.length, items: rows.map(rowToJson) });
}));

app.get('/api/readings/:id', h(async (req, res) => {
  const { data: row } = await supabase.from('readings').select(COLS).eq('id', req.params.id).single();
  if (!row) return res.status(404).json({ error: 'ไม่พบรายการนี้' });
  res.json(rowToJson(row));
}));

/* ---------- รูป: ส่ง redirect ไปที่ไฟล์จริงบน Supabase Storage ---------- */
app.get('/api/readings/:id/image', h(async (req, res) => {
  const { data: row } = await supabase.from('readings').select('image_path').eq('id', req.params.id).single();
  if (!row) return res.status(404).send('ไม่พบรูป');
  res.redirect(publicUrlFor(row.image_path));
}));

app.delete('/api/readings/:id', h(async (req, res) => {
  const { data: row } = await supabase.from('readings').select('image_path').eq('id', req.params.id).single();
  if (!row) return res.status(404).json({ error: 'ไม่พบรายการนี้' });

  await supabase.storage.from(BUCKET).remove([row.image_path]);
  const { error } = await supabase.from('readings').delete().eq('id', req.params.id);
  if (error) throw error;
  res.json({ deleted: Number(req.params.id) });
}));

/* ---------- ส่งออก CSV ---------- */
app.get('/api/export.csv', h(async (_req, res) => {
  const { data: rows, error } = await supabase.from('readings').select(COLS).order('id', { ascending: false });
  if (error) throw error;
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = 'id,meter_no,meter_value,confidence,lat,lng,accuracy,note,created_at,image_url';
  const body = rows.map((r) =>
    [r.id, r.meter_no, r.meter_value, r.confidence, r.lat, r.lng, r.accuracy,
     r.note, r.created_at, publicUrlFor(r.image_path)].map(esc).join(',')
  );
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="meter-readings.csv"');
  res.send('\uFEFF' + [head, ...body].join('\n'));
}));

app.get('/api/stats', h(async (_req, res) => {
  const { count: total } = await supabase.from('readings').select('*', { count: 'exact', head: true });
  const { count: withGps } = await supabase.from('readings').select('*', { count: 'exact', head: true }).not('lat', 'is', null);
  const { data: latestRows } = await supabase.from('readings').select('created_at').order('id', { ascending: false }).limit(1);
  res.json({ total: total || 0, withGps: withGps || 0, latest: latestRows?.[0]?.created_at || null });
}));

/* ---------- start ---------- */
const keyFile = path.join(CERT_DIR, 'key.pem');
const crtFile = path.join(CERT_DIR, 'cert.pem');
const useHttps = fs.existsSync(keyFile) && fs.existsSync(crtFile);

const server = useHttps
  ? https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(crtFile) }, app)
  : http.createServer(app);

initStorage()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      const scheme = useHttps ? 'https' : 'http';
      console.log(`Meter Scan พร้อมใช้งานที่ ${scheme}://localhost:${PORT}`);
      console.log(`ฐานข้อมูล: Supabase (${SUPABASE_URL}) — ดูข้อมูลได้ใน Supabase Studio`);
      if (!useHttps) {
        console.log('โหมด http: กล้องจะเปิดได้เฉพาะ localhost — ถ้าเข้าจากมือถือให้ใช้ https หรือ ngrok');
      }
    });
  })
  .catch((err) => {
    console.error('เชื่อมต่อ Supabase ไม่สำเร็จ:', err.message);
    console.error('ตรวจว่า SUPABASE_URL / SUPABASE_SERVICE_KEY ถูกต้อง และสร้างตาราง readings แล้วหรือยัง (ดู README)');
    process.exitCode = 1;
  });
