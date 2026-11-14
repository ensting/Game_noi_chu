const socket = io();

const $ = (id) => document.getElementById(id);
const TURN_SECONDS = 30;

let myId = null;
let roomCode = null;
let players = [];
let hostId = null;
let turnId = null;
let myTurn = false;
let deadline = null;
let timerInt = null;
let typingTimer = null;
let typingClearTimer = null;
let gameOver = false;
let inGame = false;

// ---------- helpers ----------
function show(screenId) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(screenId).classList.add('active');
}

function setMsg(el, text) { el.textContent = text || ''; }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
const me = () => players.find((p) => p.id === myId);
const pIndex = (id) => Math.max(0, players.findIndex((p) => p.id === id));

function shake(el) {
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = 'shakeX .35s ease';
}
const styleShake = document.createElement('style');
styleShake.textContent = '@keyframes shakeX{0%,100%{transform:translateX(0)}25%{transform:translateX(-8px)}75%{transform:translateX(8px)}}';
document.head.appendChild(styleShake);

// ---------- lobby ----------
$('btnCreate').onclick = () => {
  socket.emit('create_room', { name: $('nameInput').value.trim() });
};
$('btnJoin').onclick = () => {
  socket.emit('join_room', { code: $('codeInput').value.trim(), name: $('nameInput').value.trim() });
};
$('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnJoin').click(); });
$('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnCreate').click(); });

socket.on('room_created', ({ code, you }) => {
  myId = you; roomCode = code;
  $('roomCode').textContent = code;
  show('waiting');
});
socket.on('joined', ({ code, you }) => {
  myId = you; roomCode = code;
  $('roomCode').textContent = code;
  if (!inGame) show('waiting');
});
socket.on('join_error', ({ reason }) => { setMsg($('lobbyMsg'), reason); shake($('codeInput')); });

$('btnCopy').onclick = async () => {
  try { await navigator.clipboard.writeText(roomCode); $('btnCopy').textContent = '✅ Đã copy!'; }
  catch { $('btnCopy').textContent = 'Mã: ' + roomCode; }
  setTimeout(() => ($('btnCopy').textContent = '📋 Sao chép mã'), 1500);
};

$('btnStart').onclick = () => socket.emit('start_game');

// ---------- phòng chờ ----------
function makeChip(p, i) {
  const chip = document.createElement('div');
  chip.className = 'pchip c' + (i % 8);
  if (p.id === myId) chip.classList.add('me');
  if (!p.alive) chip.classList.add('out');
  if (!p.connected) chip.classList.add('disc');

  const av = document.createElement('div');
  av.className = 'pc-av';
  av.textContent = cap((p.name || '?')[0]);

  const info = document.createElement('div');
  info.className = 'pc-info';
  const nm = document.createElement('span');
  nm.className = 'pc-name';
  nm.textContent = p.name + (p.id === myId ? ' (bạn)' : '') + (p.id === hostId ? ' 👑' : '');
  const sc = document.createElement('span');
  sc.className = 'pc-score';
  sc.textContent = `${p.score} điểm · 🏆${p.wins || 0}`;
  info.appendChild(nm);
  info.appendChild(sc);
  chip.appendChild(av);
  chip.appendChild(info);
  return chip;
}

function renderStrip() {
  const strip = $('pstrip');
  strip.innerHTML = '';
  players.forEach((p, i) => {
    const chip = makeChip(p, i);
    if (p.id === turnId && p.alive) chip.classList.add('active');
    strip.appendChild(chip);
  });
}

