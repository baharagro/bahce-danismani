/**
 * Bahçe Danışmanı — Backend v5.1
 * npm install express cors @google/generative-ai
 * node server.js
 *
 * Railway env variables:
 *   GEMINI_API_KEY  — Gemini API anahtarı
 *   SB_URL          — Supabase Project URL (Railway'de kalıcı)
 *   SB_KEY          — Supabase anon key   (Railway'de kalıcı)
 *   PORT            — Otomatik atanır
 */
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const https   = require('https');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app  = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) { console.error('❌ GEMINI_API_KEY env variable tanımlı değil!'); process.exit(1); }const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Railway'de dosya sistemi ephemeral — DB dosyaları her deploy'da sıfırlanır.
// Kalıcı veri için Railway Volume ekleyin veya Supabase sync kullanın.
const DB_FILE   = path.join(__dirname, 'bahce_data.json');
const ESKI_FILE = path.join(__dirname, 'toprak_arsiv.json');

function readDB() {
  let db = { analizler:[], agaclar:[], verim:[], tedaviler:[] };
  try {
    if (fs.existsSync(DB_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE,'utf8')) };
  } catch {}
  try {
    if (fs.existsSync(ESKI_FILE)) {
      const eski = JSON.parse(fs.readFileSync(ESKI_FILE,'utf8'));
      const mevcutIdler = new Set((db.analizler||[]).map(a=>String(a.id)));
      const yeniGelen = (eski.analizler||[]).filter(a=>!mevcutIdler.has(String(a.id)));
      if (yeniGelen.length>0) {
        db.analizler = [...(db.analizler||[]),...yeniGelen];
        db.analizler.sort((a,b)=>new Date(b.tarih)-new Date(a.tarih));
        writeDB(db);
        console.log(`[Geçiş] ${yeniGelen.length} eski kayıt aktarıldı`);
      }
    }
  } catch {}
  return db;
}
function writeDB(d) { fs.writeFileSync(DB_FILE, JSON.stringify(d,null,2),'utf8'); }

function extractJSON(text) {
  try { return JSON.parse(text.trim()); } catch {}
  const f = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (f) try { return JSON.parse(f[1].trim()); } catch {}
  const b = text.match(/\{[\s\S]*\}/);
  if (b) try { return JSON.parse(b[0]); } catch {}
  return null;
}

function koordinatBolge(lat,lon) {
  lat=parseFloat(lat); lon=parseFloat(lon);
  if(isNaN(lat)||isNaN(lon)) return 'Turkiye';
  if(lat>41) return 'Kuzey Karadeniz';
  if(lat<37&&lon<32) return 'Ege Akdeniz sahili';
  if(lat<37&&lon>36) return 'Guneydogu Anadolu';
  if(lat<38&&lon>30) return 'Ic Anadolu Akdeniz gecis';
  if(lon<30) return 'Ege Bolgesi Izmir Manisa';
  if(lon>38) return 'Dogu Anadolu';
  return 'Ic Anadolu';
}

app.use(cors());
app.use(express.json({ limit:'50mb' }));
app.use(express.static(path.join(__dirname)));

const TOPRAK_SCHEMA = `{"bolge_adi":"...","iklim_tipi":"...","yillik_yagis":"...","toprak_tipi":"...","ph_mevcut":"...","ph_ideal":"6.5-7.5","ph_durumu":"uygun/hafif alkali/cok alkali/asidik","organik_madde":"Dusuk/Orta/Yuksek","drenaj":"Iyi/Orta/Zayif","tuzluluk_riski":"Dusuk/Orta/Yuksek","genel_puan":75,"genel_yorum":"...","eksik_besinler":[{"besin":"...","mevcut_deger":"...","ideal_deger":"...","belirti":"...","oneri":"..."}],"iyilestirme_adimlari":[{"kategori":"...","oncelik":"Acil/Orta Vadeli/Uzun Vadeli","uygulama":"...","miktar":"...","zamanlama":"..."}],"mevsimsel_takvim":{"ilkbahar":"...","yaz":"...","sonbahar":"...","kis":"..."},"yerel_kaynaklar":"...","uyari":"...","pdf_ozeti":""}`;

const CONFIG_FILE = path.join(__dirname, 'bahce_config.json');

function readConfig() {
  // Öncelik sırası: 1) Env variables (Railway'de kalıcı), 2) Config dosyası (lokal)
  const envCfg = {
    sbUrl: process.env.SB_URL || '',
    sbKey: process.env.SB_KEY || '',
  };
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8'));
      // Env var varsa onu tercih et, yoksa dosyadakini kullan
      return {
        sbUrl: envCfg.sbUrl || fileCfg.sbUrl || '',
        sbKey: envCfg.sbKey || fileCfg.sbKey || '',
      };
    }
  } catch {}
  return envCfg;
}

