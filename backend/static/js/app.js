const API_BASE = '/api';
const COLORS = { t1p1: '#f97316', t1p2: '#fb923c', t2p1: '#38bdf8', t2p2: '#7dd3fc' };

let teams = [];
let games = [];
let touches = [], winner = null, activeGame = null, activeRallies = [];

async function init() {
    await fetchTeams();
    await fetchGames();
    renderTeams();
}

async function fetchTeams() {
    try {
        const res = await fetch(`${API_BASE}/teams`);
        teams = await res.json();
    } catch (e) { toast('Error fetching teams'); }
}

async function fetchGames() {
    try {
        const res = await fetch(`${API_BASE}/games`);
        games = await res.json();
    } catch (e) { toast('Error fetching games'); }
}

function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg; el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2000);
}

function switchTab(name, btn) {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(name + '-panel').classList.add('active');
    btn.classList.add('active');
    if (name === 'games') refreshTeamSelects();
    if (name === 'rally') refreshGameSelect();
}

// TEAMS
async function createTeam() {
    const name = document.getElementById('team-name').value.trim();
    const p1 = document.getElementById('p1').value.trim();
    const p2 = document.getElementById('p2').value.trim();
    if (!name || !p1 || !p2) { toast('Fill all fields'); return; }

    try {
        const res = await fetch(`${API_BASE}/teams`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, players: [p1, p2] })
        });
        if (res.ok) {
            await fetchTeams();
            document.getElementById('team-name').value = '';
            document.getElementById('p1').value = '';
            document.getElementById('p2').value = '';
            renderTeams();
            toast('Team saved!');
        }
    } catch (e) { toast('Error saving team'); }
}

function renderTeams() {
    const el = document.getElementById('team-list');
    el.innerHTML = teams.length
        ? teams.map(t => `<div class="team-list-item"><strong>${t.name}</strong><span style="color:var(--muted);font-size:0.75rem;">${t.players.map(p => p.name).join(' & ')}</span></div>`).join('')
        : '<p class="empty-state">No teams yet.</p>';
}

// GAMES
function refreshTeamSelects() {
    ['game-t1', 'game-t2'].forEach(id => {
        const s = document.getElementById(id);
        s.innerHTML = '<option value="">Select...</option>';
        teams.forEach(t => { const o = document.createElement('option'); o.value = t.id; o.textContent = t.name; s.appendChild(o); });
    });
    renderGames();
}

async function createGame() {
    const t1id = parseInt(document.getElementById('game-t1').value);
    const t2id = parseInt(document.getElementById('game-t2').value);
    const date = document.getElementById('game-date').value;
    const desc = document.getElementById('game-desc').value.trim();
    if (!t1id || !t2id) { toast('Select both teams'); return; }
    if (t1id === t2id) { toast('Pick different teams'); return; }

    try {
        const res = await fetch(`${API_BASE}/games`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ team1_id: t1id, team2_id: t2id, date, description: desc })
        });
        if (res.ok) {
            await fetchGames();
            document.getElementById('game-date').value = '';
            document.getElementById('game-desc').value = '';
            renderGames();
            toast('Game created!');
        }
    } catch (e) { toast('Error creating game'); }
}

function renderGames() {
    const el = document.getElementById('game-list');
    el.innerHTML = games.length
        ? games.map(g => `<div class="team-list-item"><strong>${g.team1.name}</strong><span style="color:var(--muted)">vs</span><strong>${g.team2.name}</strong>${g.date ? `<span style="color:var(--muted);font-size:0.75rem;">${g.date}</span>` : ''}<span style="color:var(--muted);font-size:0.75rem;">${g.team1_score} - ${g.team2_score}</span></div>`).join('')
        : '<p class="empty-state">No games yet.</p>';
}

// RALLY
function refreshGameSelect() {
    const s = document.getElementById('rally-game-sel');
    s.innerHTML = '<option value="">Choose a game...</option>';
    games.forEach(g => {
        const o = document.createElement('option');
        o.value = g.id;
        o.textContent = `${g.team1.name} vs ${g.team2.name}${g.date ? ' · ' + g.date : ''}`;
        s.appendChild(o);
    });
}