socket.on('room_update', (room) => {
  players = room.players;
  hostId = room.hostId;
  if (room.started) { if (inGame) renderStrip(); return; }

  // đang ở phòng chờ
  const list = $('waitPlayers');
  list.innerHTML = '';
  players.forEach((p, i) => list.appendChild(makeChip(p, i)));

  const connected = players.filter((p) => p.connected).length;
  const amHost = myId === hostId;
  $('btnStart').style.display = amHost ? '' : 'none';
  $('btnStart').disabled = connected < 2;
  $('btnStart').textContent = connected < 2 ? '🎮 Cần ít nhất 2 người' : `🎮 Bắt đầu (${connected} người)`;
  $('waitMsg').textContent = amHost
    ? (connected < 2 ? 'Đang chờ thêm người chơi…' : 'Đủ người rồi, bấm bắt đầu!')
    : 'Đợi chủ phòng bắt đầu…';
});

// ---------- game ----------
socket.on('game_start', (room) => {
  players = room.players;
  hostId = room.hostId;
  inGame = true;
  gameOver = false;
  turnId = null;
  $('overOverlay').classList.remove('show');
  $('history').innerHTML = '';
  $('cwLabel').textContent = 'Từ đầu tiên — nhập từ 2 âm tiết có nghĩa!';
  $('sylFirst').textContent = '?';
  $('sylLast').textContent = '?';
  $('cwHint').textContent = '';
  $('posTag').textContent = '';
  $('typingLine').textContent = '';
  $('btnRematch').style.display = '';
  setMsg($('gameMsg'), '');

  renderStrip();
  (room.history || []).forEach((h) => addHistory(h.word, h.playerId));
  show('game');
  if (me()?.alive) $('wordInput').focus();
});

socket.on('turn', ({ turnId: tid, lastWord, nextSyllable, deadline: dl, players: ps }) => {
  if (ps) { players = ps; }
  turnId = tid;
  const m = me();
  const out = m && !m.alive;
  myTurn = tid === myId && !out;
  deadline = dl;
  startCountdown();

  renderStrip();
  const cur = players.find((p) => p.id === tid);
  if (out) {
    $('turnText').textContent = `💀 Bạn đã bị loại — lượt của ${cur ? cur.name : '…'}`;
    $('turnText').style.color = 'rgba(255,255,255,.6)';
  } else {
    $('turnText').textContent = myTurn ? '🎯 Đến lượt BẠN!' : `⏳ Lượt của ${cur ? cur.name : '…'}`;
    $('turnText').style.color = myTurn ? 'var(--yellow)' : 'rgba(255,255,255,.75)';
  }
  $('wordInput').disabled = !myTurn;
  $('btnSend').disabled = !myTurn;
  if (myTurn) { $('wordInput').focus(); $('wordInput').placeholder = nextSyllable ? `Bắt đầu bằng "${nextSyllable}…"` : 'Nhập từ…'; }

  if (lastWord) {
    const parts = lastWord.split(' ');
    $('cwLabel').textContent = 'Từ trước:';
    $('sylFirst').textContent = parts[0];
    $('sylLast').textContent = parts[1] || '';
    $('cwHint').textContent = `Nối bằng âm "${nextSyllable}"`;
  } else {
    $('cwLabel').textContent = 'Từ đầu tiên — nhập từ 2 âm tiết có nghĩa!';
    $('sylFirst').textContent = '?';
    $('sylLast').textContent = '?';
    $('cwHint').textContent = '';
  }
});

socket.on('word_played', ({ word, pos, playerId, players: ps }) => {
  if (ps) { players = ps; }
  addHistory(word, playerId);
  $('posTag').textContent = pos ? `(${pos})` : '';
  setMsg($('gameMsg'), '');
});

socket.on('player_out', ({ playerId, name, reason, players: ps }) => {
  if (ps) { players = ps; }
  renderStrip();
  setMsg($('gameMsg'), `💀 ${name} bị loại — ${reason}`);
  $('gameMsg').style.color = 'rgba(255,255,255,.75)';
  if (playerId === myId) {
    myTurn = false;
    $('wordInput').disabled = true;
    $('btnSend').disabled = true;
    $('wordInput').placeholder = 'Bạn đã bị loại — chỉ xem được thôi';
  }
});

