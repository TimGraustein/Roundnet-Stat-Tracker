from flask import request
from flask import Flask, jsonify, request, send_from_directory
from supabase import create_client, Client
from dotenv import load_dotenv
from flask_cors import CORS  # front and back can comm on diff ports
import os

load_dotenv()

app = Flask(__name__, static_url_path='', static_folder='static')
CORS(app)

url = os.environ.get("SUPABASE_URL")
key = os.environ.get("SUPABASE_KEY")
supabase: Client = create_client(url, key)

# --- UTILS ---


def split_name(name):
    parts = name.strip().split(' ', 1)
    if len(parts) > 1:
        return parts[0], parts[1]
    return parts[0], ''

# --- AUTH ---


def _bearer_token():
    """Pull the Supabase JWT out of the Authorization header, if present."""
    header = request.headers.get('Authorization', '')
    if header.startswith('Bearer '):
        return header[7:].strip()
    return None


def current_user_and_db():
    """Validate the request's Supabase JWT.

    Returns (user, db) where `db` is a Supabase client carrying the user's token
    so Postgres RLS evaluates auth.uid() as this user. Returns (None, None) when
    the request is unauthenticated or the token is invalid/expired.
    """
    token = _bearer_token()
    if not token:
        return None, None
    try:
        user = supabase.auth.get_user(token).user
    except Exception:
        return None, None
    if not user:
        return None, None
    db = create_client(url, key)
    db.postgrest.auth(token)
    return user, db


def login_required():
    """For write endpoints: returns (user, db) or an error tuple to return early."""
    user, db = current_user_and_db()
    if not user:
        return None, None, (jsonify({'error': 'Login required'}), 401)
    return user, db, None

# --- ERROR HANDLING ---


@app.errorhandler(Exception)
def handle_exception(e):
    """Global error handler for all unhandled exceptions."""
    # Log the error
    app.logger.error(f"Unhandled Exception: {str(e)}")
    return jsonify({'error': str(e)}), 500

# --- FRONTEND ---


@app.route('/api/config', methods=['GET'])
def get_config():
    """Expose the public Supabase URL + publishable key (from .env) to the
    frontend, so they are never hardcoded in committed JS. The publishable key
    is designed to be public; access control is enforced by RLS."""
    return jsonify({'url': url, 'key': key})


@app.route('/')
def index():
    return send_from_directory('static', 'index.html')

# --- AUTH / SESSION ---


@app.route('/api/me', methods=['GET'])
def get_me():
    """Returns the logged-in user and their claimed player (if any). Never 401s
    so the frontend can call it to decide whether to show logged-in UI."""
    user, db = current_user_and_db()
    if not user:
        return jsonify({'user': None, 'player': None})
    player = None
    try:
        res = db.table('player').select(
            'player_id, f_name, l_name').eq('user_id', user.id).limit(1).execute()
        if res.data:
            p = res.data[0]
            player = {'id': p['player_id'],
                      'name': f"{p.get('f_name', '')} {p.get('l_name', '')}".strip()}
    except Exception:
        pass
    return jsonify({'user': {'id': user.id, 'email': user.email}, 'player': player})

# --- TEAMS ---


@app.route('/api/teams', methods=['GET'])
def get_teams():
    data = supabase.table('team').select(
        'team_id, team_name, team_player(player(player_id, f_name, l_name))').execute()
    formatted = []
    for t in data.data:
        players = []
        for tp in t.get('team_player', []):
            p = tp.get('player', {})
            name = f"{p.get('f_name', '')} {p.get('l_name', '')}".strip()
            players.append({'id': p.get('player_id'), 'name': name})
        formatted.append({
            'id': t['team_id'],
            'name': t['team_name'],
            'players': players
        })
    return jsonify(formatted)


