const socket = io();

const $ = (id) => document.getElementById(id);
const TURN_SECONDS = 30;

let myId = null;
let roomCode = null;
let players = [];
let myTurn = false;
let deadline = null;
let timerInt = null;
let typingTimer = null;
let gameOver = false;

// ---------- helpers ----------
function show(screenId) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(screenId).classList.add('active');
}

function setMsg(el, text) { el.textContent = text || ''; }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

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
socket.on('joined', ({ code, you }) => { myId = you; roomCode = code; });
socket.on('join_error', ({ reason }) => { setMsg($('lobbyMsg'), reason); shake($('codeInput')); });

$('btnCopy').onclick = async () => {
  try { await navigator.clipboard.writeText(roomCode); $('btnCopy').textContent = '✅ Đã copy!'; }
  catch { $('btnCopy').textContent = 'Mã: ' + roomCode; }
  setTimeout(() => ($('btnCopy').textContent = '📋 Sao chép mã'), 1500);
};

// ---------- game ----------
socket.on('game_start', (room) => {
  players = room.players;
  gameOver = false;
  $('overOverlay').classList.remove('show');
  $('history').innerHTML = '';
  $('cwLabel').textContent = 'Từ đầu tiên — nhập danh từ hoặc tính từ 2 âm!';
  $('sylFirst').textContent = '?';
  $('sylLast').textContent = '?';
  $('cwHint').textContent = '';
  $('posTag').textContent = '';
  setMsg($('gameMsg'), '');

  const me = players.find((p) => p.id === myId);
  const op = players.find((p) => p.id !== myId);
  $('meName').textContent = me ? me.name : 'Bạn';
  $('opName').textContent = op ? op.name : 'Đối thủ';
  $('meAvatar').textContent = cap(($('meName').textContent || 'A')[0]);
  $('opAvatar').textContent = cap(($('opName').textContent || 'B')[0]);
  updateScores(players);
  show('game');
  $('wordInput').focus();
});

socket.on('turn', ({ turnId, lastWord, nextSyllable, deadline: dl, players: ps }) => {
  if (ps) { players = ps; updateScores(ps); }
  myTurn = turnId === myId;
  deadline = dl;
  startCountdown();

  $('meBox').classList.toggle('my-turn', myTurn);
  $('opBox').classList.toggle('my-turn', !myTurn);
  $('turnText').textContent = myTurn ? '🎯 Đến lượt BẠN!' : '⏳ Lượt đối thủ…';
  $('turnText').style.color = myTurn ? 'var(--yellow)' : 'rgba(255,255,255,.75)';
  $('wordInput').disabled = !myTurn;
  $('btnSend').disabled = !myTurn;
  if (myTurn) { $('wordInput').focus(); $('wordInput').placeholder = nextSyllable ? `Bắt đầu bằng "${nextSyllable}…"` : 'Nhập danh từ…'; }

  if (lastWord) {
    const parts = lastWord.split(' ');
    $('cwLabel').textContent = 'Từ trước:';
    $('sylFirst').textContent = parts[0];
    $('sylLast').textContent = parts[1] || '';
    $('cwHint').textContent = `Nối bằng âm "${nextSyllable}"`;
  } else {
    $('cwLabel').textContent = 'Từ đầu tiên — nhập danh từ hoặc tính từ 2 âm!';
    $('sylFirst').textContent = '?';
    $('sylLast').textContent = '?';
    $('cwHint').textContent = '';
  }
});

socket.on('word_played', ({ word, pos, playerId, players: ps }) => {
  if (ps) { players = ps; updateScores(ps); }
  addHistory(word, playerId === myId);
  if (pos) $('posTag').textContent = `(${pos})`;
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

socket.on('game_over', ({ winnerId, reason, players: ps }) => {
  gameOver = true;
  myTurn = false;
  stopCountdown();
  $('timerBar').style.width = '0%';
  $('wordInput').disabled = true;
  $('btnSend').disabled = true;
  if (ps) updateScores(ps);

  const win = winnerId === myId;
  $('overEmoji').textContent = win ? '🏆' : '😢';
  $('overTitle').textContent = win ? 'Bạn thắng!' : 'Bạn thua!';
  $('overReason').textContent = reason;
  const me = ps?.find((p) => p.id === myId);
  const op = ps?.find((p) => p.id !== myId);
  if (me && op) {
    $('overScore').textContent = `${me.name} ${me.score} — ${op.score} ${op.name} · Tổng thắng ${me.wins}–${op.wins}`;
  }
  $('overOverlay').classList.add('show');
  if (win) celebrate();
});

socket.on('opponent_left', () => {
  gameOver = true;
  stopCountdown();
  $('overEmoji').textContent = '🚪';
  $('overTitle').textContent = 'Đối thủ đã thoát';
  $('overReason').textContent = 'Phòng đã đóng. Quay về sảnh để chơi tiếp.';
  $('overScore').textContent = '';
  $('btnRematch').style.display = 'none';
  $('overOverlay').classList.add('show');
});

socket.on('opponent_typing', ({ text }) => {
  $('opTyping').textContent = text ? `✏️ ${text}` : '';
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

$('btnRematch').onclick = () => { $('btnRematch').style.display = ''; socket.emit('rematch'); };
$('btnExit').onclick = () => { $('btnRematch').style.display = ''; location.reload(); };
$('btnLeave').onclick = () => { socket.emit('leave_room'); location.reload(); };

// ---------- render helpers ----------
function updateScores(ps) {
  const me = ps.find((p) => p.id === myId);
  const op = ps.find((p) => p.id !== myId);
  if (me) { $('meScore').textContent = me.score; $('meName').textContent = me.name; $('meWins').textContent = '🏆' + (me.wins || 0); }
  if (op) { $('opScore').textContent = op.score; $('opName').textContent = op.name; $('opWins').textContent = '🏆' + (op.wins || 0); }
}

function addHistory(word, mine) {
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
  chip.className = 'h-chip ' + (mine ? 'mine' : 'theirs');
  chip.textContent = word;
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
