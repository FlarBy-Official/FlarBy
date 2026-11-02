import { el, toast, openModal } from '../core.js';

// Tic-Tac-Toe im Einzelchat. Läuft nur über den Echtzeit-Kanal (nichts wird gespeichert).
// Beide müssen den Chat offen haben. Ereignis "ttt": { t: 'invite'|'accept'|'decline'|'move'|'end', id, from, i }
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

function winner(b) {
  for (const [a, x, y] of LINES) if (b[a] && b[a] === b[x] && b[a] === b[y]) return b[a];
  return b.every(Boolean) ? 'draw' : null;
}

export function createGame({ getChannel, myId, peerId, peerName }) {
  let g = null; // { id, mine, board, turn, over }
  let modal = null;
  let board = null;
  let info = null;

  const send = payload => getChannel()?.send({ type: 'broadcast', event: 'ttt', payload: { ...payload, from: myId } });
  const closeModal = () => { modal?.close(); modal = null; };

  function ui() {
    if (!board) return;
    const w = winner(g.board);
    if (w) g.over = true;
    board.replaceChildren(...g.board.map((v, i) => el('button', {
      class: 'ttt-cell' + (v === 'X' ? ' x' : v === 'O' ? ' o' : ''), disabled: !!v || g.over || g.turn !== g.mine,
      onclick: () => play(i),
    }, v || '')));
    info.textContent = w === 'draw' ? 'Unentschieden! 🤝'
      : w ? (w === g.mine ? 'Du hast gewonnen! 🎉' : peerName + ' hat gewonnen.')
        : g.turn === g.mine ? 'Du bist dran (' + g.mine + ')' : peerName + ' ist dran …';
  }

  function openBoard() {
    closeModal();
    board = el('div', { class: 'ttt-board' });
    info = el('div', { class: 'ttt-info' });
    const content = el('div', { class: 'ttt' }, info, board,
      el('div', { class: 'muted small' }, 'Du bist ' + g.mine + '. ' + (g.mine === 'X' ? 'Du fängst an.' : peerName + ' fängt an.')));
    modal = openModal('Tic-Tac-Toe mit ' + peerName, content);
    modal.box.parentElement.addEventListener('mousedown', e => { if (e.target === modal?.box.parentElement) end(true); });
    modal.box.querySelector('.modal-head button').onclick = () => end(true);
    ui();
  }

  function play(i) {
    if (!g || g.over || g.turn !== g.mine || g.board[i]) return;
    g.board[i] = g.mine;
    g.turn = g.mine === 'X' ? 'O' : 'X';
    send({ t: 'move', id: g.id, i });
    ui();
  }

  function end(tell) {
    if (tell && g) send({ t: 'end', id: g.id });
    g = null;
    closeModal();
  }

  function invite() {
    if (g) { toast('Es läuft schon ein Spiel.'); return; }
    const id = Math.random().toString(36).slice(2);
    g = { id, mine: 'X', board: Array(9).fill(''), turn: 'X', over: false, waiting: true };
    send({ t: 'invite', id });
    modal = openModal('Tic-Tac-Toe', el('div', { class: 'ttt' }, el('p', {}, 'Warte auf ' + peerName + ' …'),
      el('button', { class: 'btn ghost', onclick: () => end(true) }, 'Abbrechen')));
    modal.box.querySelector('.modal-head button').onclick = () => end(true);
  }

  function handle(p) {
    if (!p || p.from !== peerId) return;
    if (p.t === 'invite') {
      if (g) { send({ t: 'decline', id: p.id }); return; }
      g = { id: p.id, mine: 'O', board: Array(9).fill(''), turn: 'X', over: false, waiting: true, incoming: true };
      modal = openModal('Tic-Tac-Toe', el('div', { class: 'ttt' }, el('p', {}, peerName + ' möchte Tic-Tac-Toe mit dir spielen!'),
        el('button', { class: 'btn', onclick: () => { g.waiting = false; send({ t: 'accept', id: g.id }); openBoard(); } }, 'Mitspielen'),
        ' ', el('button', { class: 'btn ghost', onclick: () => { send({ t: 'decline', id: g.id }); end(false); } }, 'Nein danke')));
      modal.box.querySelector('.modal-head button').onclick = () => { send({ t: 'decline', id: g.id }); end(false); };
      return;
    }
    if (!g || p.id !== g.id) return;
    if (p.t === 'accept' && g.waiting && !g.incoming) { g.waiting = false; openBoard(); }
    else if (p.t === 'decline') { toast(peerName + ' möchte gerade nicht spielen.'); end(false); }
    else if (p.t === 'end') { toast(peerName + ' hat das Spiel beendet.'); end(false); }
    else if (p.t === 'move' && !g.waiting && !g.over) {
      const i = Number(p.i);
      if (!Number.isInteger(i) || i < 0 || i > 8 || g.board[i] || g.turn === g.mine) return;
      g.board[i] = g.turn;
      g.turn = g.mine;
      ui();
    }
  }

  return { invite, handle, destroy: () => { g = null; closeModal(); } };
}