@app.route('/api/teams', methods=['POST'])
def create_team():
    user, db, err = login_required()
    if err:
        return err

    body = request.json
    team_res = db.table('team').insert(
        {'team_name': body['name']}).execute()
    team_id = team_res.data[0]['team_id']

    # Each player entry is either an existing global player {'id': N} or a new
    # one (a name string, or {'name': '...'}). Existing players are reused so the
    # same human stays one identity across teams instead of spawning duplicates.
    for entry in body['players']:
        if isinstance(entry, dict) and entry.get('id'):
            player_id = entry['id']
        else:
            name = entry.get('name') if isinstance(entry, dict) else entry
            fname, lname = split_name(name or '')
            player_res = db.table('player').insert(
                {'f_name': fname, 'l_name': lname}).execute()
            player_id = player_res.data[0]['player_id']
        db.table('team_player').insert(
            {'team_id': team_id, 'player_id': player_id}).execute()

    return jsonify({'id': team_id, 'name': body['name']}), 201

# --- PLAYERS ---


@app.route('/api/players/search', methods=['GET'])
def search_players():
    """Public typeahead over global players by first or last name."""
    q = request.args.get('q', '').strip()
    if not q:
        return jsonify([])
    # Strip characters that would break PostgREST's or_ filter syntax.
    safe = q.translate(str.maketrans('', '', ',()*'))
    if not safe:
        return jsonify([])
    res = supabase.table('player').select('player_id, f_name, l_name, user_id').or_(
        f'f_name.ilike.%{safe}%,l_name.ilike.%{safe}%').order('f_name').limit(10).execute()
    out = [{
        'id': p['player_id'],
        'name': f"{p.get('f_name', '')} {p.get('l_name', '')}".strip(),
        'claimed': p.get('user_id') is not None
    } for p in res.data]
    return jsonify(out)


@app.route('/api/players/<int:player_id>/claim', methods=['POST'])
def claim_player(player_id):
    """Link the logged-in user to a player record (one player per user)."""
    user, db, err = login_required()
    if err:
        return err

    already = db.table('player').select('player_id').eq(
        'user_id', user.id).limit(1).execute()
    if already.data:
        return jsonify({'error': 'You have already claimed a player'}), 400

    target = db.table('player').select('player_id, user_id').eq(
        'player_id', player_id).limit(1).execute()
    if not target.data:
        return jsonify({'error': 'Player not found'}), 404
    if target.data[0].get('user_id'):
        return jsonify({'error': 'This player is already claimed'}), 400

    db.table('player').update({'user_id': user.id}).eq(
        'player_id', player_id).execute()
    return jsonify({'ok': True, 'player_id': player_id}), 200