socket.on('checking_word', () => {
  setMsg($('gameMsg'), '🔍 Đang tra từ điển…');
  $('gameMsg').style.color = 'var(--cyan)';
});

socket.on('invalid_word', ({ reason }) => {
  setMsg($('gameMsg'), '❌ ' + reason);
  $('gameMsg').style.color = '#ff8a9e';
  shake($('wordInput'));
  if (myTurn) { $('wordInput').select(); $('wordInput').focus(); }
});

socket.on('notice', ({ reason }) => {
  setMsg($('gameMsg'), '⚠️ ' + reason);
  $('gameMsg').style.color = 'var(--yellow)';
});

socket.on('game_over', ({ winnerId, winnerName, reason, players: ps }) => {
  gameOver = true;
  myTurn = false;
  stopCountdown();
  $('timerBar').style.width = '0%';
  $('wordInput').disabled = true;
  $('btnSend').disabled = true;
  if (ps) { players = ps; renderStrip(); }

  const win = winnerId === myId;
  $('overEmoji').textContent = win ? '🏆' : (winnerId ? '🎉' : '😶');
  $('overTitle').textContent = win ? 'Bạn thắng!' : (winnerName ? `${winnerName} thắng!` : 'Ván đấu kết thúc');
  $('overReason').textContent = reason;

  const sc = $('overScore');
  sc.innerHTML = '';
  const line = document.createElement('div');
  [...(ps || [])].sort((a, b) => b.score - a.score).forEach((p, i) => {
    const s = document.createElement('span');
    s.className = 'ov-chip c' + (pIndex(p.id) % 8);
    s.textContent = `${i + 1}. ${p.name} · ${p.score}`;
    line.appendChild(s);
  });
  sc.appendChild(line);
  $('overOverlay').classList.add('show');
  if (win) celebrate();
});

socket.on('player_typing', ({ playerId, name, text }) => {
  if (playerId === myId) return;
  $('typingLine').textContent = text ? `✏️ ${name}: ${text}` : '';
  if (typingClearTimer) clearTimeout(typingClearTimer);
  typingClearTimer = setTimeout(() => { $('typingLine').textContent = ''; }, 2500);
});

// ---------- chat ----------
let unread = 0;
socket.on('chat', ({ playerId, name, text }) => {
  const mine = playerId === myId;
  const box = $('chatMsgs');
  const el = document.createElement('div');
  el.className = 'chat-msg ' + (mine ? 'mine' : 'theirs');
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = mine ? 'Bạn' : name;
  const body = document.createElement('span');
  body.textContent = text;
  el.appendChild(who);
  el.appendChild(body);
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  if (!mine && !$('chatPanel').classList.contains('open')) {
    unread++;
    $('chatBadge').textContent = unread > 9 ? '9+' : unread;
    $('chatBadge').classList.add('show');
  }
});

function toggleChat(open) {
  $('chatPanel').classList.toggle('open', open);
  if (open) { unread = 0; $('chatBadge').classList.remove('show'); $('chatInput').focus(); }
}
$('chatFab').onclick = () => toggleChat(!$('chatPanel').classList.contains('open'));
$('chatClose').onclick = () => toggleChat(false);

