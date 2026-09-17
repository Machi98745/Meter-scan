# Meter Scan — เว็บถ่ายและอ่านเลขมิเตอร์ไฟฟ้า

ถ่ายมิเตอร์ด้วยกล้องมือถือ → เครื่องอ่านตัวเลขเอง → บันทึกทั้งรูปและเลขลงฐานข้อมูล พร้อมพิกัดบนแผนที่

การอ่านเลขทำในเบราว์เซอร์ของผู้ใช้ทั้งหมดด้วย Tesseract.js (OCR แบบดั้งเดิม) **ไม่มีการส่งภาพไปให้โมเดล AI ตัวไหนอ่านให้** เซิร์ฟเวอร์ทำหน้าที่เก็บข้อมูลอย่างเดียว ฐานข้อมูลใช้ **Supabase** (PostgreSQL + ที่เก็บไฟล์ในตัว, ฟรี, มี GUI ดูข้อมูลในเว็บ)

---

## ติดตั้ง

### 1. สร้างโปรเจกต์ Supabase (ทำครั้งเดียว)

1. เข้า [supabase.com](https://supabase.com) → **Start your project** → สมัคร/ล็อกอินด้วย GitHub หรืออีเมล
2. กด **New Project** ตั้งชื่อ (เช่น `meter-scan`) ตั้งรหัสผ่านฐานข้อมูล (เก็บไว้ดี ๆ) เลือก Region ใกล้ไทยที่สุด (เช่น Singapore) แล้วกด **Create**
   รอประมาณ 1-2 นาทีให้โปรเจกต์สร้างเสร็จ
3. ไปที่เมนู **SQL Editor** (ไอคอนรูปเทอร์มินัลด้านซ้าย) → **New query** → วางโค้ดนี้ → กด **Run** (สร้างตารางครั้งเดียวจบ):

   ```sql
   create table if not exists readings (
     id           bigint generated always as identity primary key,
     meter_no     text,
     meter_value  text not null,
     confidence   numeric(5,2),
     note         text,
     lat          double precision,
     lng          double precision,
     accuracy     double precision,
     address      text,
     image_path   text not null,
     image_mime   text not null default 'image/jpeg',
     image_size   integer,
     attempts     integer,
     created_at   timestamptz not null default now()
   );
   create index if not exists idx_readings_created on readings (created_at desc);
   create index if not exists idx_readings_meter   on readings (meter_no);
   ```

4. ไปที่เมนู **Project Settings** (ไอคอนเฟือง) → **API** แล้วคัดลอก 2 ค่านี้เก็บไว้:
   - **Project URL** (หน้าตาแบบ `https://xxxxxxxx.supabase.co`)
   - **service_role key** (อยู่ใต้หัวข้อ "Project API keys" — คนละอันกับ `anon` `public` key นะ ต้องเป็น **service_role** เท่านั้น)

   ⚠️ **service_role key ห้ามเผยแพร่หรือใส่ในโค้ดฝั่งหน้าเว็บเด็ดขาด** เพราะมันข้ามการตรวจสิทธิ์ทั้งหมด — ในโปรเจกต์นี้ใช้แค่ฝั่งเซิร์ฟเวอร์ (`server.js`) เท่านั้น ปลอดภัยเพราะฝั่งหน้าเว็บมองไม่เห็นค่านี้เลย

Storage bucket สำหรับเก็บรูป เซิร์ฟเวอร์จะ**สร้างให้อัตโนมัติ**ตอนรันครั้งแรก ไม่ต้องสร้างเอง

### 2. ตั้งค่าและรันเว็บ

ตั้งค่า environment variable 2 ตัวที่คัดลอกมาก่อนรัน:

```bash
# Windows (PowerShell)
$env:SUPABASE_URL="https://xxxxxxxx.supabase.co"
$env:SUPABASE_SERVICE_KEY="eyJhbGciOi....(ยาวมาก)"

# macOS / Linux
export SUPABASE_URL="https://xxxxxxxx.supabase.co"
export SUPABASE_SERVICE_KEY="eyJhbGciOi....(ยาวมาก)"
```

แล้วติดตั้งและรัน:

```bash
cd meter-scan
npm install
npm start
```

เปิด `http://localhost:3000` — ถ้าตั้งค่าไม่ครบหรือผิด เทอร์มินัลจะบอกทันทีว่าต้องแก้ตรงไหน

> ทุกครั้งที่เปิด terminal ใหม่ต้องตั้งค่า `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` ใหม่ (เพราะเป็นค่าชั่วคราวของ session นั้น) ถ้าไม่อยากพิมพ์ซ้ำทุกครั้ง สร้างไฟล์สคริปต์เล็ก ๆ เก็บคำสั่ง export ไว้แล้วรันก่อน `npm start` ก็ได้

## ดูข้อมูลใน Supabase Studio

1. กลับไปที่หน้าโปรเจกต์บน supabase.com
2. เมนู **Table Editor** (ไอคอนตาราง) → เลือกตาราง `readings` — เห็นทุกแถวที่บันทึกจากมือถือ แก้ไข/ลบตรงนี้ได้เลยเหมือน Excel
3. เมนู **Storage** → bucket `meter-photos` — เห็นรูปจริงเป็นไฟล์ คลิกดูตัวอย่างได้ตรง ๆ (ข้อดีกว่า phpMyAdmin/MySQL ตรงนี้ คือรูปไม่ได้ฝังเป็น BLOB ในตาราง เลยดูเป็นรูปได้ทันทีไม่ต้องพึ่งหน้าเว็บของเราเลย)

## เปิดจากมือถือ (สำคัญ)

เบราว์เซอร์จะยอมเปิดกล้องเฉพาะเมื่ออยู่บน `localhost` หรือ **https** เท่านั้น
เข้าผ่าน `http://192.168.x.x:3000` จากมือถือ กล้องจะไม่ทำงาน เลือกทางใดทางหนึ่ง:

**ก. ใช้ใบรับรองที่สร้างเอง** — วางไฟล์ไว้ที่ `certs/key.pem` และ `certs/cert.pem` เซิร์ฟเวอร์จะสลับเป็น https ให้เอง

```bash
mkdir certs && cd certs
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 \
  -subj "/CN=192.168.1.10" -addext "subjectAltName=IP:192.168.1.10"
```

(เปลี่ยน IP เป็นของเครื่องคุณ) แล้วเข้า `https://192.168.1.10:3000` มือถือจะเตือนว่าใบรับรองไม่น่าเชื่อถือ — กด "ไปต่อ" ได้

**ข. ใช้ ngrok** — `ngrok http 3000` แล้วเปิดลิงก์ https ที่ได้ (ถ้ามีโฟลเดอร์ `certs/` อยู่ เซิร์ฟเวอร์จะรันเป็น https ทำให้ ngrok ต่อแบบ http ธรรมดาไม่ติด ให้ใช้ `ngrok http https://localhost:3000` แทน หรือลบโฟลเดอร์ `certs` ออกถ้าไม่ได้ใช้)

**ค. ปล่อยให้ผู้ใช้เข้าได้ถาวรโดยไม่ต้องพึ่งคอมพิวเตอร์คุณเปิดค้างไว้** — เพราะฐานข้อมูลอยู่บนคลาวด์แล้ว เหลือแค่ตัวเว็บ (Express) ที่ยังรันในเครื่อง ถ้าอยากได้ลิงก์ถาวรจริง ๆ ลองนำโปรเจกต์นี้ไป deploy บนบริการฟรีอย่าง Render หรือ Railway (รองรับ Node.js โดยตรง ตั้งค่า `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` เป็น environment variables บนนั้นเหมือนกัน) จะได้ https URL ถาวรไม่ต้องเปิดคอมทิ้งไว้

โหลดครั้งแรกต้องต่ออินเทอร์เน็ต เพราะดึงไฟล์ OCR กับแผนที่จาก CDN (หลังจากนั้นเบราว์เซอร์แคชไว้)

---

## วิธีใช้

1. หน้า **สแกน** → กด "เปิดกล้องแล้วเริ่มอ่าน" → อนุญาตให้ใช้กล้อง
2. เล็งให้แถวตัวเลขบนมิเตอร์อยู่เต็มกรอบขาว ปรับกรอบด้วยปุ่ม "กรอบใหญ่ขึ้น/เล็กลง" ถ้ามืดให้เปิดไฟฉาย
3. ระบบดึงเฟรมใหม่มาอ่านซ้ำเองทุก ~0.3 วินาที **จนกว่าจะอ่านได้** ไม่ต้องกดถ่ายเอง
   จะยอมรับก็ต่อเมื่ออ่านได้ค่าเดียวกัน 2 ครั้งติดและความมั่นใจถึงเกณฑ์ — กันอ่านผิด
4. เมื่อสำเร็จ ภาพจะถูกแช่ไว้ ระบบขอพิกัด GPS แล้วแสดงหมุดตัวอย่าง
5. ตรวจเลข (แก้ได้ถ้าเพี้ยน) ใส่รหัสมิเตอร์/หมายเหตุ → **บันทึก** หรือกด **ถ่ายใหม่** เพื่อเริ่มรอบใหม่
6. หน้า **ข้อมูลที่บันทึก** ดูรายการทั้งหมด รูป พิกัดบนแผนที่ ค้นหา ลบ และส่งออก CSV

---

## โครงสร้างโปรเจกต์

```
meter-scan/
├─ server.js            แบ็กเอนด์ Express + Supabase (Postgres + Storage) — API ทั้งหมด
├─ package.json
└─ public/              ฟรอนต์เอนด์
   ├─ index.html        หน้าสแกน
   ├─ scan.js           กล้อง + ประมวลผลภาพ + OCR + GPS
   ├─ records.html      หน้ารายการ + แผนที่
   ├─ records.js
   └─ style.css
```

### ตาราง `readings` (Supabase / PostgreSQL)

| คอลัมน์ | ชนิด | ความหมาย |
|---|---|---|
| `id` | bigint identity | รหัสรายการ |
| `meter_no` | text | หมายเลขมิเตอร์ที่ผู้ใช้กรอก |
| `meter_value` | text | เลขที่อ่านได้ |
| `confidence` | numeric(5,2) | ความมั่นใจของ OCR (%) |
| `note` | text | หมายเหตุ |
| `lat`, `lng`, `accuracy` | double precision | พิกัดและความคลาดเคลื่อน (เมตร) |
| `image_path` | text | ที่อยู่ไฟล์ใน Storage bucket `meter-photos` (รูปจริงไม่ได้เก็บในตาราง) |
| `image_mime`, `image_size` | text/integer | ชนิดและขนาดไฟล์ |
| `attempts` | integer | จำนวนครั้งที่อ่านก่อนสำเร็จ |
| `created_at` | timestamptz | เวลาบันทึก |

### API

| Method | Path | ใช้ทำอะไร |
|---|---|---|
| POST | `/api/readings` | บันทึกรายการใหม่ (รูปส่งมาเป็น data URL → อัปโหลดขึ้น Supabase Storage) |
| GET | `/api/readings?q=` | รายการทั้งหมด / ค้นหา |
| GET | `/api/readings/:id` | รายการเดียว |
| GET | `/api/readings/:id/image` | redirect ไปยังไฟล์จริงบน Supabase Storage |
| DELETE | `/api/readings/:id` | ลบทั้งแถวในตารางและไฟล์รูปใน Storage |
| GET | `/api/stats` | จำนวนรวม / จำนวนที่มีพิกัด |
| GET | `/api/export.csv` | ส่งออกเป็น CSV |

---

## ปรับจูนการอ่าน

แก้ค่าที่หัวไฟล์ `public/scan.js`:

```js
const CFG = {
  minDigits: 4,        // จำนวนหลักต่ำสุดที่ยอมรับ
  maxDigits: 8,        // จำนวนหลักสูงสุด — มิเตอร์จานหมุนมักได้ 5 หลัก
  minConfidence: 55,   // ลดลงถ้าอ่านยากเกินไป เพิ่มขึ้นถ้าอ่านผิดบ่อย
  needSameTimes: 2,    // เพิ่มเป็น 3 ถ้าต้องการความแม่นยำสูงขึ้น
  frameDelayMs: 280,
  storeWidth: 1280     // ความกว้างรูปที่เก็บ
};
```

ภาพถูกทำความสะอาดก่อนส่งเข้า OCR: ครอบเฉพาะกรอบเล็ง → ขยายสูงสุด 3 เท่า → แปลงเป็นเทา → ยืดคอนทราสต์ → หาเกณฑ์ขาวดำด้วยวิธี Otsu → กลับสีอัตโนมัติถ้าเป็นจอ LCD ตัวเลขสว่างบนพื้นเข้ม

## เคล็ดลับให้อ่านติดง่ายขึ้น

- ให้ตัวเลขสูงประมาณ 60-80% ของความสูงกรอบ
- ถ่ายตรง ๆ อย่าเอียง แสงสะท้อนบนกระจกมิเตอร์เป็นสาเหตุที่ทำให้อ่านไม่ออกบ่อยที่สุด — ขยับมุมเล็กน้อยแทนการเปิดไฟฉายจ่อ
- มิเตอร์ที่มีหลักสุดท้ายเป็นกรอบแดง ตั้ง `maxDigits` ให้รวมหลักนั้นด้วย

## ข้อจำกัดของแผนฟรี Supabase

แผนฟรีให้ฐานข้อมูล 500 MB และพื้นที่ Storage 1 GB ซึ่งเพียงพอสำหรับเก็บรูปมิเตอร์ได้หลายพันใบ ถ้าโปรเจกต์ไม่ได้ใช้งานติดต่อกัน 7 วันโปรเจกต์จะถูกพักชั่วคราว (pause) — เข้าหน้าเว็บ Supabase แล้วกด "Restore" เพื่อปลุกกลับมาใช้งานได้ตามปกติ ข้อมูลไม่หาย