@app.route('/api/players/<int:player_id>/stats', methods=['GET'])
def player_stats(player_id):
    """Public career stats for a player, computed live from raw rally data so it
    covers every game they played (not just 'completed' ones in the stat table)."""
    pres = supabase.table('player').select(
        'player_id, f_name, l_name, user_id').eq('player_id', player_id).limit(1).execute()
    if not pres.data:
        return jsonify({'error': 'Player not found'}), 404
    p = pres.data[0]
    name = f"{p.get('f_name', '')} {p.get('l_name', '')}".strip()

    empty_career = {'games': 0, 'wins': 0, 'losses': 0, 'ties': 0, 'win_pct': 0.0,
                    'rallies': 0, 'touches': 0, 'points_won': 0, 'aces': 0,
                    'kills': 0, 'errors': 0, 'rpr': 0.0}
    result = {
        'player': {'id': player_id, 'name': name, 'claimed': p.get('user_id') is not None},
        'career': dict(empty_career),
        'recent_games': []
    }

    # Which team the player was on, per game.
    tp = supabase.table('team_player').select(
        'team_id').eq('player_id', player_id).execute()
    team_ids = [r['team_id'] for r in tp.data]
    if not team_ids:
        return jsonify(result)

    ptg = supabase.table('team_game').select(
        'game_id, team_id').in_('team_id', team_ids).execute()
    player_team_by_game = {r['game_id']: r['team_id'] for r in ptg.data}
    game_ids = list(player_team_by_game.keys())
    if not game_ids:
        return jsonify(result)

    # Both teams per game (for opponent name) and game dates.
    tg = supabase.table('team_game').select(
        'game_id, team_id, team(team_name)').in_('game_id', game_ids).execute()
    teams_by_game = {}
    for r in tg.data:
        teams_by_game.setdefault(r['game_id'], []).append(
            {'team_id': r['team_id'], 'name': (r.get('team') or {}).get('team_name')})
    gmeta = supabase.table('game').select(
        'game_id, date_played').in_('game_id', game_ids).execute()
    date_by_game = {r['game_id']: r.get('date_played') for r in gmeta.data}

    # All rallies + touches (with outcome type) for those games.
    rres = supabase.table('rally').select(
        'rally_id, game_id, winning_team_id, '
        'rally_touch(player_id, touch_order, touch_type(touch_type_name))'
    ).in_('game_id', game_ids).execute()

    touches = points_won = aces = rallies_participated = 0
    kills = errors = 0
    rally_wins_by_game = {}  # game_id -> {team_id: rally wins}
    for rally in rres.data:
        gid = rally['game_id']
        win_team = rally['winning_team_id']
        rwins = rally_wins_by_game.setdefault(gid, {})
        rwins[win_team] = rwins.get(win_team, 0) + 1

        t_list = sorted(rally.get('rally_touch', []),
                        key=lambda t: int(t['touch_order']))
        my_touches = [t for t in t_list if t['player_id'] == player_id]
        if not my_touches:
            continue
        my_team = player_team_by_game.get(gid)
        rallies_participated += 1
        touches += len(my_touches)
        if my_team is not None and win_team == my_team:
            points_won += 1
        if len(t_list) == 1 and t_list[0]['player_id'] == player_id and win_team == my_team:
            aces += 1
        for t in my_touches:
            tname = (t.get('touch_type') or {}).get('touch_type_name')
            if tname == 'kill':
                kills += 1
            elif tname == 'error':
                errors += 1

    # Per-game results + recent list.
    wins = losses = ties = 0
    recent = []
    for gid, my_team in player_team_by_game.items():
        rwins = rally_wins_by_game.get(gid, {})
        if sum(rwins.values()) == 0:
            continue  # no rallies recorded yet; not a played game
        opp = next((t for t in teams_by_game.get(gid, [])
                    if t['team_id'] != my_team), {'team_id': None, 'name': None})
        my_score = rwins.get(my_team, 0)
        opp_score = rwins.get(opp['team_id'], 0)
        if my_score > opp_score:
            wins += 1
            res = 'W'
        elif my_score < opp_score:
            losses += 1
            res = 'L'
        else:
            ties += 1
            res = 'T'
        recent.append({
            'game_id': gid, 'date': date_by_game.get(gid), 'opponent': opp['name'],
            'your_score': my_score, 'opp_score': opp_score, 'result': res
        })

    games = wins + losses + ties
    recent.sort(key=lambda r: (r['date'] or ''), reverse=True)
    result['career'] = {
        'games': games, 'wins': wins, 'losses': losses, 'ties': ties,
        'win_pct': round(wins / games, 3) if games else 0.0,
        'rallies': rallies_participated, 'touches': touches,
        'points_won': points_won, 'aces': aces, 'kills': kills, 'errors': errors,
        'rpr': round(points_won / rallies_participated, 3) if rallies_participated else 0.0
    }
    result['recent_games'] = recent[:15]
    return jsonify(result)

# --- GAMES ---


