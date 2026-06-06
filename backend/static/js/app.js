const API_BASE = '/api';
const COLORS = { t1p1: '#e11d2a', t1p2: '#f26770', t2p1: '#334155', t2p2: '#64748b' };

let teams = [];
let games = [];
let touches = [], winner = null, activeGame = null, activeRallies = [], outcome = null;

// ---- AUTH ----
const SUPABASE_URL = 'https://irdcdguzsspippsgqyet.supabase.co';
const SUPABASE_KEY = 'sb_publishable_x7SLru0p9i_UwFbeyMKjUw_0dja3Pec';
const sb = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;
let session = null;
let authMode = 'login'; // 'login' | 'signup'

function authToken() { return session ? session.access_token : null; }

// Headers for write requests, including the Bearer token when logged in.
function writeHeaders() {
    const h = { 'Content-Type': 'application/json' };
    const t = authToken();
    if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
}

// Gate a write action on being logged in; prompts login if not.
function requireLogin() {
    if (session) return true;
    toast('Log in to do that');
    openAuthModal();
    return false;
}

function renderAuth() {
    const status = document.getElementById('auth-status');
    const loginBtn = document.getElementById('auth-login-btn');
    const logoutBtn = document.getElementById('auth-logout-btn');
    if (session) {
        status.textContent = session.user.email;
        loginBtn.style.display = 'none';
        logoutBtn.style.display = '';
    } else {
        status.textContent = 'not logged in';
        loginBtn.style.display = '';
        logoutBtn.style.display = 'none';
    }
}

function openAuthModal() { setAuthMode('login'); document.getElementById('auth-modal').style.display = 'flex'; }
function closeAuthModal() { document.getElementById('auth-modal').style.display = 'none'; }
function handleAuthBackdrop(e) { if (e.target === document.getElementById('auth-modal')) closeAuthModal(); }

function setAuthMode(mode) {
    authMode = mode;
    const isSignup = mode === 'signup';
    document.getElementById('auth-title').textContent = isSignup ? 'Sign Up' : 'Log In';
    document.getElementById('auth-submit').textContent = isSignup ? 'Sign Up' : 'Log In';
    document.getElementById('auth-toggle-text').textContent = isSignup ? 'Have an account?' : 'Need an account?';
    document.getElementById('auth-toggle-link').textContent = isSignup ? 'Log in' : 'Sign up';
}
function toggleAuthMode(e) { e.preventDefault(); setAuthMode(authMode === 'login' ? 'signup' : 'login'); }

async function submitAuth() {
    if (!sb) { toast('Auth unavailable'); return; }
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    if (!email || !password) { toast('Enter email and password'); return; }
    try {
        if (authMode === 'signup') {
            const { data, error } = await sb.auth.signUp({ email, password });
            if (error) { toast(error.message); return; }
            if (!data.session) { toast('Check your email to confirm, then log in'); setAuthMode('login'); return; }
            session = data.session;
        } else {
            const { data, error } = await sb.auth.signInWithPassword({ email, password });
            if (error) { toast(error.message); return; }
            session = data.session;
        }
        closeAuthModal();
        await refreshMe();
        toast('Logged in!');
    } catch (e) { toast('Auth error'); }
}

async function logout() {
    if (sb) await sb.auth.signOut();
    session = null;
    await refreshMe();
    toast('Logged out');
}

// ---- PLAYER TYPEAHEAD ----
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Generic player typeahead. opts: { allowNew, onPick(player), onNew(q), onType() }
function attachAutocomplete(inputId, resultsId, opts) {
    const input = document.getElementById(inputId);
    const results = document.getElementById(resultsId);
    if (!input || !results) return;
    let timer = null;

    input.addEventListener('input', () => {
        if (opts.onType) opts.onType();
        const q = input.value.trim();
        clearTimeout(timer);
        if (!q) { results.classList.remove('show'); results.innerHTML = ''; return; }
        timer = setTimeout(async () => {
            let players = [];
            try {
                const res = await fetch(`${API_BASE}/players/search?q=${encodeURIComponent(q)}`);
                players = await res.json();
            } catch (e) { }
            let html = players.map(p =>
                `<div class="ac-item" data-id="${p.id}" data-name="${escapeHtml(p.name)}">` +
                `<span>${escapeHtml(p.name)}</span>` +
                `${p.claimed ? '<span class="ac-badge">claimed</span>' : ''}</div>`).join('');
            if (opts.allowNew) {
                html += `<div class="ac-item ac-new" data-new="1"><span>+ Add new: ${escapeHtml(q)}</span></div>`;
            }
            if (!html) html = '<div class="ac-item" style="color:var(--muted)">No matches</div>';
            results.innerHTML = html;
            results.classList.add('show');
            results.querySelectorAll('.ac-item').forEach(el => {
                el.addEventListener('click', () => {
                    if (el.dataset.new) { if (opts.onNew) opts.onNew(input.value.trim()); }
                    else if (el.dataset.id && opts.onPick) {
                        opts.onPick({ id: parseInt(el.dataset.id), name: el.dataset.name });
                    }
                    results.classList.remove('show');
                });
            });
        }, 220);
    });

    document.addEventListener('click', (e) => {
        if (e.target !== input && !results.contains(e.target)) results.classList.remove('show');
    });
}