function writeConfig(c) {
  // Dosyaya yaz (lokal çalışma için). Railway'de env variable kullanılmalı.
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(c,null,2),'utf8'); } catch {}
}

app.get('/health', (_,res) => res.json({ status:'ok', version:'5.1' }));

// ── SUNUCU TARAFLI CONFIG (Railway'de tüm cihazlar paylaşır) ─────────────────
app.get('/api/config', (req,res) => {
  const cfg = readConfig();
  // Tam config'i döndür — tek kullanıcı/güvenilir ekip için uygundur
  res.json({ sbUrl: cfg.sbUrl||'', sbKey: cfg.sbKey||'' });
});

app.post('/api/config', (req,res) => {
  const { sbUrl, sbKey } = req.body;
  if (!sbUrl || !sbKey) return res.status(400).json({ error:'sbUrl ve sbKey gerekli.' });
  const cfg = readConfig();
  cfg.sbUrl = sbUrl.trim().replace(/\/$/,'');
  cfg.sbKey = sbKey.trim();
  writeConfig(cfg);
  res.json({ ok:true });
});

// Config'den sbUrl/sbKey oku (sync endpoint'leri için)
function getSbConfig(body) {
  if (body && body.sbUrl && body.sbKey) return { sbUrl: body.sbUrl, sbKey: body.sbKey };
  const cfg = readConfig();
  return { sbUrl: cfg.sbUrl||'', sbKey: cfg.sbKey||'' };
}