@app.route('/api/games', methods=['GET'])
def get_games():
    data = supabase.table('game').select(
        '*, team_game(team(team_id, team_name))').execute()
    formatted = []
    for g in data.data:
        teams = [tg.get('team', {}) for tg in g.get('team_game', [])]
        t1 = teams[0] if len(teams) > 0 else {}
        t2 = teams[1] if len(teams) > 1 else {}
        formatted.append({
            'id': g['game_id'],
            'team1': {'id': t1.get('team_id'), 'name': t1.get('team_name')},
            'team2': {'id': t2.get('team_id'), 'name': t2.get('team_name')},
            'date': g.get('date_played'),
            'desc': g.get('description'),
            'team1_score': g.get('team1_score', 0),
            'team2_score': g.get('team2_score', 0)
        })
    return jsonify(formatted)


@app.route('/api/games', methods=['POST'])
def create_game():
    user, db, err = login_required()
    if err:
        return err

    body = request.json
    game_res = db.table('game').insert({
        'date_played': body.get('date') or None,
        'description': body.get('description', ''),
        'team1_score': 0,
        'team2_score': 0
    }).execute()
    game_id = game_res.data[0]['game_id']

    db.table('team_game').insert(
        {'game_id': game_id, 'team_id': body['team1_id']}).execute()
    db.table('team_game').insert(
        {'game_id': game_id, 'team_id': body['team2_id']}).execute()

    return jsonify({'id': game_id}), 201

# --- RALLIES ---


@app.route('/api/games/<int:game_id>/rallies', methods=['GET'])
def get_rallies(game_id):
    data = supabase.table('rally').select(
        '*, rally_touch(player(f_name, l_name), touch_order, touch_type(touch_type_name))'
    ).filter('game_id', 'eq', game_id).order('rally_number').execute()
    return jsonify(data.data)


@app.route('/api/games/<int:game_id>/rallies', methods=['POST'])
def create_rally(game_id):
    user, db, err = login_required()
    if err:
        return err

    body = request.json

    # 1. Get next rally number
    res = db.table('rally').select('rally_number').filter(
        'game_id', 'eq', game_id).order('rally_number', desc=True).limit(1).execute()
    next_num = 1
    if res.data:
        next_num = res.data[0]['rally_number'] + 1

    # 2. Insert Rally
    rally_res = db.table('rally').insert({
        'game_id': game_id,
        'winning_team_id': body['winner_team_id'],
        'rally_number': next_num
    }).execute()
    rally_id = rally_res.data[0]['rally_id']

    # 3. Insert Touches; tag the final touch with the rally outcome
    # (kill/error/ace) so per-player kill/error/ace stats are attributable.
    outcome = (body.get('outcome') or '').lower()
    type_id = None
    if outcome in ('kill', 'error', 'ace'):
        tt = db.table('touch_type').select('touch_type_id').eq(
            'touch_type_name', outcome).limit(1).execute()
        if tt.data:
            type_id = tt.data[0]['touch_type_id']

    touch_list = body['touches']
    last_idx = len(touch_list) - 1
    for i, touch in enumerate(touch_list):
        row = {
            'rally_id': rally_id,
            'player_id': touch['player_id'],
            'touch_order': str(touch['touch_order'])
        }
        if i == last_idx and type_id is not None:
            row['touch_type_id'] = type_id
        db.table('rally_touch').insert(row).execute()

    # 4. Update Game Scores
    # We fetch the game and its team associations using the same logic as get_games
    # to ensure "team1_score" and "team2_score" match the right teams.
    game_res = db.table('game').select(
        '*, team_game(team_id)').filter('game_id', 'eq', game_id).execute()

    if game_res.data and len(game_res.data[0].get('team_game', [])) >= 2:
        g = game_res.data[0]
        # Get team IDs in the order they are returned (same as get_games)
        team_ids = [tg.get('team_id') for tg in g.get('team_game', [])]
        t1_id = team_ids[0]
        t2_id = team_ids[1]

        all_rallies = db.table('rally').select(
            'winning_team_id').filter('game_id', 'eq', game_id).execute()

        t1_score = sum(
            1 for r in all_rallies.data if r['winning_team_id'] == t1_id)
        t2_score = sum(
            1 for r in all_rallies.data if r['winning_team_id'] == t2_id)

        db.table('game').update({
            'team1_score': t1_score,
            'team2_score': t2_score
        }).filter('game_id', 'eq', game_id).execute()

    return jsonify({'id': rally_id}), 201