// When picked, store the existing player's id; typing again reverts to "new name".
const selectedPlayer = { p1: null, p2: null };

function setupAutocompletes() {
    ['p1', 'p2'].forEach(slot => {
        attachAutocomplete(slot, slot + '-results', {
            allowNew: true,
            onType: () => { selectedPlayer[slot] = null; },
            onPick: (p) => { document.getElementById(slot).value = p.name; selectedPlayer[slot] = p.id; }
        });
    });
    attachAutocomplete('claim-input', 'claim-results', {
        allowNew: false,
        onPick: (p) => claimPlayer(p.id)
    });
    attachAutocomplete('lookup-input', 'lookup-results', {
        allowNew: false,
        onPick: (p) => showProfile(p.id, 'lookup-profile')
    });
}

// ---- PROFILE / DASHBOARD ----
function renderPlayerProfile(data) {
    const c = data.career;
    const pct = (x) => (x * 100).toFixed(0) + '%';
    const cells = [
        ['Games', c.games], ['Win %', pct(c.win_pct)], ['Kills', c.kills ?? 0],
        ['Errors', c.errors ?? 0], ['Aces', c.aces], ['Points Won', c.points_won],
        ['RPR', pct(c.rpr)], ['Touches', c.touches]
    ];
    const grid = cells.map(([label, num]) =>
        `<div class="stat-box"><span class="stat-num">${num}</span><span class="stat-label">${label}</span></div>`).join('');
    const record = `${c.wins}-${c.losses}${c.ties ? '-' + c.ties : ''}`;
    let rows = data.recent_games.map(g => `
        <tr><td>${g.date || '—'}</td><td>${escapeHtml(g.opponent || '—')}</td>
        <td>${g.your_score}–${g.opp_score}</td>
        <td class="${g.result === 'W' ? 'result-w' : 'result-l'}">${g.result}</td></tr>`).join('');
    if (!rows) rows = '<tr><td colspan="4" style="color:var(--muted)">No games yet.</td></tr>';
    return `
      <div class="card profile-card">
        <h2 class="profile-name">${escapeHtml(data.player.name)}
          ${data.player.claimed ? '<span class="profile-badge">claimed</span>' : ''}</h2>
        <div class="stat-grid">${grid}</div>
        <h3>Record ${record} · Recent Games</h3>
        <table class="stats-table">
          <thead><tr><th>Date</th><th>Opponent</th><th>Score</th><th>Result</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
}

async function showProfile(playerId, containerId) {
    const el = document.getElementById(containerId);
    el.innerHTML = '<p class="empty-state" style="text-align:center">Loading…</p>';
    try {
        const res = await fetch(`${API_BASE}/players/${playerId}/stats`);
        if (!res.ok) { el.innerHTML = '<p class="empty-state" style="text-align:center">Player not found.</p>'; return; }
        el.innerHTML = renderPlayerProfile(await res.json());
    } catch (e) { el.innerHTML = '<p class="empty-state" style="text-align:center">Error loading stats.</p>'; }
}

function renderDashboard() {
    const el = document.getElementById('dashboard-content');
    if (!session) {
        el.innerHTML = `<div class="card"><h2>Your Dashboard</h2>
          <p class="empty-state">Log in to see your personal stats.</p>
          <button class="btn btn-primary" onclick="openAuthModal()">Log in</button></div>`;
        return;
    }
    if (!me || !me.player) {
        el.innerHTML = `<div class="card"><h2>Your Dashboard</h2>
          <p class="empty-state">Claim your player on the Teams tab to see your stats here.</p></div>`;
        return;
    }
    showProfile(me.player.id, 'dashboard-content');
}

// ---- CLAIM ----
let me = { user: null, player: null };

async function refreshMe() {
    try {
        const res = await fetch(`${API_BASE}/me`, { headers: writeHeaders() });
        me = await res.json();
    } catch (e) { me = { user: null, player: null }; }
    renderAuth();
    renderClaimCard();
    const dp = document.getElementById('dashboard-panel');
    if (dp && dp.classList.contains('active')) renderDashboard();
}

function renderClaimCard() {
    const card = document.getElementById('claim-card');
    if (!card) return;
    if (!session) { card.style.display = 'none'; return; }
    card.style.display = '';
    const claimed = document.getElementById('claim-claimed');
    const search = document.getElementById('claim-search');
    if (me && me.player) {
        document.getElementById('claim-name').textContent = me.player.name;
        claimed.style.display = '';
        search.style.display = 'none';
    } else {
        claimed.style.display = 'none';
        search.style.display = '';
    }
}

async function claimPlayer(id) {
    if (!requireLogin()) return;
    try {
        const res = await fetch(`${API_BASE}/players/${id}/claim`, { method: 'POST', headers: writeHeaders() });
        const data = await res.json();
        if (!res.ok) { toast(data.error || 'Could not claim'); return; }
        document.getElementById('claim-input').value = '';
        await refreshMe();
        toast('Claimed!');
    } catch (e) { toast('Could not claim'); }
}

async function init() {
    if (sb) {
        const { data } = await sb.auth.getSession();
        session = data.session;
        sb.auth.onAuthStateChange((_e, s) => { session = s; refreshMe(); });
    }
    setupAutocompletes();
    await refreshMe();
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
    if (name === 'dashboard') renderDashboard();
}

// TEAMS
async function createTeam() {
    const name = document.getElementById('team-name').value.trim();
    const p1 = document.getElementById('p1').value.trim();
    const p2 = document.getElementById('p2').value.trim();
    if (!name || !p1 || !p2) { toast('Fill all fields'); return; }
    if (!requireLogin()) return;

    // Send the picked existing player id, or a new name to create.
    const players = [
        selectedPlayer.p1 ? { id: selectedPlayer.p1 } : { name: p1 },
        selectedPlayer.p2 ? { id: selectedPlayer.p2 } : { name: p2 }
    ];

    try {
        const res = await fetch(`${API_BASE}/teams`, {
            method: 'POST',
            headers: writeHeaders(),
            body: JSON.stringify({ name, players })
        });
        if (res.ok) {
            await fetchTeams();
            document.getElementById('team-name').value = '';
            document.getElementById('p1').value = '';
            document.getElementById('p2').value = '';
            selectedPlayer.p1 = null;
            selectedPlayer.p2 = null;
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
    if (!requireLogin()) return;

    try {
        const res = await fetch(`${API_BASE}/games`, {
            method: 'POST',
            headers: writeHeaders(),
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
    resetRallyControls();

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

function addTouch(slot, name, id) {
    touches.push({ slot, name, player_id: id });
    renderSeq();
    if (outcome && outcome !== 'other') setOutcome(outcome); // re-derive winner
}
function undoTouch() {
    touches.pop();
    renderSeq();
    if (outcome && outcome !== 'other') setOutcome(outcome);
}

function resetRallyControls() {
    winner = null; outcome = null;
    document.getElementById('win-t1').className = 'winner-btn';
    document.getElementById('win-t2').className = 'winner-btn';
    ['kill', 'error', 'ace', 'other'].forEach(o =>
        document.getElementById('oc-' + o).classList.remove('sel'));
    document.getElementById('winner-row').style.display = 'none';
    document.getElementById('outcome-result').textContent = '';
}

function clearRally() {
    touches = [];
    resetRallyControls();
    renderSeq();
}

// Pick how the rally ended; derive the winner from the last toucher's team.
function setOutcome(oc) {
    outcome = oc;
    ['kill', 'error', 'ace', 'other'].forEach(o =>
        document.getElementById('oc-' + o).classList.toggle('sel', o === oc));
    const winnerRow = document.getElementById('winner-row');
    const resultEl = document.getElementById('outcome-result');

    if (oc === 'other') {
        winnerRow.style.display = 'block';
        resultEl.textContent = 'Pick the winning team below.';
        return;
    }
    winnerRow.style.display = 'none';
    if (!touches.length) { winner = null; resultEl.textContent = 'Tap the players first, then pick the outcome.'; return; }

    const lastTeam = touches[touches.length - 1].slot.startsWith('t1') ? 1 : 2;
    winner = (oc === 'error') ? (lastTeam === 1 ? 2 : 1) : lastTeam;
    const teamName = winner === 1 ? activeGame.team1.name : activeGame.team2.name;
    const label = oc.charAt(0).toUpperCase() + oc.slice(1);
    resultEl.textContent = `${label} → ${teamName} win`;
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
    if (!outcome) { toast('Pick how the rally ended'); return; }
    if (!winner) { toast('Select the winning team'); return; }
    if (!requireLogin()) return;

    const winning_team_id = winner === 1 ? activeGame.team1.id : activeGame.team2.id;
    const rallyData = {
        winner_team_id: winning_team_id,
        outcome: outcome,
        touches: touches.map((t, i) => ({ player_id: t.player_id, touch_order: i + 1 }))
    };

    try {
        const res = await fetch(`${API_BASE}/games/${activeGame.id}/rallies`, {
            method: 'POST',
            headers: writeHeaders(),
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
    el.innerHTML = activeRallies.map(r => {
        const typed = (r.rally_touch || []).find(t => t.touch_type && t.touch_type.touch_type_name);
        const oc = typed ? typed.touch_type.touch_type_name + ' · ' : '';
        const winName = r.winning_team_id === activeGame.team1.id ? activeGame.team1.name : activeGame.team2.name;
        return `
      <div class="rally-row">
        <span class="rally-num">#${r.rally_number}</span>
        ${r.rally_touch.map(t => {
            const name = t.player ? (t.player.f_name || '') : '?';
            return `<div class="touch-chip" style="background:#9ca3af;width:28px;height:28px;font-size:0.75rem;color:#fff;">${name[0].toUpperCase()}</div>`;
        }).join('')}
        <span style="margin-left:auto;font-family:var(--font-mono);font-size:0.7rem;color:var(--muted);">${oc}${winName} won</span>
      </div>`;
    }).join('');
}

// COMPLETE GAME
function openCompleteModal() {
    if (!activeGame) return;
    document.getElementById('modal-confirm').style.display = 'block';
    document.getElementById('modal-stats').style.display = 'none';
    document.getElementById('complete-modal').style.display = 'flex';
}

function closeModal() {
    document.getElementById('complete-modal').style.display = 'none';
}

function handleModalBackdrop(e) {
    if (e.target === document.getElementById('complete-modal')) closeModal();
}

async function confirmComplete() {
    if (!requireLogin()) return;
    try {
        const res = await fetch(`${API_BASE}/games/${activeGame.id}/complete`, {
            method: 'POST', headers: writeHeaders()
        });
        if (!res.ok) { toast('Error completing game'); return; }
        const data = await res.json();

        document.getElementById('modal-confirm').style.display = 'none';
        document.getElementById('modal-stats').style.display = 'block';

        document.getElementById('modal-final-score').innerHTML = `
            <div class="score-display" style="padding:0.5rem 0 1.2rem">
                <div class="score-team">
                    <span class="score-val" style="font-size:2.5rem;color:var(--t1a)">${data.game.team1_score}</span>
                    <span class="score-name">${activeGame.team1.name}</span>
                </div>
                <div class="score-divider">-</div>
                <div class="score-team">
                    <span class="score-val" style="font-size:2.5rem;color:var(--t2a)">${data.game.team2_score}</span>
                    <span class="score-name">${activeGame.team2.name}</span>
                </div>
            </div>`;

        renderStatsTable(data);
        toast('Game completed!');
    } catch (e) { toast('Error completing game'); }
}

function renderStatsTable(data) {
    const headers = ['Player', 'Touches', 'Rallies', 'Pts Won', 'Aces', 'RPR'];
    let html = `<table class="stats-table"><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>`;

    const renderTeamRows = (players, teamName) => {
        html += `<tr class="team-header"><td colspan="6">${teamName}</td></tr>`;
        for (const p of players) {
            html += `<tr>
                <td>${p.name}</td>
                <td>${p.touches}</td>
                <td>${p.rallies_participated}</td>
                <td>${p.points_won}</td>
                <td>${p.aces}</td>
                <td>${p.rallies_participated > 0 ? (p.rpr * 100).toFixed(1) + '%' : '—'}</td>
            </tr>`;
        }
    };

    renderTeamRows(data.team1, activeGame.team1.name);
    renderTeamRows(data.team2, activeGame.team2.name);
    html += '</tbody></table>';
    document.getElementById('modal-stats-table').innerHTML = html;
}

init();