function sendChat() {
  const t = $('chatInput').value.trim();
  if (!t) return;
  socket.emit('chat', { text: t });
  $('chatInput').value = '';
}
$('chatSend').onclick = sendChat;
$('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

// ---------- emoji / meme reaction ----------
const EMOJIS = ['😂','🤣','😍','😘','😎','🤪','😜','🤯','😱','😭','😢','😡','🤬','😴','🤔','🙄','👍','👎','👏','🙏','🔥','❤️','💯','🎉','⚡','🐸'];
const KAOMOJI = ['¯\\_(ツ)_/¯', '(╯°□°）╯︵ ┻━┻', 'ಠ_ಠ', '(☞ﾟヮﾟ)☞', '(ᵔᴥᵔ)', 't(-_-t)'];

(function buildPicker() {
  const pk = $('emojiPicker');
  [...EMOJIS.map(e => ({ t: e, kao: false })), ...KAOMOJI.map(k => ({ t: k, kao: true }))].forEach(({ t, kao }) => {
    const b = document.createElement('button');
    b.textContent = t;
    if (kao) b.className = 'kaomoji';
    b.onclick = () => {
      socket.emit('react', { emoji: t });
      pk.classList.remove('open');
    };
    pk.appendChild(b);
  });
})();

$('emojiBtn').onclick = () => $('emojiPicker').classList.toggle('open');

function spawnReaction(emoji, fromMe) {
  const el = document.createElement('div');
  const isKao = emoji.length > 4;
  el.className = 'fly-emoji' + (isKao ? ' kao' : '');
  el.textContent = emoji;
  el.style.left = (fromMe ? 55 : 5) + Math.random() * 35 + 'vw';
  $('reactions').appendChild(el);
  setTimeout(() => el.remove(), 2700);
}

socket.on('reaction', ({ playerId, emoji }) => spawnReaction(emoji, playerId === myId));

function celebrate() {
  const confetti = ['🎉','🏆','✨','🥳','⭐','🎊'];
  for (let i = 0; i < 14; i++) {
    setTimeout(() => {
      const el = document.createElement('div');
      el.className = 'fly-emoji';
      el.textContent = confetti[i % confetti.length];
      el.style.left = Math.random() * 90 + 'vw';
      $('reactions').appendChild(el);
      setTimeout(() => el.remove(), 2700);
    }, i * 90);
  }
}

// ---------- input ----------
function sendWord() {
  const w = $('wordInput').value.trim();
  if (!w || !myTurn || gameOver) return;
  socket.emit('submit_word', { word: w });
  $('wordInput').value = '';
  socket.emit('typing', { text: '' });
}
$('btnSend').onclick = sendWord;
$('wordInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendWord(); });
$('wordInput').addEventListener('input', (e) => {
  if (typingTimer) clearTimeout(typingTimer);
  socket.emit('typing', { text: e.target.value });
  typingTimer = setTimeout(() => socket.emit('typing', { text: '' }), 1500);
});

$('btnRematch').onclick = () => { socket.emit('rematch'); };
$('btnExit').onclick = () => { socket.emit('leave_room'); location.reload(); };
$('btnLeave').onclick = () => { socket.emit('leave_room'); location.reload(); };

// ---------- render helpers ----------
function addHistory(word, playerId) {
  const hist = $('history');
  if (hist.children.length > 0) {
    const arrow = document.createElement('span');
    arrow.className = 'h-arrow';
    arrow.textContent = '→';
    hist.appendChild(arrow);
  }
  const wrap = document.createElement('span');
  wrap.className = 'h-word';
  const chip = document.createElement('span');
  chip.className = 'h-chip c' + (pIndex(playerId) % 8);
  chip.textContent = word;
  chip.title = players[pIndex(playerId)]?.name || '';
  wrap.appendChild(chip);
  hist.appendChild(wrap);
  hist.scrollTop = hist.scrollHeight;
  // giữ tối đa ~40 từ hiển thị
  while (hist.children.length > 80) hist.removeChild(hist.firstChild);
}

// ---------- countdown ----------
function startCountdown() {
  stopCountdown();
  timerInt = setInterval(() => {
    const left = Math.max(0, deadline - Date.now());
    const pct = (left / (TURN_SECONDS * 1000)) * 100;
    $('timerBar').style.width = pct + '%';
    $('timerBar').classList.toggle('low', left < 6000 && left > 0);
    if (left <= 0) stopCountdown();
  }, 100);
}
function stopCountdown() { if (timerInt) { clearInterval(timerInt); timerInt = null; } }
