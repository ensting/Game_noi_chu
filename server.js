const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const TURN_SECONDS = 30;
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;

// -------------------- Dictionary --------------------
// 1) Từ điển offline (dict/vietnamese.txt — Viet74K) là nguồn chính: nhanh, không bị rate-limit.
// 2) Fallback tra vi.wiktionary.org: chấp nhận mọi từ có mục "Tiếng Việt" (mọi loại từ).
const localDict = new Set();
try {
  const txt = fs.readFileSync(path.join(__dirname, 'dict', 'vietnamese.txt'), 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const w = line.normalize('NFC').trim().toLowerCase();
    if (w) localDict.add(w);
  }
  console.log(`Từ điển offline: ${localDict.size} từ`);
} catch (e) {
  console.warn('Không đọc được dict/vietnamese.txt:', e.message);
}

const dictCache = new Map();

const POS_PATTERNS = [
  [/danh\s*từ\s*riêng/i, 'danh từ riêng'],
  [/danh\s*từ/i, 'danh từ'],
  [/tính\s*từ/i, 'tính từ'],
  [/động\s*từ/i, 'động từ'],
  [/phó\s*từ|trạng\s*từ/i, 'trạng từ'],
  [/đại\s*từ/i, 'đại từ'],
  [/số\s*từ/i, 'số từ'],
  [/lượng\s*từ|đơn\s*vị/i, 'lượng từ'],
  [/giới\s*từ/i, 'giới từ'],
  [/liên\s*từ/i, 'liên từ'],
  [/trợ\s*từ/i, 'trợ từ'],
  [/thán\s*từ|tình\s*thái/i, 'thán từ'],
  [/từ\s*ghép/i, 'từ ghép'],
  [/thành\s*ngữ|cụm\s*từ/i, 'thành ngữ']
];

// Tra Wiktionary: tồn tại = trang có mục "Tiếng Việt". pos chỉ để hiển thị, có thể null.
async function checkWordOnline(word) {
  const key = word.toLowerCase();
  if (dictCache.has(key)) return dictCache.get(key);

  const title = key.replace(/ /g, '_');
  const url =
    'https://vi.wiktionary.org/w/api.php?action=parse&format=json&redirects=1' +
    '&prop=sections&origin=*&page=' + encodeURIComponent(title);

  let result;
  try {
    let res;
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'NoiChuGame/1.0 (word-chain game)' }
      });
      clearTimeout(timer);
      if (res.status !== 429 && res.status < 500) break;
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
    if (!res.ok) return { exists: null, pos: null, error: true };
    const data = await res.json();

    if (data.error || !data.parse) {
      result = { exists: false, pos: null };
    } else {
      const sections = data.parse.sections || [];
      const clean = (s) => String(s).replace(/<[^>]+>/g, '').trim();
      const viSection = sections.find(
        (s) => !String(s.number).includes('.') && /tiếng\s*việt/i.test(clean(s.line))
      );
      if (!viSection) {
        result = { exists: false, pos: null };
      } else {
        const prefix = viSection.number + '.';
        let pos = null;
        for (const s of sections) {
          if (!String(s.number).startsWith(prefix)) continue;
          const line = clean(s.line);
          const hit = POS_PATTERNS.find(([re]) => re.test(line));
          if (hit) { pos = hit[1]; break; }
        }
        result = { exists: true, pos };
      }
    }
  } catch (e) {
    return { exists: null, pos: null, error: true };
  }

  dictCache.set(key, result);
  return result;
}

async function checkWord(word) {
  if (localDict.has(word)) return { exists: true, pos: null };
  return checkWordOnline(word);
}

// -------------------- Rooms --------------------
const rooms = new Map(); // code -> room

function genCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function normalizeWord(w) {
  return w.normalize('NFC').toLowerCase().trim().replace(/\s+/g, ' ');
}

function lastSyllable(word) {
  const parts = word.split(' ');
  return parts[parts.length - 1];
}

function playerView(p) {
  return { id: p.id, name: p.name, score: p.score, wins: p.wins, connected: p.connected, alive: p.alive };
}

function publicRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    players: room.players.map(playerView),
    started: room.started,
    turnId: room.started ? room.players[room.turnIndex]?.id ?? null : null,
    lastWord: room.lastWord,
    history: room.history,
    deadline: room.deadline
  };
}

function turnPayload(room) {
  return {
    turnId: room.players[room.turnIndex]?.id ?? null,
    lastWord: room.lastWord,
    nextSyllable: room.lastWord ? lastSyllable(room.lastWord) : null,
    deadline: room.deadline,
    players: room.players.map(playerView)
  };
}

function clearTurnTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

function nextAliveIndex(room, from) {
  const n = room.players.length;
  for (let i = 1; i <= n; i++) {
    const idx = (from + i) % n;
    if (room.players[idx].alive) return idx;
  }
  return -1;
}