// ── GEOCODİNG ────────────────────────────────────────────────────────────────
app.get('/api/geocode', (req,res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error:'q gerekli' });
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5&countrycodes=tr&accept-language=tr`;
  https.get(url,{headers:{'User-Agent':'BahceDanismani/5.0'}}, r=>{
    let d=''; r.on('data',c=>d+=c);
    r.on('end',()=>{
      try { res.json(JSON.parse(d).map(r=>({ad:r.display_name,lat:parseFloat(r.lat),lon:parseFloat(r.lon)}))); }
      catch { res.status(500).json({error:'Geocoding hatası'}); }
    });
  }).on('error',e=>res.status(500).json({error:e.message}));
});

// ── HASTALIK TEŞHİSİ ─────────────────────────────────────────────────────────
app.post('/api/teshis', async (req,res) => {
  try {
    const { fotograflar, mimeType='image/jpeg', fotografTuru='genel', meyve='diger', sesYazisi='' } = req.body;
    const gorselListesi = fotograflar||(req.body.imageBase64?[req.body.imageBase64]:[]);
    if (!gorselListesi.length) return res.status(400).json({ error:'Görsel gerekli.' });
    const meyveBilgi = {seftali:'Standart seftali',seftali_zodiac:'Yassi seftali Zodiac',seftali_osiris:'Yassi seftali Osiris',nektarin_gartario:'Nektarin Gartario',nektarin_boreal:'Nektarin Boreal',yassi_nektarin_luisella:'Yassi nektarin Luisella',kayisi_orange_ruby:'Kayisi Orange Ruby',mandalina_wmurcot:'Mandalina W-Murcot',nar_hicaz:'Hicaz Nar',nar_early_wonderful:'Erkenci Nar',hurma_rojo_brillante:'Hurma Rojo Brillante',erik:'Erik',erik_can:'Can erigi',erik_japon:'Japon erigi',kiraz:'Kiraz',kiraz_0900:'Kiraz 0900 Ziraat',kiraz_lambert:'Kiraz Lambert',elma:'Elma',elma_fuji:'Elma Fuji',elma_golden:'Elma Golden',elma_granny:'Elma Granny Smith',elma_starking:'Elma Starking',armut:'Armut',armut_deveci:'Armut Deveci',armut_santa:'Armut Santa Maria',ayva:'Ayva',ayva_ekmek:'Ekmek Ayvasi',uzum:'Uzum',uzum_sultani:'Uzum Sultani',uzum_hamburg:'Uzum Hamburg',uzum_razaki:'Uzum Razaki',incir:'Incir',incir_sarilop:'Incir Sarilop',incir_bursa:'Incir Bursa Siyahi',zeytin:'Zeytin',zeytin_ayvalik:'Zeytin Ayvalik',zeytin_memecik:'Zeytin Memecik',zeytin_gemlik:'Zeytin Gemlik',diger:'Diger'};
    const meyveAdi = meyveBilgi[meyve]||meyve;
    const model = genAI.getGenerativeModel({ model:'gemini-2.5-flash' });
    const content = [
      `Deneyimli meyve bahcesi hastalik uzmani. Cesit: ${meyveAdi}. Fotograf: ${fotografTuru}. ${sesYazisi?'Not: '+sesYazisi:''} ${gorselListesi.length>1?gorselListesi.length+' fotograf.':''}\nYALNIZCA JSON:\n{"durum":"saglikli/uyari/tehlike","tespit":"...","guven_skoru":"%87","siddet":"Hafif/Orta/Ciddi/Kritik","siddet_yuzdesi":50,"etkilened_bolge":"...","aciklama":"...","kulturel_onlem":"...","biyolojik_onlem":"...","kimyasal_onlem":"...","acil_mi":false,"referans":"...","tedavi_suresi":"..."}`,
      ...gorselListesi.map(b64=>({inlineData:{data:b64.includes(',')?b64.split(',')[1]:b64,mimeType}}))
    ];
    const result = await model.generateContent(content);
    const parsed = extractJSON(result.response.text());
    if (!parsed) return res.status(500).json({ error:'Yanıt işlenemedi.' });
    res.json(parsed);
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ── FOTO KARŞILAŞTIRMA ───────────────────────────────────────────────────────
app.post('/api/karsilastir', async (req,res) => {
  try {
    const { foto1, foto2, aralikGun=7 } = req.body;
    if (!foto1||!foto2) return res.status(400).json({ error:'İki fotoğraf gerekli.' });
    const model = genAI.getGenerativeModel({ model:'gemini-2.5-flash' });
    const result = await model.generateContent([
      `Bitki patolojisi uzmani. Ayni agactan ${aralikGun} gun arayla fotograf. YALNIZCA JSON:\n{"sonuc":"iyilesti/kotu_gitti/degismedi","degisim_yuzdesi":20,"gozlemler":"...","oneri":"...","acil_mi":false}`,
      {inlineData:{data:foto1.includes(',')?foto1.split(',')[1]:foto1,mimeType:'image/jpeg'}},
      {inlineData:{data:foto2.includes(',')?foto2.split(',')[1]:foto2,mimeType:'image/jpeg'}},
    ]);
    const parsed = extractJSON(result.response.text());
    if (!parsed) return res.status(500).json({ error:'İşlenemedi.' });
    res.json(parsed);
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ── TOPRAK — KONUM ───────────────────────────────────────────────────────────
app.post('/api/toprak', async (req,res) => {
  try {
    const { lat, lon, bolgeAdi='', mevsim='', yil=new Date().getFullYear(), bahceAdi='', sulama='', gubre='', sorun='' } = req.body;
    if (!lat||!lon) return res.status(400).json({ error:'lat ve lon zorunlu.' });
    const bolge = bolgeAdi||koordinatBolge(lat,lon);
    const model = genAI.getGenerativeModel({ model:'gemini-2.5-flash' });
    const result = await model.generateContent(
      `Deneyimli toprak bilimi ve meyve yetistiriciligi uzmani.\nKoordinat: ${parseFloat(lat).toFixed(4)}K ${parseFloat(lon).toFixed(4)}D | Bolge: ${bolge}\nMevsim: ${mevsim||'?'} ${yil} | Bahce: ${bahceAdi||'?'} | Sulama: ${sulama||'?'}\nSon gubre: ${gubre||'?'} | Sorunlar: ${sorun||'yok'}\nYALNIZCA JSON: ${TOPRAK_SCHEMA}`
    );
    const parsed = extractJSON(result.response.text());
    if (!parsed) return res.status(500).json({ error:'İşlenemedi.' });
    const db = readDB();
    const kayit = { id:Date.now(), tarih:new Date().toISOString(), yil:parseInt(yil)||new Date().getFullYear(), mevsim:mevsim||'Belirtilmedi', bahceAdi:bahceAdi||('Bahçe '+(db.analizler.length+1)), lat:parseFloat(lat), lon:parseFloat(lon), bolgeAdi:bolge, kaynak:'manuel', sulama, gubre, sorun, sonuc:parsed };
    db.analizler.unshift(kayit); writeDB(db);
    res.json({ ...parsed, _id:kayit.id, _kaydedildi:true });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ── TOPRAK — PDF ─────────────────────────────────────────────────────────────
app.post('/api/toprak-pdf', async (req,res) => {
  try {
    const { pdfBase64, bahceAdi='', yil=new Date().getFullYear(), mevsim='', lat='', lon='', sulama='', gubre='', sorun='' } = req.body;
    if (!pdfBase64) return res.status(400).json({ error:'pdfBase64 zorunlu.' });
    const cleanB64 = pdfBase64.includes(',')?pdfBase64.split(',')[1]:pdfBase64;
    const bolge = (lat&&lon)?koordinatBolge(lat,lon):'PDF raporuna göre';
    const model = genAI.getGenerativeModel({ model:'gemini-2.5-flash' });
    const result = await model.generateContent([
      `Toprak bilimi uzmani. PDF raporunu oku, parametreleri aynen oku. Bahce: ${bahceAdi||'?'} | Bolge: ${bolge} | Mevsim: ${mevsim||'?'} ${yil}\nYALNIZCA JSON: ${TOPRAK_SCHEMA}`,
      {inlineData:{data:cleanB64,mimeType:'application/pdf'}}
    ]);
    const parsed = extractJSON(result.response.text());
    if (!parsed) return res.status(500).json({ error:'PDF işlenemedi.' });
    const db = readDB();
    const kayit = { id:Date.now(), tarih:new Date().toISOString(), yil:parseInt(yil)||new Date().getFullYear(), mevsim:mevsim||'Belirtilmedi', bahceAdi:bahceAdi||('Bahçe '+(db.analizler.length+1)), lat:parseFloat(lat)||null, lon:parseFloat(lon)||null, bolgeAdi:bolge, kaynak:'pdf', sulama, gubre, sorun, sonuc:parsed };
    db.analizler.unshift(kayit); writeDB(db);
    res.json({ ...parsed, _id:kayit.id, _kaydedildi:true });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ── YABANİ OT ────────────────────────────────────────────────────────────────
app.post('/api/yabani-ot', async (req,res) => {
  try {
    const { imageBase64, mimeType='image/jpeg', bahceTipi='genel', sulama='', toprakTipi='' } = req.body;
    if (!imageBase64) return res.status(400).json({ error:'imageBase64 zorunlu.' });
    const model = genAI.getGenerativeModel({ model:'gemini-2.5-flash' });
    const result = await model.generateContent([
      `Yabani ot yonetimi uzmani. Bahce: ${bahceTipi} | Sulama: ${sulama||'?'} | Toprak: ${toprakTipi||'?'}\nYALNIZCA JSON:\n{"tespit_edilen_otlar":[{"adi":"...","latince":"...","tehlike_seviyesi":"Dusuk/Orta/Yuksek","zarar":"..."}],"yogunluk":"Seyrek/Orta/Yogun","yogunluk_yuzdesi":40,"acil_mi":false,"genel_yorum":"...","kulturel_mucadele":["..."],"biyolojik_mucadele":["..."],"kimyasal_mucadele":[{"etken_madde":"...","uygulama":"...","dikkat":"..."}],"oncelikli_adimlar":["..."],"mevsimsel_takvim":{"ilkbahar":"...","yaz":"...","sonbahar":"...","kis":"..."}}`,
      {inlineData:{data:imageBase64.includes(',')?imageBase64.split(',')[1]:imageBase64,mimeType}}
    ]);
    const parsed = extractJSON(result.response.text());
    if (!parsed) return res.status(500).json({ error:'İşlenemedi.' });
    res.json(parsed);
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ── HAVA DURUMU ──────────────────────────────────────────────────────────────
app.get('/api/hava', (req,res) => {
  const { lat, lon } = req.query;
  if (!lat||!lon) return res.status(400).json({ error:'lat ve lon gerekli.' });

  // Open-Meteo: günlük + SAATLİK veri — iOS/Foreca kalitesinde
  const current = [
    'temperature_2m','relative_humidity_2m','apparent_temperature',
    'precipitation','wind_speed_10m','wind_gusts_10m','wind_direction_10m',
    'weather_code','cloud_cover','surface_pressure','visibility'
  ].join(',');

  const daily = [
    'weather_code','temperature_2m_max','temperature_2m_min',
    'apparent_temperature_max','apparent_temperature_min',
    'precipitation_sum','precipitation_hours','precipitation_probability_max',
    'wind_speed_10m_max','wind_gusts_10m_max','wind_direction_10m_dominant',
    'uv_index_max','sunrise','sunset',
    'et0_fao_evapotranspiration',
    'relative_humidity_2m_max','relative_humidity_2m_min',
    'shortwave_radiation_sum'
  ].join(',');

  // Saatlik: yağış + rüzgar + nem + sıcaklık — kuru pencere tespiti için
  const hourly = [
    'temperature_2m','precipitation','precipitation_probability',
    'wind_speed_10m','weather_code','relative_humidity_2m','visibility'
  ].join(',');

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + `&current=${current}&daily=${daily}&hourly=${hourly}`
    + `&timezone=auto&forecast_days=16&wind_speed_unit=kmh`;

  https.get(url, r=>{
    let d=''; r.on('data',c=>d+=c);
    r.on('end',()=>{
      try {
        const p = JSON.parse(d);
        const wmo = {
          0:'Açık',1:'Çoğunlukla Açık',2:'Parçalı Bulutlu',3:'Kapalı',
          45:'Sis',48:'Kırağılı Sis',
          51:'Hafif Çisenti',53:'Çisenti',55:'Yoğun Çisenti',
          61:'Hafif Yağmur',63:'Yağmurlu',65:'Kuvvetli Yağmur',
          71:'Hafif Kar',73:'Kar',75:'Yoğun Kar',
          80:'Hafif Sağanak',81:'Sağanak',82:'Şiddetli Sağanak',
          85:'Hafif Kar Sağanağı',86:'Kar Sağanağı',
          95:'Fırtına',96:'Dolulu Fırtına',99:'Şiddetli Fırtına'
        };
        const gunler = ['Paz','Pzt','Sal','Çar','Per','Cum','Cmt'];
        const cur = p.current||{};
        const daily_d = p.daily||{};
        const hourly_d = p.hourly||{};

        // ── Saatlik verileri tarihe göre grupla ─────────────────────────────
        // { '2025-03-22': [{saat:'06:00', yagis:0.2, ruzgar:8, ...}, ...] }
        const saatlikGruplar = {};
        (hourly_d.time||[]).forEach((zaman, i) => {
          const tarih = zaman.slice(0,10); // YYYY-MM-DD
          const saat  = zaman.slice(11,16); // HH:MM
          if (!saatlikGruplar[tarih]) saatlikGruplar[tarih] = [];
          saatlikGruplar[tarih].push({
            saat,
            sicaklik : +(hourly_d.temperature_2m?.[i]??0).toFixed(1),
            yagis    : +(hourly_d.precipitation?.[i]??0).toFixed(2),
            yagisOlas: hourly_d.precipitation_probability?.[i]??0,
            ruzgar   : Math.round(hourly_d.wind_speed_10m?.[i]??0),
            nem      : hourly_d.relative_humidity_2m?.[i]??50,
            kod      : hourly_d.weather_code?.[i]??0,
            gorus    : hourly_d.visibility?.[i]??null,
          });
        });

        // ── Gün içi kuru pencere hesapla ────────────────────────────────────
        // Sabah (05–11) ve akşam (17–21) arası yağış < 0.1mm + rüzgar < 25 km/s
        function kuruPencere(tarih) {
          const saatler = saatlikGruplar[tarih] || [];
          const kontrol = (minSaat, maxSaat) => saatler
            .filter(s => s.saat >= minSaat && s.saat <= maxSaat)
            .filter(s => s.yagis < 0.1 && s.ruzgar < 25 && ![61,63,65,80,81,82,95,96,99].includes(s.kod));

          const sabahKuru  = kontrol('05:00','10:00');
          const aksamKuru  = kontrol('17:00','21:00');
          const uygunSaatler = [];
          if (sabahKuru.length >= 3) uygunSaatler.push(`Sabah ${sabahKuru[0].saat}–${sabahKuru[sabahKuru.length-1].saat}`);
          if (aksamKuru.length >= 2) uygunSaatler.push(`Akşam ${aksamKuru[0].saat}–${aksamKuru[aksamKuru.length-1].saat}`);
          return uygunSaatler; // boş ise pencere yok
        }

        // ── Günlük nem max/min ───────────────────────────────────────────────
        const nemMaxArr = daily_d.relative_humidity_2m_max || [];
        const nemMinArr = daily_d.relative_humidity_2m_min || [];

        // ── 16 Günlük tahmin dizisi ──────────────────────────────────────────
        const tahmin = (daily_d.time||[]).map((t,i) => {
          const pencereler = kuruPencere(t);
          return {
            tarih       : t,
            gun         : gunler[new Date(t).getDay()],
            tarihFmt    : new Date(t).toLocaleDateString('tr-TR',{day:'2-digit',month:'short'}),
            durum       : wmo[daily_d.weather_code[i]] || '—',
            kod         : daily_d.weather_code[i],
            maxTemp     : Math.round(daily_d.temperature_2m_max[i]||0),
            minTemp     : Math.round(daily_d.temperature_2m_min[i]||0),
            hissMaxTemp : daily_d.apparent_temperature_max ? Math.round(daily_d.apparent_temperature_max[i]||0) : null,
            hissMinTemp : daily_d.apparent_temperature_min ? Math.round(daily_d.apparent_temperature_min[i]||0) : null,
            yagis       : +(daily_d.precipitation_sum[i]||0).toFixed(1),
            yagisOlasiligi : daily_d.precipitation_probability_max ? daily_d.precipitation_probability_max[i] : null,
            yagis_saat  : daily_d.precipitation_hours ? +(daily_d.precipitation_hours[i]||0) : null,
            ruzgar      : Math.round(daily_d.wind_speed_10m_max[i]||0),
            ruzgarMax   : Math.round(daily_d.wind_speed_10m_max[i]||0),
            ruzgarHamle : Math.round(daily_d.wind_gusts_10m_max[i]||0),
            ruzgarYon   : daily_d.wind_direction_10m_dominant ? daily_d.wind_direction_10m_dominant[i] : null,
            uvMax       : daily_d.uv_index_max ? +(daily_d.uv_index_max[i]||0).toFixed(1) : null,
            nemMax      : nemMaxArr[i] ?? null,
            nemMin      : nemMinArr[i] ?? null,
            gunes       : daily_d.shortwave_radiation_sum ? +(daily_d.shortwave_radiation_sum[i]||0).toFixed(0) : null,
            et0         : daily_d.et0_fao_evapotranspiration ? +(daily_d.et0_fao_evapotranspiration[i]||0).toFixed(1) : null,
            gunesDogu   : daily_d.sunrise ? daily_d.sunrise[i] : null,
            gunesBatis  : daily_d.sunset  ? daily_d.sunset[i]  : null,
            // Kuru pencere saatleri (hafif yağışlı günler için ilaçlama fırsatı)
            kuruPencereler : pencereler,
            saatlik     : (saatlikGruplar[t]||[]).map(s=>({
              saat:s.saat, sicaklik:s.sicaklik, yagis:s.yagis,
              ruzgar:s.ruzgar, nem:s.nem, kod:s.kod
            })),
          };
        });

        // ── Anlık veri ───────────────────────────────────────────────────────
        const anlik = {
          sicaklik    : Math.round(cur.temperature_2m||0),
          hissedilen  : Math.round(cur.apparent_temperature||cur.temperature_2m||0),
          nem         : cur.relative_humidity_2m||0,
          yagis       : +(cur.precipitation||0).toFixed(1),
          ruzgar      : Math.round(cur.wind_speed_10m||0),
          ruzgarHamle : Math.round(cur.wind_gusts_10m||0),
          ruzgarYon   : cur.wind_direction_10m||0,
          bulutluluk  : cur.cloud_cover??null,
          basinc      : cur.surface_pressure ? Math.round(cur.surface_pressure) : null,
          gorus       : cur.visibility ? (+(cur.visibility/1000).toFixed(1)) : null,
          durum       : wmo[cur.weather_code]||'—',
          kod         : cur.weather_code,
        };

        res.json({
          anlik,
          tahmin,
          uyarilar : [], // frontend kendi üretiyor
          meta     : {
            kaynak      : 'Open-Meteo',
            guncelleme  : new Date().toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'}),
            lat         : parseFloat(lat).toFixed(4),
            lon         : parseFloat(lon).toFixed(4),
          }
        });
      } catch(e){
        console.error('Hava hatası:',e.message);
        res.status(500).json({error:'Hava verisi işlenemedi: '+e.message});
      }
    });
  }).on('error',e=>res.status(500).json({error:e.message}));
});

// ── TAKVİM ───────────────────────────────────────────────────────────────────
app.post('/api/takvim-olustur', async (req,res) => {
  try {
    const { meyveler=[], bolge='', yil=new Date().getFullYear(), sulama='', toprakBilgi='' } = req.body;
    const model = genAI.getGenerativeModel({ model:'gemini-2.5-flash' });
    const result = await model.generateContent(
      `Meyve bahcesi agronomisti. Meyveler: ${meyveler.join(', ')||'Karisik'}. Bolge: ${bolge||'Turkiye'}. Yil: ${yil}. Sulama: ${sulama||'?'}. Toprak: ${toprakBilgi||'?'}.\nYALNIZCA JSON:\n{"takvim":[{"ay":1,"ayAdi":"Ocak","isler":[{"kategori":"Budama/Sulama/Ilaclama/Gubleme/Hasat/Diger","is":"...","oncelik":"Zorunlu/Onemli/Opsiyonel"}]}],"genel_notlar":"...","kritik_tarihler":["..."]}`
    );
    const parsed = extractJSON(result.response.text());
    if (!parsed) return res.status(500).json({ error:'Takvim oluşturulamadı.' });
    const db=readDB(); db.takvim=parsed; writeDB(db);
    res.json(parsed);
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ── TEDAVİ ───────────────────────────────────────────────────────────────────
app.post('/api/tedavi', (req,res) => {
  const db=readDB();
  if(!db.tedaviler) db.tedaviler=[];
  const k={id:Date.now(),tarih:new Date().toISOString(),...req.body};
  db.tedaviler.unshift(k); writeDB(db); res.json({ok:true,id:k.id});
});
app.get('/api/tedavi', (req,res)=>{ const db=readDB(); res.json(db.tedaviler||[]); });
app.delete('/api/tedavi/:id', (req,res)=>{ const db=readDB(); db.tedaviler=(db.tedaviler||[]).filter(t=>String(t.id)!==req.params.id); writeDB(db); res.json({silindi:true}); });

// ── BAHÇELER ─────────────────────────────────────────────────────────────────
app.get('/api/agaclar', (req,res)=>{ const db=readDB(); res.json(db.agaclar||[]); });
app.post('/api/agaclar', (req,res)=>{ const db=readDB(); const k={id:Date.now(),eklenme:new Date().toISOString(),...req.body}; if(!db.agaclar) db.agaclar=[]; db.agaclar.push(k); writeDB(db); res.json(k); });
app.patch('/api/agaclar/:id', (req,res)=>{ const db=readDB(); const a=(db.agaclar||[]).find(x=>String(x.id)===req.params.id); if(!a) return res.status(404).json({error:'Bulunamadı.'}); Object.assign(a,req.body); writeDB(db); res.json(a); });
app.delete('/api/agaclar/:id', (req,res)=>{ const db=readDB(); db.agaclar=(db.agaclar||[]).filter(a=>String(a.id)!==req.params.id); writeDB(db); res.json({silindi:true}); });

// ── VERİM ─────────────────────────────────────────────────────────────────────
app.get('/api/verim', (req,res)=>{ const db=readDB(); res.json(db.verim||[]); });
app.post('/api/verim', (req,res)=>{ const db=readDB(); const k={id:Date.now(),tarih:new Date().toISOString(),...req.body}; if(!db.verim) db.verim=[]; db.verim.unshift(k); writeDB(db); res.json(k); });
app.delete('/api/verim/:id', (req,res)=>{ const db=readDB(); db.verim=(db.verim||[]).filter(v=>String(v.id)!==req.params.id); writeDB(db); res.json({silindi:true}); });

// ── ARŞİV ─────────────────────────────────────────────────────────────────────
app.get('/api/arsiv', (req,res)=>{ const db=readDB(); const ozet=(db.analizler||[]).map(({id,tarih,yil,mevsim,bahceAdi,lat,lon,bolgeAdi,kaynak,sonuc})=>({id,tarih,yil,mevsim,bahceAdi,lat,lon,bolgeAdi,kaynak,genel_puan:sonuc?.genel_puan,bolge_adi:sonuc?.bolge_adi||bolgeAdi,ph_mevcut:sonuc?.ph_mevcut,organik_madde:sonuc?.organik_madde,genel_yorum:sonuc?.genel_yorum})); res.json({analizler:ozet,toplam:ozet.length}); });
app.get('/api/arsiv/:id', (req,res)=>{ const db=readDB(); const k=(db.analizler||[]).find(a=>String(a.id)===req.params.id); if(!k) return res.status(404).json({error:'Bulunamadı.'}); res.json(k); });
app.delete('/api/arsiv/:id', (req,res)=>{ const db=readDB(); db.analizler=(db.analizler||[]).filter(a=>String(a.id)!==req.params.id); writeDB(db); res.json({silindi:true}); });

// ── RAPOR ─────────────────────────────────────────────────────────────────────
app.get('/api/rapor/:yil', (req,res)=>{ const yil=parseInt(req.params.yil),db=readDB(); res.json({yil,analizler:(db.analizler||[]).filter(a=>a.yil===yil),verimler:(db.verim||[]).filter(v=>new Date(v.tarih).getFullYear()===yil),tedaviler:(db.tedaviler||[]).filter(t=>new Date(t.tarih).getFullYear()===yil),agaclar:db.agaclar||[]}); });

// ── SUPABASE MANUEL SYNC ─────────────────────────────────────────────────────
async function sbRequest(sbUrl,sbKey,tablo,method='GET',data=null,upsert=false) {
  return new Promise((resolve,reject)=>{
    const reqUrl=new URL(`${sbUrl}/rest/v1/${tablo}`);
    const headers={'apikey':sbKey,'Authorization':'Bearer '+sbKey,'Content-Type':'application/json','Prefer':upsert?'resolution=merge-duplicates,return=minimal':'return=minimal'};
    const body=data?JSON.stringify(data):null;
    const opts={hostname:reqUrl.hostname,path:reqUrl.pathname+reqUrl.search,method,headers:{...headers,'Content-Length':body?Buffer.byteLength(body):0}};
    const req=require('https').request(opts,res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{if(res.statusCode>=400)return reject(new Error(`${tablo} ${res.statusCode}: ${d}`));try{resolve(d?JSON.parse(d):[]);}catch{resolve([]); }});});
    req.on('error',reject); if(body) req.write(body); req.end();
  });
}

app.post('/api/sync/gonder', async (req,res)=>{
  try {
    const {sbUrl,sbKey}=req.body;
    if(!sbUrl||!sbKey) return res.status(400).json({error:'sbUrl ve sbKey gerekli.'});
    const db=readDB(); const sonuclar={};
    const tablolar=[{key:'analizler',sb:'analizler'},{key:'agaclar',sb:'agaclar'},{key:'verim',sb:'verim'},{key:'tedaviler',sb:'tedaviler'}];
    for(const {key,sb} of tablolar){
      const kayitlar=(db[key]||[]).map(k=>{const c={...k};if(c.sonuc&&typeof c.sonuc==='object')c.sonuc=JSON.stringify(c.sonuc);if(c.yapan&&typeof c.yapan==='object')c.yapan=JSON.stringify(c.yapan);return c;});
      if(kayitlar.length>0){const batches=[];for(let i=0;i<kayitlar.length;i+=500)batches.push(kayitlar.slice(i,i+500));for(const batch of batches)await sbRequest(sbUrl,sbKey,sb,'POST',batch,true);}
      sonuclar[key]=kayitlar.length;
    }
    res.json(sonuclar);
  } catch(err){console.error('Sync gönder:',err.message);res.status(500).json({error:err.message});}
});

app.post('/api/sync/cek', async (req,res)=>{
  try {
    const {sbUrl,sbKey}=req.body;
    if(!sbUrl||!sbKey) return res.status(400).json({error:'sbUrl ve sbKey gerekli.'});
    const db=readDB(); const sonuclar={};
    const tablolar=[{key:'analizler',sb:'analizler'},{key:'agaclar',sb:'agaclar'},{key:'verim',sb:'verim'},{key:'tedaviler',sb:'tedaviler'}];
    for(const {key,sb} of tablolar){
      const sbKayitlar=await sbRequest(sbUrl,sbKey,sb);
      if(!Array.isArray(sbKayitlar)){sonuclar[key]=0;continue;}
      const mevcutIdler=new Set((db[key]||[]).map(k=>String(k.id)));
      for(const sk of sbKayitlar){
        const yerel={...sk};if(yerel.sonuc&&typeof yerel.sonuc==='string'){try{yerel.sonuc=JSON.parse(yerel.sonuc);}catch{}}
        if(!mevcutIdler.has(String(yerel.id))){if(!db[key])db[key]=[];db[key].push(yerel);}
        else{const idx=(db[key]||[]).findIndex(k=>String(k.id)===String(yerel.id));if(idx>=0&&new Date(yerel.tarih||0)>new Date(db[key][idx].tarih||0))db[key][idx]=yerel;}
      }
      if(db[key])db[key].sort((a,b)=>new Date(b.tarih||0)-new Date(a.tarih||0));
      sonuclar[key]=sbKayitlar.length;
    }
    writeDB(db); res.json(sonuclar);
  } catch(err){console.error('Sync çek:',err.message);res.status(500).json({error:err.message});}
});

app.listen(PORT,()=>{
  const cfg = readConfig();
  const isRailway = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RAILWAY_SERVICE_NAME;
  console.log(`\n🌿 Bahçe Danışmanı v5.1 — ${isRailway ? 'Railway' : 'http://localhost:'+PORT}`);
  console.log(`   Gemini API : ${GEMINI_API_KEY ? '✅ Tanımlı' : '❌ Eksik (GEMINI_API_KEY)'}`);
  console.log(`   Supabase   : ${cfg.sbUrl ? '✅ '+cfg.sbUrl.slice(0,40)+'...' : '⚠️  Tanımlı değil (SB_URL + SB_KEY env ekleyin)'}`);
  if (isRailway) {
    console.log(`   ⚠️  Railway: Dosya sistemi ephemeral — veriler deploy'da sıfırlanır.`);
    console.log(`   💡 Kalıcı veri için: Railway → Variables → SB_URL ve SB_KEY ekleyin.`);
  }
  console.log('');
});
