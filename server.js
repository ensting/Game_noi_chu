const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const TURN_SECONDS = 30;

// -------------------- Dictionary (vi.wiktionary.org) --------------------
// Kiểm tra từ có tồn tại trên Wiktionary tiếng Việt và là DANH TỪ.
// Dùng prop=sections: mỗi entry có các mục "==Tiếng Việt==" > "===Danh từ==="
const dictCache = new Map();

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
    if (!res.ok) return { exists: null, isNoun: null, error: true };
    const data = await res.json();

    if (data.error || !data.parse) {
      result = { exists: false, isNoun: false };
    } else {
      const sections = data.parse.sections || [];
      const clean = (s) => String(s).replace(/<[^>]+>/g, '').trim();
      // Section gốc "Tiếng Việt": number không có dấu chấm (vd "1"), line chứa 'Tiếng Việt'
      const viSection = sections.find(
        (s) => !String(s.number).includes('.') && /tiếng\s*việt/i.test(clean(s.line))
      );
      if (!viSection) {
        // Trang tồn tại nhưng không có mục tiếng Việt -> không phải từ tiếng Việt
        result = { exists: true, isNoun: false };
      } else {
        const prefix = viSection.number + '.';
        const isNoun = sections.some(
          (s) => String(s.number).startsWith(prefix) && /danh\s*từ/i.test(clean(s.line))
        );
        result = { exists: true, isNoun };
      }
    }
  } catch (e) {
    return { exists: null, isNoun: null, error: true };
  }

  dictCache.set(key, result);
  return result;
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

function publicRoom(room) {
  return {
    code: room.code,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      connected: p.connected
    })),
    started: room.started,
    turnId: room.started ? room.players[room.turnIndex].id : null,
    lastWord: room.lastWord,
    history: room.history,
    deadline: room.deadline
  };
}

function clearTurnTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

function startTurn(room) {
  clearTurnTimer(room);
  room.deadline = Date.now() + TURN_SECONDS * 1000;
  room.timer = setTimeout(() => {
    const loser = room.players[room.turnIndex];
    const winner = room.players[1 - room.turnIndex];
    endGame(room, winner.id, `${loser.name} hết giờ!`);
  }, TURN_SECONDS * 1000);
  io.to(room.code).emit('turn', {
    turnId: room.players[room.turnIndex].id,
    lastWord: room.lastWord,
    nextSyllable: room.lastWord ? lastSyllable(room.lastWord) : null,
    deadline: room.deadline,
    players: room.players.map((p) => ({ id: p.id, name: p.name, score: p.score }))
  });
}

function endGame(room, winnerId, reason) {
  clearTurnTimer(room);
  room.started = false;
  room.deadline = null;
  io.to(room.code).emit('game_over', {
    winnerId,
    reason,
    players: room.players.map((p) => ({ id: p.id, name: p.name, score: p.score })),
    history: room.history
  });
}

function resetGame(room) {
  clearTurnTimer(room);
  room.started = true;
  room.turnIndex = Math.floor(Math.random() * room.players.length);
  room.lastWord = null;
  room.usedWords = new Set();
  room.history = [];
  room.players.forEach((p) => (p.score = 0));
}

async function validateAndPlay(socket, room, rawWord) {
  const player = room.players.find((p) => p.id === socket.id);
  if (!player || !room.started) return;
  if (room.players[room.turnIndex].id !== socket.id) {
    return socket.emit('invalid_word', { word: rawWord, reason: 'Chưa đến lượt bạn!' });
  }

  const word = normalizeWord(rawWord);
  const syllables = word.split(' ');

  if (syllables.length !== 2) {
    return socket.emit('invalid_word', { word: rawWord, reason: 'Từ phải có đúng 2 âm tiết (vd: "con mèo")' });
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

  const check = await checkWordOnline(word);
  // Đảm bảo vẫn còn lượt sau khi await (đối thủ có thể đã hết giờ / thoát)
  if (!room.started || room.players[room.turnIndex]?.id !== socket.id) return;

  if (check.error) {
    return socket.emit('invalid_word', { word: rawWord, reason: 'Không kết nối được từ điển, thử lại!' });
  }
  if (!check.exists) {
    return socket.emit('invalid_word', { word: rawWord, reason: `"${word}" không có trong từ điển` });
  }
  if (!check.isNoun) {
    return socket.emit('invalid_word', { word: rawWord, reason: `"${word}" không phải danh từ` });
  }

  // Hợp lệ!
  room.usedWords.add(word);
  room.lastWord = word;
  player.score += 1;
  room.history.push({ word, playerId: player.id, name: player.name });
  room.turnIndex = 1 - room.turnIndex;
  io.to(room.code).emit('word_played', {
    word,
    playerId: player.id,
    players: room.players.map((p) => ({ id: p.id, name: p.name, score: p.score }))
  });
  startTurn(room);
}

// -------------------- Socket events --------------------
io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('create_room', ({ name }) => {
    const code = genCode();
    const room = {
      code,
      players: [{ id: socket.id, name: (name || 'Người chơi 1').slice(0, 20), score: 0, connected: true }],
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
  });

  socket.on('join_room', ({ code, name }) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return socket.emit('join_error', { reason: 'Không tìm thấy phòng này!' });
    if (room.players.length >= 2) return socket.emit('join_error', { reason: 'Phòng đã đủ 2 người!' });

    room.players.push({ id: socket.id, name: (name || 'Người chơi 2').slice(0, 20), score: 0, connected: true });
    socket.join(code);
    currentRoom = room;
    socket.emit('joined', { code, you: socket.id });
    resetGame(room);
    io.to(code).emit('game_start', publicRoom(room));
    startTurn(room);
  });

  socket.on('submit_word', ({ word }) => {
    if (currentRoom) validateAndPlay(socket, currentRoom, word || '');
  });

  socket.on('rematch', () => {
    if (!currentRoom || currentRoom.started || currentRoom.players.length < 2) return;
    resetGame(currentRoom);
    io.to(currentRoom.code).emit('game_start', publicRoom(currentRoom));
    startTurn(currentRoom);
  });

  socket.on('typing', ({ text }) => {
    if (currentRoom) socket.to(currentRoom.code).emit('opponent_typing', { text: String(text).slice(0, 40) });
  });

  socket.on('leave_room', () => handleLeave(socket));
  socket.on('disconnect', () => handleLeave(socket));

  function handleLeave(sock) {
    const room = currentRoom;
    if (!room) return;
    const p = room.players.find((pl) => pl.id === sock.id);
    if (p) p.connected = false;
    sock.to(room.code).emit('opponent_left');
    clearTurnTimer(room);
    rooms.delete(room.code);
    currentRoom = null;
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`Noi Chu server: http://localhost:${PORT}`));