function startTurn(room) {
  clearTurnTimer(room);
  // đảm bảo người giữ lượt còn sống
  if (!room.players[room.turnIndex]?.alive) {
    const idx = nextAliveIndex(room, room.turnIndex - 1);
    if (idx < 0) return;
    room.turnIndex = idx;
  }
  room.deadline = Date.now() + TURN_SECONDS * 1000;
  room.timer = setTimeout(() => {
    const loser = room.players[room.turnIndex];
    if (!room.started || !loser) return;
    eliminatePlayer(room, loser, 'hết giờ');
    afterPlayerOut(room, true);
  }, TURN_SECONDS * 1000);
  io.to(room.code).emit('turn', turnPayload(room));
}

function eliminatePlayer(room, player, reason) {
  if (!player.alive) return;
  player.alive = false;
  io.to(room.code).emit('player_out', {
    playerId: player.id,
    name: player.name,
    reason,
    players: room.players.map(playerView)
  });
}

// Sau khi 1 người bị loại: kết thúc nếu chỉ còn 1, hoặc chuyển lượt nếu họ đang giữ lượt.
function afterPlayerOut(room, wasTurn) {
  if (!room.started) return;
  const alive = room.players.filter((p) => p.alive);
  if (alive.length <= 1) {
    const winner = alive[0] || null;
    endGame(room, winner ? winner.id : null, winner ? `${winner.name} là người sống sót cuối cùng!` : 'Không còn ai trong ván!');
  } else if (wasTurn) {
    room.turnIndex = nextAliveIndex(room, room.turnIndex);
    startTurn(room);
  }
}

function endGame(room, winnerId, reason) {
  clearTurnTimer(room);
  room.started = false;
  room.deadline = null;
  const winner = room.players.find((p) => p.id === winnerId);
  if (winner) winner.wins = (winner.wins || 0) + 1;
  io.to(room.code).emit('game_over', {
    winnerId: winner ? winner.id : null,
    winnerName: winner ? winner.name : null,
    reason,
    players: room.players.map(playerView),
    history: room.history
  });
}

function startMatch(room) {
  clearTurnTimer(room);
  room.started = true;
  room.lastWord = null;
  room.usedWords = new Set();
  room.history = [];
  room.players.forEach((p) => {
    p.score = 0;
    p.alive = p.connected;
  });
  const aliveIdx = room.players.map((p, i) => (p.alive ? i : -1)).filter((i) => i >= 0);
  room.turnIndex = aliveIdx[Math.floor(Math.random() * aliveIdx.length)];
  io.to(room.code).emit('game_start', publicRoom(room));
  startTurn(room);
}

async function validateAndPlay(socket, room, rawWord) {
  const player = room.players.find((p) => p.id === socket.id);
  if (!player || !room.started || !player.alive) return;
  if (room.players[room.turnIndex]?.id !== socket.id) {
    return socket.emit('invalid_word', { word: rawWord, reason: 'Chưa đến lượt bạn!' });
  }

  const word = normalizeWord(rawWord);
  const syllables = word.split(' ');

  if (syllables.length !== 2) {
    return socket.emit('invalid_word', { word: rawWord, reason: 'Từ phải có đúng 2 âm tiết (vd: "con mèo", "xinh đẹp")' });
  }
  if (!/^[\p{L}]+ [\p{L}]+$/u.test(word)) {
    return socket.emit('invalid_word', { word: rawWord, reason: 'Từ chỉ được chứa chữ cái' });
  }
  if (room.lastWord && syllables[0] !== lastSyllable(room.lastWord)) {
    return socket.emit('invalid_word', {
      word: rawWord,
      reason: `Phải bắt đầu bằng âm "${lastSyllable(room.lastWord)}"`
    });
  }
  if (room.usedWords.has(word)) {
    return socket.emit('invalid_word', { word: rawWord, reason: 'Từ này đã được dùng rồi!' });
  }

  socket.emit('checking_word', { word });

  const check = await checkWord(word);
  // Đảm bảo vẫn còn lượt sau khi await (người chơi có thể đã hết giờ / thoát)
  if (!room.started || !player.alive || room.players[room.turnIndex]?.id !== socket.id) return;

  if (check.error) {
    return socket.emit('invalid_word', { word: rawWord, reason: 'Không kết nối được từ điển, thử lại!' });
  }
  if (!check.exists) {
    return socket.emit('invalid_word', { word: rawWord, reason: `"${word}" không có trong từ điển` });
  }

  // Hợp lệ!
  room.usedWords.add(word);
  room.lastWord = word;
  player.score += 1;
  room.history.push({ word, playerId: player.id, name: player.name, pos: check.pos });
  room.turnIndex = nextAliveIndex(room, room.turnIndex);
  io.to(room.code).emit('word_played', {
    word,
    pos: check.pos,
    playerId: player.id,
    players: room.players.map(playerView)
  });
  startTurn(room);
}

