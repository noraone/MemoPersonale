const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const TG_TOKEN = process.env.TG_TOKEN || '8505970290:AAF-cMPbU7KwRmCdDVenXmIbR4IqJUue4Us';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '8684153642';
const DATA_FILE = path.join(__dirname, 'reminders.json');

// ── STORAGE ──────────────────────────────────────────────────────────────────
function loadReminders() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        }
    } catch(e) {}
    return [];
}

function saveReminders(reminders) {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(reminders, null, 2));
    } catch(e) {
        console.error('Errore salvataggio:', e.message);
    }
}

// ── TELEGRAM ─────────────────────────────────────────────────────────────────
function telegramRequest(method, params) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(params);
        const options = {
            hostname: 'api.telegram.org',
            path: `/bot${TG_TOKEN}/${method}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };
        const req = https.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch(e) { resolve({}); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function sendTelegram(text, reminderId) {
    const params = {
        chat_id: TG_CHAT_ID,
        text: text,
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [[
                { text: '✅ Fatto', callback_data: `done_${reminderId}` },
                { text: '⏰ Posticipa 15 min', callback_data: `snooze_${reminderId}` }
            ]]
        }
    };
    return telegramRequest('sendMessage', params);
}

const PUSHCUT_URL = 'https://api.pushcut.io/QUX223nQGufbNsp4ZZAmV/notifications/MemoPersonale';

function sendPushcut(title, text, reminderId) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            title: title,
            text: text,
            isTimeSensitive: true,
            actions: [
                { label: '✅ Fatto', url: 'https://memopersonale.onrender.com/done/' + reminderId },
                { label: '⏰ Posticipa', url: 'https://memopersonale.onrender.com/snooze/' + reminderId }
            ]
        });
        const urlObj = new URL(PUSHCUT_URL);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };
        const req = https.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function getCategoryName(cat) {
    const map = {
        'lavoro': '💼 Lavoro',
        'appuntamenti': '📅 Appuntamenti',
        'cose': '✅ Cose da fare',
        'pagamenti': '💳 Pagamenti'
    };
    return map[cat] || cat;
}

// ── CONTROLLO SCADENZE ────────────────────────────────────────────────────────
function checkDeadlines() {
    const reminders = loadReminders();
    const now = Date.now();
    const ESCALATION_MS = 15 * 60 * 1000; // 15 minuti
    let changed = false;

    reminders.forEach(r => {
        if (r.done) return;
        const dueMs = new Date(r.dateTime).getTime();
        if (isNaN(dueMs)) return;

        // PRIMO AVVISO
        if (!r.notified && now >= dueMs) {
            const timeStr = new Date(r.dateTime).toLocaleString('it-IT', {
                day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
            });
            const msg = `⏰ <b>Promemoria scaduto!</b>\n\n📌 ${r.title}\n🏷 ${getCategoryName(r.category)}\n🕐 ${timeStr}`;
            const titleMsg = '⏰ ' + r.title;
            sendPushcut(titleMsg, getCategoryName(r.category) + ' - ' + timeStr, r.id).then(() => {
                console.log(`✅ Notifica inviata: ${r.title}`);
            }).catch(e => console.error('Errore Pushcut:', e.message));
            r.notified = true;
            r.notifiedAt = now;
            changed = true;
        }

        // RIPETIZIONE ogni 15 minuti se non fatto
        if (r.notified && !r.done && now >= (r.notifiedAt + ESCALATION_MS)) {
            const count = (r.repeatCount || 0) + 1;
            const msg = `🔴 <b>Ancora da fare! (avviso #${count + 1})</b>\n\n📌 ${r.title}\n⚠️ Non hai ancora completato questo promemoria.`;
            sendPushcut('🔴 ' + r.title, 'Avviso #' + (count + 1) + ' - ancora da fare!', r.id).then(() => {
                console.log(`🔴 Escalation #${count} inviata: ${r.title}`);
            }).catch(e => console.error('Errore Pushcut:', e.message));
            r.notifiedAt = now; // resetta il timer per il prossimo avviso
            r.repeatCount = count;
            changed = true;
        }
    });

    if (changed) saveReminders(reminders);
}

