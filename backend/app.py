from flask import Flask, jsonify, request, send_from_directory
from supabase import create_client, Client
from dotenv import load_dotenv
from flask_cors import CORS
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

# --- ERROR HANDLING ---


@app.errorhandler(Exception)
def handle_exception(e):
    """Global error handler for all unhandled exceptions."""
    # Log the error (optional but recommended)
    app.logger.error(f"Unhandled Exception: {str(e)}")
    return jsonify({'error': str(e)}), 500

# --- FRONTEND ---


@app.route('/')
def index():
    return send_from_directory('static', 'index.html')

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
    body = request.json
    team_res = supabase.table('team').insert(
        {'team_name': body['name']}).execute()
    team_id = team_res.data[0]['team_id']

    for name in body['players']:
        fname, lname = split_name(name)
        player_res = supabase.table('player').insert(
            {'f_name': fname, 'l_name': lname}).execute()
        player_id = player_res.data[0]['player_id']
        supabase.table('team_player').insert(
            {'team_id': team_id, 'player_id': player_id}).execute()

    return jsonify({'id': team_id, 'name': body['name']}), 201

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
    body = request.json
    game_res = supabase.table('game').insert({
        'date_played': body.get('date') or None,
        'description': body.get('description', ''),
        'team1_score': 0,
        'team2_score': 0
    }).execute()
    game_id = game_res.data[0]['game_id']

    supabase.table('team_game').insert(
        {'game_id': game_id, 'team_id': body['team1_id']}).execute()
    supabase.table('team_game').insert(
        {'game_id': game_id, 'team_id': body['team2_id']}).execute()

    return jsonify({'id': game_id}), 201

# --- RALLIES ---


@app.route('/api/games/<int:game_id>/rallies', methods=['GET'])
def get_rallies(game_id):
    data = supabase.table('rally').select('*, rally_touch(player(f_name, l_name), touch_order)').filter(
        'game_id', 'eq', game_id).order('rally_number').execute()
    return jsonify(data.data)


@app.route('/api/games/<int:game_id>/rallies', methods=['POST'])
def create_rally(game_id):
    body = request.json

    # 1. Get next rally number
    res = supabase.table('rally').select('rally_number').filter(
        'game_id', 'eq', game_id).order('rally_number', desc=True).limit(1).execute()
    next_num = 1
    if res.data:
        next_num = res.data[0]['rally_number'] + 1

    # 2. Insert Rally
    rally_res = supabase.table('rally').insert({
        'game_id': game_id,
        'winning_team_id': body['winner_team_id'],
        'rally_number': next_num
    }).execute()
    rally_id = rally_res.data[0]['rally_id']

    # 3. Insert Touches
    for touch in body['touches']:
        supabase.table('rally_touch').insert({
            'rally_id': rally_id,
            'player_id': touch['player_id'],
            'touch_order': str(touch['touch_order'])
        }).execute()

    # 4. Update Game Scores
    all_rallies = supabase.table('rally').select(
        'winning_team_id').filter('game_id', 'eq', game_id).execute()

    team_games = supabase.table('team_game').select('team_id').filter(
        'game_id', 'eq', game_id).order('team_id').execute()

    if len(team_games.data) >= 2:
        t1_id = team_games.data[0]['team_id']
        t2_id = team_games.data[1]['team_id']

        t1_score = sum(
            1 for r in all_rallies.data if r['winning_team_id'] == t1_id)
        t2_score = sum(
            1 for r in all_rallies.data if r['winning_team_id'] == t2_id)

        supabase.table('game').update({
            'team1_score': t1_score,
            'team2_score': t2_score
        }).filter('game_id', 'eq', game_id).execute()

    return jsonify({'id': rally_id}), 201


if __name__ == '__main__':
    # Using standard 5000
    app.run(debug=True, port=5000)
