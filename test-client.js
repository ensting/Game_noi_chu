// Test e2e: 2 người chơi nối chữ qua socket.io-client
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';

const a = io(URL);
const b = io(URL);
let code = null;
let aId = null, bId = null;
let turns = 0;

const log = (who, ev, d) => console.log(`[${who}] ${ev}`, JSON.stringify(d));

a.on('room_created', (d) => {
  aId = d.you; code = d.code;
  log('A', 'room_created', d);
  b.emit('join_room', { code, name: 'Bảo' });
});

b.on('joined', (d) => { bId = d.you; log('B', 'joined', d); });
b.on('join_error', (d) => log('B', 'join_error', d));

function onTurn(who, socket) {
  socket.on('turn', (d) => {
    log(who, 'turn', { turnId: d.turnId === socket.id ? 'ME' : 'OTHER', nextSyllable: d.nextSyllable, lastWord: d.lastWord });
    if (d.turnId === socket.id) {
      turns++;
      // Chuỗi danh từ thật: học sinh → sinh viên → viên chức → chức vụ → vụ việc → việc làm
      const words = { 'học sinh': 'sinh viên', 'sinh viên': 'viên chức', 'viên chức': 'chức vụ', 'chức vụ': 'vụ việc', 'vụ việc': 'việc làm' };
      if (d.lastWord && words[d.lastWord]) socket.emit('submit_word', { word: words[d.lastWord] });
      else if (!d.lastWord) socket.emit('submit_word', { word: 'học sinh' });
      else socket.emit('submit_word', { word: 'làm ăn' }); // test từ ko phải danh từ
    }
  });
}
onTurn('A', a);
onTurn('B', b);

a.on('connect', () => { if (!aId) a.emit('create_room', { name: 'An' }); });
a.on('word_played', (d) => log('A', 'word_played', d));
b.on('word_played', (d) => log('B', 'word_played', d));
a.on('invalid_word', (d) => log('A', 'invalid_word', d));
b.on('invalid_word', (d) => log('B', 'invalid_word', d));
a.on('chat', (d) => log('A', 'chat', d));
b.on('chat', (d) => { log('B', 'chat', d); });
a.on('reaction', (d) => log('A', 'reaction', d));
b.on('reaction', (d) => log('B', 'reaction', d));
a.on('checking_word', (d) => log('A', 'checking', d));
b.on('checking_word', (d) => log('B', 'checking', d));
a.on('game_start', (d) => {
  log('A', 'game_start', { players: d.players.map(p => p.name) });
  // test chat + react
  a.emit('chat', { text: 'hello Bảo <script>alert(1)</script>' });
  b.emit('chat', { text: 'hi An, chơi đi!' });
  a.emit('react', { emoji: '🔥' });
});
a.on('game_over', (d) => { log('A', 'game_over', d); cleanup(); });
b.on('game_over', (d) => { log('B', 'game_over', d); });

function cleanup() { setTimeout(() => { a.close(); b.close(); process.exit(0); }, 500); }
setTimeout(() => { console.log('TIMEOUT - kết thúc test'); cleanup(); }, 45000);
