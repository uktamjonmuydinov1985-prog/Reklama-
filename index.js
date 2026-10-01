const https = require('https');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = 8279536115;
const DEFAULT_CHANNEL = '@kino_tarjimaa_uzz';

// /data survives FadeHost deploy/restart. Migrate old DB if it exists.
const DB_FILE = '/data/kino_db.json';
const LEGACY_DB_FILE = path.join(process.cwd(), 'kino_db.json');

if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is missing');
  process.exit(1);
}

let db = { movies: {}, channels: [DEFAULT_CHANNEL], users: {} };
try {
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } else if (fs.existsSync(LEGACY_DB_FILE)) {
    db = JSON.parse(fs.readFileSync(LEGACY_DB_FILE, 'utf8'));
    console.log('Old DB migrated to /data/kino_db.json');
  }
} catch (e) {
  console.error('DB read error:', e.message);
}

if (!db || typeof db !== 'object') db = {};
if (!db.movies || typeof db.movies !== 'object') db.movies = {};
if (!Array.isArray(db.channels) || !db.channels.length) db.channels = [DEFAULT_CHANNEL];
if (!db.channels.includes(DEFAULT_CHANNEL)) db.channels.unshift(DEFAULT_CHANNEL);
if (!db.users || typeof db.users !== 'object') db.users = {};

