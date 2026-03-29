const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

const TELEGRAM_TOKEN = process.env.TOKEN;
const TELEGRAM_CHAT_ID = process.env.ID;
const GEMINI_API_KEY = process.env.API;
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent';

const blockedIPs = new Set();
let globalRateLimitUntil = 0;
const MAX_CONCURRENT = 3;
let activeRequests = 0;
let requestQueue = [];

function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || req.ip || 'unknown';
}

async function sendTelegramNotification(message) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text: message },
      { timeout: 5000 }
    );
  } catch (err) {
    console.error('❌ فشل إرسال إشعار:', err.message);
  }
}

function blockAndNotify(ip, reason, req, body = null) {
  if (blockedIPs.has(ip)) return;
  blockedIPs.add(ip);
  const ua = req.headers['user-agent'] || 'غير معروف';
  const ts = new Date().toISOString();
  let details = '';
  if (body) {
    if (body.data) details += `\n📝 نص: ${body.data.substring(0, 300)}${body.data.length>300?'...':''}`;
    if (body.PDF_BASE64) details += `\n📄 PDF: ${Math.round(body.PDF_BASE64.length*0.75/1024)} KB`;
  }
  const msg = `🚨 حظر IP 🚨\nالسبب: ${reason}\nIP: ${ip}\nالمتصفح: ${ua}\nالوقت: ${ts}${details}`;
  sendTelegramNotification(msg);
}

app.use((req, res, next) => {
  if (blockedIPs.has(getClientIP(req))) return res.status(403).json({ error: 'IP blocked' });
  next();
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.header('Access-Control-Allow-Origin', origin || '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '500mb' }));

async function sendToGemini(prompt, pdfBase64) {
  const parts = [{ text: prompt }];
  if (pdfBase64) parts.push({ inline_data: { mime_type: 'application/pdf', data: pdfBase64 } });
  const body = { contents: [{ parts }], generationConfig: { temperature: 0.1, maxOutputTokens: 4000 } };
  const res = await axios.post(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, body, { headers: { 'Content-Type':'application/json' }, timeout: 300000 });
  if (res.data?.candidates?.[0]) return res.data.candidates[0].content.parts[0].text;
  throw new Error('INVALID_GEMINI_RESPONSE');
}

function applyGlobalFailure() {
  globalRateLimitUntil = Date.now() + 12000;
  while (requestQueue.length) {
    const job = requestQueue.shift();
    if (!job.res.headersSent) job.res.status(503).send('السيرفر مشغول، أعد المحاولة في وقت لاحق');
  }
}

function processQueue() {
  if (activeRequests >= MAX_CONCURRENT) return;
  if (Date.now() < globalRateLimitUntil) return setTimeout(processQueue, globalRateLimitUntil - Date.now());
  if (!requestQueue.length) return;

  while (activeRequests < MAX_CONCURRENT && requestQueue.length) {
    const job = requestQueue.shift();
    activeRequests++;
    (async () => {
      try {
        const result = await sendToGemini(job.prompt, job.pdf);
        if (!job.res.headersSent) {
          job.res.set('Content-Type','text/plain; charset=utf-8');
          job.res.send(result);
        }
      } catch (err) {
        applyGlobalFailure();
      } finally {
        activeRequests--;
        setTimeout(processQueue, 3000);
      }
    })();
  }
}

app.post('/api/KIMO_DEV', (req, res) => {
  const ip = getClientIP(req);
  const { id, pass, data, PDF_BASE64 } = req.body;

  if (Date.now() < globalRateLimitUntil) {
    const wait = Math.ceil((globalRateLimitUntil - Date.now()) / 1000);
    return res.status(429).json({ error: `السيرفر مشغول، أعد المحاولة بعد ${wait} ثانية`, retryAfter: wait });
  }

  const hasText = data && data !== '';
  const hasPdf = PDF_BASE64 && PDF_BASE64 !== '';

  if (hasText && !hasPdf) { blockAndNotify(ip,'نص فقط بدون PDF',req,{data,PDF_BASE64}); return res.status(403).json({error:'نص فقط بدون ملف PDF - تم حظرك'}); }
  if (!hasText && hasPdf) { blockAndNotify(ip,'PDF فقط بدون نص',req,{data,PDF_BASE64}); return res.status(403).json({error:'PDF فقط بدون نص - تم حظرك'}); }
  if (!hasText && !hasPdf) { blockAndNotify(ip,'طلب فارغ',req,{data,PDF_BASE64}); return res.status(403).json({error:'طلب فارغ - تم حظرك'}); }
  if (!id || !pass) { blockAndNotify(ip,'بدون id/pass',req,{data,PDF_BASE64}); return res.status(403).json({error:'بيانات غير صحيحة'}); }
  if (pass !== id+'abcde57') { blockAndNotify(ip,`pass غير صحيح للمستخدم: ${id}`,req,{data,PDF_BASE64}); return res.status(403).json({error:'بيانات غير صحيحة'}); }

  req.setTimeout(310000);
  requestQueue.push({ res, prompt: data, pdf: PDF_BASE64 });
  setTimeout(processQueue, 3000);
});

app.get('/', (req,res)=>res.status(200).send('Server is running'));
app.get('/api/health',(req,res)=>{
  const now = Date.now();
  res.json({
    status:'online',
    queue_length: requestQueue.length,
    active_requests: activeRequests,
    max_concurrent: MAX_CONCURRENT,
    blocked_ips_count: blockedIPs.size,
    rate_limit_active: globalRateLimitUntil > now,
    rate_limit_remaining_seconds: globalRateLimitUntil>now?Math.ceil((globalRateLimitUntil-now)/1000):0,
    timestamp:new Date().toISOString()
  });
});

app.use('*',(req,res)=>res.status(404).json({error:'Not found'}));

const server = app.listen(PORT,()=>console.log(`✅ Server running on port ${PORT}`));
server.timeout = 320000;
server.keepAliveTimeout = 120000;