async function loadGame() {
    const gid = parseInt(document.getElementById('rally-game-sel').value);
    activeGame = games.find(g => g.id === gid) || null;
    touches = []; winner = null;
    const inp = document.getElementById('rally-input');
    const hist = document.getElementById('rally-hist');
    const scoreCard = document.getElementById('rally-score-card');

    if (!activeGame) {
        inp.style.display = 'none';
        hist.style.display = 'none';
        scoreCard.style.display = 'none';
        return;
    }

    // Fetch team players to get IDs
    const t1 = teams.find(t => t.id === activeGame.team1.id);
    const t2 = teams.find(t => t.id === activeGame.team2.id);

    const slots = [
        { slot: 't1p1', id: t1.players[0].id, name: t1.players[0].name },
        { slot: 't1p2', id: t1.players[1].id, name: t1.players[1].name },
        { slot: 't2p1', id: t2.players[0].id, name: t2.players[0].name },
        { slot: 't2p2', id: t2.players[1].id, name: t2.players[1].name },
    ];

    document.getElementById('player-btns').innerHTML = slots.map(s => `
      <div class="player-btn-wrap">
        <button class="player-btn" data-slot="${s.slot}" onclick="addTouch('${s.slot}','${s.name}', ${s.id})">${s.name[0].toUpperCase()}</button>
        <div class="player-label">${s.name}</div>
      </div>`).join('');

    document.getElementById('win-t1').textContent = activeGame.team1.name + ' wins';
    document.getElementById('win-t2').textContent = activeGame.team2.name + ' wins';
    document.getElementById('win-t1').className = 'winner-btn';
    document.getElementById('win-t2').className = 'winner-btn';

    inp.style.display = 'block';
    hist.style.display = 'block';
    scoreCard.style.display = 'block';

    renderScore();
    renderSeq();
    await fetchRallies();
}

function renderScore() {
    if (!activeGame) return;
    document.getElementById('score-t1-name').textContent = activeGame.team1.name;
    document.getElementById('score-t2-name').textContent = activeGame.team2.name;
    document.getElementById('score-t1-val').textContent = activeGame.team1_score || 0;
    document.getElementById('score-t2-val').textContent = activeGame.team2_score || 0;
}

async function fetchRallies() {
    if (!activeGame) return;
    try {
        const res = await fetch(`${API_BASE}/games/${activeGame.id}/rallies`);
        activeRallies = await res.json();
        renderHistory();
    } catch (e) { toast('Error fetching rallies'); }
}

function addTouch(slot, name, id) { touches.push({ slot, name, player_id: id }); renderSeq(); }
function undoTouch() { touches.pop(); renderSeq(); }
function clearRally() {
    touches = []; winner = null;
    document.getElementById('win-t1').className = 'winner-btn';
    document.getElementById('win-t2').className = 'winner-btn';
    renderSeq();
}

function renderSeq() {
    const el = document.getElementById('rally-sequence');
    el.innerHTML = touches.length
        ? touches.map(t => `<div class="touch-chip" style="background:${COLORS[t.slot]}">${t.name[0].toUpperCase()}</div>`).join('')
        : '<span style="color:var(--muted);font-family:var(--font-mono);font-size:0.75rem;">tap players above...</span>';
}

function setWinner(n) {
    winner = n;
    document.getElementById('win-t1').className = 'winner-btn' + (n === 1 ? ' sel-t1' : '');
    document.getElementById('win-t2').className = 'winner-btn' + (n === 2 ? ' sel-t2' : '');
}

async function saveRally() {
    if (!touches.length) { toast('Add at least one touch'); return; }
    if (!winner) { toast('Select a winner'); return; }

    const winning_team_id = winner === 1 ? activeGame.team1.id : activeGame.team2.id;
    const rallyData = {
        winner_team_id: winning_team_id,
        touches: touches.map((t, i) => ({ player_id: t.player_id, touch_order: i + 1 }))
    };

    try {
        const res = await fetch(`${API_BASE}/games/${activeGame.id}/rallies`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rallyData)
        });
        if (res.ok) {
            clearRally();
            await fetchRallies();
            await fetchGames(); // Refresh all games list
            // Sync activeGame with updated scores
            activeGame = games.find(g => g.id === activeGame.id);
            renderScore();
            toast('Rally saved!');
        }
    } catch (e) { toast('Error saving rally'); }
}

function renderHistory() {
    const el = document.getElementById('rally-list');
    if (!activeRallies || !activeRallies.length) { el.innerHTML = '<p class="empty-state">No rallies yet.</p>'; return; }
    el.innerHTML = activeRallies.map((r, i) => `
      <div class="rally-row">
        <span class="rally-num">#${r.rally_number}</span>
        ${r.rally_touch.map(t => {
        const name = t.player ? (t.player.f_name || '') : '?';
        return `<div class="touch-chip" style="background:#888;width:28px;height:28px;font-size:0.75rem;color:#000;">${name[0].toUpperCase()}</div>`;
    }).join('')}
        <span style="margin-left:auto;
        font-family:var(--font-mono);
        font-size:0.7rem;color:var(--muted);">${r.winning_team_id === activeGame.team1.id ? activeGame.team1.name : activeGame.team2.name} won</span>
      </div>`).join('');
}

init();