# --- STATS ---


@app.route('/api/games/<int:game_id>/complete', methods=['POST'])
def complete_game(game_id):
    user, db, err = login_required()
    if err:
        return err

    game_res = db.table('game').select(
        '*, team_game(team_id)').filter('game_id', 'eq', game_id).execute()
    if not game_res.data:
        return jsonify({'error': 'Game not found'}), 404

    g = game_res.data[0]
    team_ids = [tg['team_id'] for tg in g.get('team_game', [])]

    # Fetch players for each team
    player_team = {}
    players_by_team = {}
    for team_id in team_ids:
        tp_res = db.table('team_player').select(
            'player_id, player(f_name, l_name)').filter('team_id', 'eq', team_id).execute()
        players_by_team[team_id] = []
        for row in tp_res.data:
            pid = row['player_id']
            p = row.get('player', {})
            name = f"{p.get('f_name', '')} {p.get('l_name', '')}".strip()
            players_by_team[team_id].append({'player_id': pid, 'name': name})
            player_team[pid] = team_id

    # Fetch all rallies with their touch sequences
    rallies_res = db.table('rally').select(
        'rally_id, winning_team_id, rally_touch(player_id, touch_order)').filter(
        'game_id', 'eq', game_id).execute()

    all_player_ids = [p['player_id']
                      for tid in team_ids for p in players_by_team[tid]]
    stat_map = {pid: {'touches': 0, 'rallies_participated': 0, 'points_won': 0, 'aces': 0}
                for pid in all_player_ids}

    for rally in rallies_res.data:
        winning_team = rally['winning_team_id']
        touches = sorted(rally.get('rally_touch', []),
                         key=lambda t: int(t['touch_order']))
        players_in_rally = {t['player_id'] for t in touches}

        for touch in touches:
            pid = touch['player_id']
            if pid in stat_map:
                stat_map[pid]['touches'] += 1

        for pid in players_in_rally:
            if pid in stat_map:
                stat_map[pid]['rallies_participated'] += 1
                if player_team.get(pid) == winning_team:
                    stat_map[pid]['points_won'] += 1

        # Ace: serve was unreturned (only 1 touch) and serving team won
        if len(touches) == 1:
            server_pid = touches[0]['player_id']
            if server_pid in stat_map and player_team.get(server_pid) == winning_team:
                stat_map[server_pid]['aces'] += 1

    # Upsert stats and build response
    result = {
        'game': {
            'team1_score': g.get('team1_score', 0),
            'team2_score': g.get('team2_score', 0)
        },
        'team1': [],
        'team2': []
    }

    for i, team_id in enumerate(team_ids):
        key = f'team{i + 1}'
        for p in players_by_team[team_id]:
            pid = p['player_id']
            s = stat_map.get(
                pid, {'touches': 0, 'rallies_participated': 0, 'points_won': 0, 'aces': 0})
            rpr = round(s['points_won'] / s['rallies_participated'],
                        3) if s['rallies_participated'] > 0 else 0.0

            db.table('stat').upsert({
                'player_id': pid,
                'game_id': game_id,
                'aces': s['aces'],
                'rpr': rpr,
                'errors': 0,
                'strong_set': 0,
                'weak_set': 0
            }, on_conflict='player_id,game_id').execute()

            result[key].append({
                'player_id': pid,
                'name': p['name'],
                'team_id': team_id,
                'touches': s['touches'],
                'rallies_participated': s['rallies_participated'],
                'points_won': s['points_won'],
                'aces': s['aces'],
                'rpr': rpr
            })

    return jsonify(result), 200


if __name__ == '__main__':
    # Using standard 5001
    app.run(debug=True, port=5001)