// -------------------- Socket events --------------------
io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('create_room', ({ name }) => {
    if (currentRoom) handleLeave(socket);
    const code = genCode();
    const room = {
      code,
      hostId: socket.id,
      players: [{ id: socket.id, name: (name || 'Người chơi 1').slice(0, 20), score: 0, wins: 0, connected: true, alive: true }],
      started: false,
      turnIndex: 0,
      lastWord: null,
      usedWords: new Set(),
      history: [],
      timer: null,
      deadline: null
    };
    rooms.set(code, room);
    socket.join(code);
    currentRoom = room;
    socket.emit('room_created', { code, you: socket.id });
    io.to(code).emit('room_update', publicRoom(room));
  });

  socket.on('join_room', ({ code, name }) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms.get(code);
    name = (name || '').trim().slice(0, 20) || 'Người chơi';
    if (!room) return socket.emit('join_error', { reason: 'Không tìm thấy phòng này!' });
    if (currentRoom && currentRoom !== room) handleLeave(socket);

    // Vào lại bằng tên cũ (mất kết nối / refresh trang)
    const ghost = room.players.find((p) => !p.connected && p.name === name);
    if (ghost) {
      ghost.id = socket.id;
      ghost.connected = true;
      socket.join(code);
      currentRoom = room;
      socket.emit('joined', { code, you: socket.id });
      io.to(code).emit('room_update', publicRoom(room));
      if (room.started) {
        socket.emit('game_start', publicRoom(room));
        socket.emit('turn', turnPayload(room));
      }
      return;
    }

    if (room.started) return socket.emit('join_error', { reason: 'Ván đang chơi rồi, đợi ván sau nhé!' });
    if (room.players.length >= MAX_PLAYERS) return socket.emit('join_error', { reason: `Phòng đã đủ ${MAX_PLAYERS} người!` });

    room.players.push({ id: socket.id, name, score: 0, wins: 0, connected: true, alive: true });
    socket.join(code);
    currentRoom = room;
    socket.emit('joined', { code, you: socket.id });
    io.to(code).emit('room_update', publicRoom(room));
  });

  socket.on('start_game', () => {
    const room = currentRoom;
    if (!room || room.started) return;
    if (room.hostId !== socket.id) return;
    if (room.players.filter((p) => p.connected).length < MIN_PLAYERS) {
      return socket.emit('join_error', { reason: 'Cần ít nhất 2 người để bắt đầu!' });
    }
    startMatch(room);
  });

  socket.on('submit_word', ({ word }) => {
    if (currentRoom) validateAndPlay(socket, currentRoom, word || '');
  });

  socket.on('rematch', () => {
    const room = currentRoom;
    if (!room || room.started) return;
    if (room.players.filter((p) => p.connected).length < MIN_PLAYERS) return;
    startMatch(room);
  });

  socket.on('typing', ({ text }) => {
    if (!currentRoom) return;
    const p = currentRoom.players.find((pl) => pl.id === socket.id);
    if (!p || (currentRoom.started && !p.alive)) return;
    socket.to(currentRoom.code).emit('player_typing', {
      playerId: socket.id,
      name: p.name,
      text: String(text).slice(0, 40)
    });
  });

  socket.on('chat', ({ text }) => {
    if (!currentRoom) return;
    const p = currentRoom.players.find((pl) => pl.id === socket.id);
    if (!p) return;
    if (currentRoom.started && !p.alive) {
      return socket.emit('notice', { reason: 'Bạn đã bị loại nên không thể chat!' });
    }
    const t = String(text || '').slice(0, 200).trim();
    if (!t) return;
    io.to(currentRoom.code).emit('chat', {
      playerId: socket.id,
      name: p.name,
      text: t
    });
  });

  socket.on('react', ({ emoji }) => {
    if (!currentRoom) return;
    const e = String(emoji || '').slice(0, 30);
    if (!e) return;
    io.to(currentRoom.code).emit('reaction', { playerId: socket.id, emoji: e });
  });

  socket.on('leave_room', () => handleLeave(socket));
  socket.on('disconnect', () => handleLeave(socket));

  function handleLeave(sock) {
    const room = currentRoom;
    if (!room) return;
    const p = room.players.find((pl) => pl.id === sock.id);
    if (!p) { currentRoom = null; return; }

    if (!room.started) {
      // Đang ở phòng chờ: xoá hẳn khỏi phòng
      room.players = room.players.filter((pl) => pl.id !== sock.id);
      if (!room.players.some((pl) => pl.connected)) {
        rooms.delete(room.code);
      } else {
        if (room.hostId === sock.id) room.hostId = room.players[0].id;
        io.to(room.code).emit('room_update', publicRoom(room));
      }
    } else {
      // Đang chơi: đánh dấu mất kết nối + bị loại, vẫn có thể vào lại xem bằng tên cũ
      p.connected = false;
      const wasTurn = room.players[room.turnIndex]?.id === p.id;
      eliminatePlayer(room, p, 'đã thoát');
      if (!room.players.some((pl) => pl.connected)) {
        clearTurnTimer(room);
        rooms.delete(room.code);
      } else {
        afterPlayerOut(room, wasTurn);
      }
    }
    currentRoom = null;
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`Noi Chu server: http://localhost:${PORT}`));