function saveDb() {
  try {
    fs.mkdirSync('/data', { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('DB write error:', e.message);
  }
}

function api(method, params = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.ok) resolve(json.result);
          else reject(new Error(json.description || 'Telegram API error'));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const pending = new Map();
let broadcastMode = false;
let offset = 0;

async function send(chatId, text, extra = {}) {
  return api('sendMessage', { chat_id: chatId, text, ...extra });
}

async function sendVideo(chatId, fileId, caption) {
  return api('sendVideo', { chat_id: chatId, video: fileId, caption: caption || undefined });
}

function channelUrl(ch) {
  const username = ch.replace(/^@/, '').trim();
  return `https://t.me/${username}`;
}

function subscriptionKeyboard() {
  const rows = db.channels.map((ch, i) => ([{
    text: `📢 ${ch}`,
    url: channelUrl(ch)
  }]));
  rows.push([{ text: '✅ Tekshirish', callback_data: 'check_sub' }]);
  return { inline_keyboard: rows };
}

async function sendSubscriptionMessage(chatId) {
  const text =
    '⚠️ Kino olish uchun quyidagi kanallarga obuna bo‘ling!\n\n' +
    '💎 Yoki PREMIUM olib barcha cheklovlarni olib tashlang.';
  return send(chatId, text, { reply_markup: subscriptionKeyboard() });
}

async function subscribed(userId) {
  for (const ch of db.channels) {
    try {
      const m = await api('getChatMember', { chat_id: ch, user_id: userId });
      if (['left', 'kicked'].includes(m.status)) return false;
    } catch (e) {
      console.error('Channel check:', ch, e.message);
      return false;
    }
  }
  return true;
}

function isAdmin(id) {
  return Number(id) === ADMIN_ID;
}

function registerUser(msg) {
  if (!msg || !msg.from || !msg.chat) return;
  const id = String(msg.from.id);
  if (!db.users[id]) {
    db.users[id] = {
      id: msg.from.id,
      username: msg.from.username || '',
      first_name: msg.from.first_name || '',
      joined_at: new Date().toISOString()
    };
    saveDb();
  } else {
    let changed = false;
    if (db.users[id].username !== (msg.from.username || '')) {
      db.users[id].username = msg.from.username || '';
      changed = true;
    }
    if (db.users[id].first_name !== (msg.from.first_name || '')) {
      db.users[id].first_name = msg.from.first_name || '';
      changed = true;
    }
    if (changed) saveDb();
  }
}

async function broadcastMessage(sourceMsg) {
  const users = Object.values(db.users);
  let ok = 0;
  let fail = 0;

  for (const u of users) {
    try {
      await api('copyMessage', {
        chat_id: u.id,
        from_chat_id: sourceMsg.chat.id,
        message_id: sourceMsg.message_id
      });
      ok++;
    } catch (e) {
      fail++;
    }
    await new Promise(r => setTimeout(r, 40));
  }

  return { ok, fail, total: users.length };
}

async function handleCallback(q) {
  const userId = q.from.id;
  const chatId = q.message && q.message.chat ? q.message.chat.id : null;

  if (q.data === 'check_sub') {
    const ok = await subscribed(userId);
    if (!ok) {
      await api('answerCallbackQuery', {
        callback_query_id: q.id,
        text: '❌ Hali barcha kanallarga obuna bo‘lmagansiz.',
        show_alert: true
      });
      return;
    }

    await api('answerCallbackQuery', {
      callback_query_id: q.id,
      text: '✅ Obuna tasdiqlandi!'
    });

    if (chatId) {
      try {
        await api('editMessageText', {
          chat_id: chatId,
          message_id: q.message.message_id,
          text: '✅ Obuna tasdiqlandi!\n\n🎬 Endi kino kodini yuboring.'
        });
      } catch (e) {
        await send(chatId, '✅ Obuna tasdiqlandi!\n\n🎬 Endi kino kodini yuboring.');
      }
    }
  }
}

async function handle(msg) {
  if (!msg || !msg.chat || !msg.from) return;

  registerUser(msg);

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || '').trim();

  // Admin starts a broadcast, then sends any message/media to broadcast it.
  if (isAdmin(userId) && broadcastMode && !text.startsWith('/reklama')) {
    broadcastMode = false;
    const result = await broadcastMessage(msg);
    return send(chatId,
      `📢 Reklama yuborildi.\n\n` +
      `👥 Jami: ${result.total}\n` +
      `✅ Yetkazildi: ${result.ok}\n` +
      `❌ Yetkazilmadi: ${result.fail}`
    );
  }

  if (isAdmin(userId) && pending.has(userId) && msg.video) {
    const p = pending.get(userId);
    db.movies[p.code] = { name: p.name, file_id: msg.video.file_id };
    saveDb();
    pending.delete(userId);
    return send(chatId, `✅ Saqlandi!\n\n🎬 ${p.name}\n🔑 Kod: ${p.code}`);
  }

  if (isAdmin(userId) && text.startsWith('/save')) {
    const arg = text.slice(5).trim();
    const parts = arg.split('|');
    if (parts.length < 2 || !parts[0].trim() || !parts[1].trim()) {
      return send(chatId, 'Format: /save KOD | Kino nomi\nKeyin videoni yuboring.');
    }
    const code = parts[0].trim().toUpperCase();
    const name = parts.slice(1).join('|').trim();
    pending.set(userId, { code, name });
    return send(chatId, `🎬 ${name}\n🔑 Kod: ${code}\n\nEndi videoni yuboring.`);
  }

  if (isAdmin(userId) && text === '/reklama') {
    broadcastMode = true;
    return send(chatId,
      '📢 Reklama rejimi yoqildi.\n\n' +
      'Endi yuboradigan keyingi xabaringiz barcha bot foydalanuvchilariga jo‘natiladi.\n\n' +
      'Bekor qilish: /bekor'
    );
  }

  if (isAdmin(userId) && text === '/bekor') {
    broadcastMode = false;
    return send(chatId, '❌ Reklama bekor qilindi.');
  }

  if (isAdmin(userId) && (text === '/users' || text === '/stats')) {
    const count = Object.keys(db.users).length;
    return send(chatId, `👥 Bot foydalanuvchilari: ${count} ta`);
  }

  if (isAdmin(userId) && text.startsWith('/addchannel')) {
    const ch = text.slice(11).trim();
    if (!ch) return send(chatId, 'Format: /addchannel @kanal');
    if (!ch.startsWith('@')) return send(chatId, 'Kanal @username ko‘rinishida bo‘lsin.');
    if (!db.channels.includes(ch)) {
      db.channels.push(ch);
      saveDb();
      return send(chatId, `✅ Qo‘shildi: ${ch}`);
    }
    return send(chatId, 'Bu kanal allaqachon bor.');
  }

  if (isAdmin(userId) && text.startsWith('/delchannel')) {
    const ch = text.slice(11).trim();
    if (!ch) return send(chatId, 'Format: /delchannel @kanal');
    if (ch === DEFAULT_CHANNEL) return send(chatId, '❌ Asosiy kanalni o‘chirib bo‘lmaydi.');
    db.channels = db.channels.filter(x => x !== ch);
    saveDb();
    return send(chatId, `🗑 O‘chirildi: ${ch}`);
  }

  if (isAdmin(userId) && text === '/channels') {
    return send(chatId, '📢 Majburiy kanallar:\n' + db.channels.map((x, i) => `${i + 1}. ${x}`).join('\n'));
  }

  if (isAdmin(userId) && text === '/list') {
    const items = Object.entries(db.movies);
    if (!items.length) return send(chatId, 'Hali kino saqlanmagan.');
    return send(chatId, '🎬 Kinolar:\n' + items.map(([c, v]) => `${c} — ${v.name}`).join('\n'));
  }

  if (isAdmin(userId) && text.startsWith('/delete')) {
    const code = text.slice(7).trim().toUpperCase();
    if (!db.movies[code]) return send(chatId, 'Bu kod topilmadi.');
    delete db.movies[code];
    saveDb();
    return send(chatId, `🗑 O‘chirildi: ${code}`);
  }

  if (text === '/start') {
    if (!(await subscribed(userId))) return sendSubscriptionMessage(chatId);
    return send(chatId, '🎬 Kino botga xush kelibsiz!\n\nKino kodini yuboring.');
  }

  if (!text || text.startsWith('/')) return;

  if (!(await subscribed(userId))) {
    return sendSubscriptionMessage(chatId);
  }

  const code = text.toUpperCase();
  const movie = db.movies[code];
  if (!movie) return send(chatId, '❌ Bu kod bo‘yicha kino topilmadi.');
  return sendVideo(chatId, movie.file_id, `🎬 ${movie.name}`);
}

async function poll() {
  while (true) {
    try {
      const updates = await api('getUpdates', {
        offset,
        timeout: 25,
        allowed_updates: ['message', 'callback_query']
      });
      for (const u of updates) {
        offset = u.update_id + 1;
        try {
          if (u.callback_query) await handleCallback(u.callback_query);
          else if (u.message) await handle(u.message);
        } catch (e) {
          console.error('Handler:', e.message);
        }
      }
    } catch (e) {
      console.error('Polling:', e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

console.log('Kino bot started');
poll();