// ── WEBHOOK TELEGRAM (pulsanti Fatto/Posticipa) ───────────────────────────────
function handleTelegramUpdate(update) {
    const callback = update.callback_query;
    if (!callback) return;

    const data = callback.data || '';
    const reminders = loadReminders();

    if (data.startsWith('done_')) {
        const id = parseInt(data.replace('done_', ''));
        const r = reminders.find(r => r.id === id);
        if (r) {
            r.done = true;
            saveReminders(reminders);
            telegramRequest('answerCallbackQuery', {
                callback_query_id: callback.id,
                text: '✅ Segnato come fatto!'
            });
            telegramRequest('editMessageText', {
                chat_id: callback.message.chat.id,
                message_id: callback.message.message_id,
                text: `✅ <b>Completato!</b>\n\n📌 ${r.title}`,
                parse_mode: 'HTML'
            });
            console.log(`✅ Completato: ${r.title}`);
        }
    } else if (data.startsWith('snooze_')) {
        const id = parseInt(data.replace('snooze_', ''));
        const r = reminders.find(r => r.id === id);
        if (r) {
            const newTime = Date.now() + 15 * 60 * 1000;
            r.notifiedAt = newTime - 15 * 60 * 1000; // fa sì che il prossimo avviso sia tra 15 min
            r.notified = false; // resetta così riceve nuovo avviso
            const newDateTime = new Date(newTime);
            r.dateTime = new Date(newDateTime.getTime() - newDateTime.getTimezoneOffset() * 60000)
                .toISOString().slice(0, 16);
            saveReminders(reminders);
            telegramRequest('answerCallbackQuery', {
                callback_query_id: callback.id,
                text: '⏰ Posticipato di 15 minuti!'
            });
            telegramRequest('editMessageText', {
                chat_id: callback.message.chat.id,
                message_id: callback.message.message_id,
                text: `⏰ <b>Posticipato!</b>\n\n📌 ${r.title}\nNuovo avviso tra 15 minuti.`,
                parse_mode: 'HTML'
            });
            console.log(`⏰ Posticipato: ${r.title}`);
        }
    }
}

// ── PARSING BODY ──────────────────────────────────────────────────────────────
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch(e) { resolve({}); }
        });
        req.on('error', reject);
    });
}

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Max-Age', '86400');
    

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // Health check
    if (pathname === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('MemoPersonale Server OK');
        return;
    }

    // GET /reminders - leggi tutti i promemoria
    if (pathname === '/reminders' && req.method === 'GET') {
        const reminders = loadReminders();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reminders));
        return;
    }

    // POST /reminders - salva tutti i promemoria (sync dall'app)
    if (pathname === '/reminders' && req.method === 'POST') {
        const body = await parseBody(req);
        if (Array.isArray(body)) {
            saveReminders(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } else {
            res.writeHead(400);
            res.end(JSON.stringify({ ok: false, error: 'Invalid data' }));
        }
        return;
    }

    // POST /webhook - riceve aggiornamenti da Telegram
    if (pathname === '/webhook' && req.method === 'POST') {
        const body = await parseBody(req);
        handleTelegramUpdate(body);
        res.writeHead(204);
        res.end('OK');
        return;
    }

    // GET /done/:id - segna come fatto (da Pushcut)
    if (pathname.startsWith('/done/') && req.method === 'GET') {
        const id = parseInt(pathname.replace('/done/', ''));
        const reminders = loadReminders();
        const r = reminders.find(r => r.id === id);
        if (r) {
            r.done = true;
            saveReminders(reminders);
            console.log(`✅ Completato via Pushcut: ${r.title}`);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h2>✅ Promemoria completato!</h2><p>' + r.title + '</p>');
        } else {
            res.writeHead(404);
            res.end('Non trovato');
        }
        return;
    }

    // GET /snooze/:id - posticipa 15 min (da Pushcut)
    if (pathname.startsWith('/snooze/') && req.method === 'GET') {
        const id = parseInt(pathname.replace('/snooze/', ''));
        const reminders = loadReminders();
        const r = reminders.find(r => r.id === id);
        if (r) {
            const newTime = new Date(Date.now() + 15 * 60 * 1000);
            r.dateTime = new Date(newTime.getTime() - newTime.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
            r.notified = false;
            r.notifiedAt = null;
            saveReminders(reminders);
            console.log(`⏰ Posticipato via Pushcut: ${r.title}`);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h2>⏰ Posticipato di 15 minuti!</h2><p>' + r.title + '</p>');
        } else {
            res.writeHead(404);
            res.end('Non trovato');
        }
        return;
    }

    res.writeHead(404);
    res.end('Not found');
});

server.listen(PORT, () => {
    console.log(`🚀 MemoPersonale Server avviato sulla porta ${PORT}`);
    console.log(`⏰ Controllo scadenze ogni 60 secondi`);
});

// Avvia il loop di controllo scadenze
setInterval(checkDeadlines, 60000);
setTimeout(checkDeadlines, 5000); // prima verifica dopo 5 secondi
