// Test e2e: 3 người chơi nối chữ qua socket.io-client
// Flow: A tạo phòng -> B,C vào -> A bắt đầu -> chơi vài lượt -> B thoát (bị loại) -> C thoát -> A thắng
const { io } = require('socket.io-client');
const URL = process.env.URL || 'http://localhost:3000';

const a = io(URL);
const b = io(URL);
const c = io(URL);
let code = null;
let aId = null;

const log = (who, ev, d) => console.log(`[${who}] ${ev}`, JSON.stringify(d));

a.on('room_created', (d) => {
  aId = d.you; code = d.code;
  log('A', 'room_created', d);
  b.emit('join_room', { code, name: 'Bảo' });
  c.emit('join_room', { code, name: 'Chi' });
});

a.on('room_update', (d) => {
  log('A', 'room_update', { players: d.players.map(p => p.name), hostId: d.hostId === aId ? 'A' : '?' });
  if (d.players.length === 3 && !d.started) a.emit('start_game');
});
b.on('room_update', (d) => log('B', 'room_update', { players: d.players.map(p => p.name) }));

b.on('joined', (d) => log('B', 'joined', d));
c.on('joined', (d) => log('C', 'joined', d));
b.on('join_error', (d) => log('B', 'join_error', d));
c.on('join_error', (d) => log('C', 'join_error', d));

// Chuỗi từ thật trong từ điển offline: học sinh → sinh viên → viên chức → chức vụ → vụ việc → việc làm → làm ăn
const words = { 'học sinh': 'sinh viên', 'sinh viên': 'viên chức', 'viên chức': 'chức vụ', 'chức vụ': 'vụ việc', 'vụ việc': 'việc làm', 'việc làm': 'làm ăn', 'làm ăn': 'ăn uống' };
let plays = 0;

function onTurn(who, socket) {
  socket.on('turn', (d) => {
    log(who, 'turn', { turnId: d.turnId === socket.id ? 'ME' : 'OTHER', nextSyllable: d.nextSyllable, lastWord: d.lastWord });
    if (d.turnId === socket.id) {
      const w = d.lastWord ? (words[d.lastWord] || 'học sinh') : 'học sinh';
      socket.emit('submit_word', { word: w });
      if (++plays === 4) setTimeout(() => { log('B', '<<thoát>>'); b.close(); }, 400);
    }
  });
}
onTurn('A', a); onTurn('B', b); onTurn('C', c);

a.on('connect', () => { if (!aId) a.emit('create_room', { name: 'An' }); });
for (const [who, s] of [['A', a], ['B', b], ['C', c]]) {
  s.on('game_start', (d) => log(who, 'game_start', { players: d.players.map(p => p.name) }));
  s.on('word_played', (d) => log(who, 'word_played', d));
  s.on('invalid_word', (d) => log(who, 'invalid_word', d));
  s.on('player_out', (d) => log(who, 'player_out', d));
  s.on('game_over', (d) => { log(who, 'game_over', { winner: d.winnerName, reason: d.reason }); });
  s.on('notice', (d) => log(who, 'notice', d));
  s.on('chat', (d) => log(who, 'chat', d));
}

a.on('game_start', () => {
  a.emit('chat', { text: 'hello cả nhà <script>alert(1)</script>' });
  a.emit('react', { emoji: '🔥' });
});

let over = false;
a.on('game_over', () => { over = true; cleanup(); });

// Sau khi B bị loại -> C thoát -> A thắng
a.on('player_out', (d) => {
  if (d.name === 'Bảo') setTimeout(() => { log('C', '<<thoát>>'); c.close(); }, 400);
});

function cleanup() { setTimeout(() => { a.close(); try { b.close(); } catch {} try { c.close(); } catch {} process.exit(0); }, 500); }
setTimeout(() => { console.log(over ? 'DONE' : 'TIMEOUT - kết thúc test'); cleanup(); }, 45000);
