# Roundnet Stat Tracker
A web-based tool for tracking Roundnet (Spikeball) games rally-by-rally. This application allows you to manage teams, create games, and input detailed rally statistics, with automatic score calculation.
(This project was created with the use of Gemini CLI, and cross referenced with Claude Sonnet 4.6 and ChatGPT 5.3 mini)

## Features
- **Team Management:** Create and save teams with two players each.
- **Game Tracking:** Record games between saved teams with custom descriptions and dates.
- **Rally-by-Rally Input:** Tap players in their touch order to record rallies.
- **Live Scoring:** View the current game score updated in real-time as you save rallies.
- **Rally History:** Review the touches and winners for every rally in a game.

## Tech Stack
- **Frontend:** HTML5, Vanilla CSS, JS.
- **Backend:** Python (Flask), Supabase (PostgreSQL).
- **Hosting/DB:** Supabase for database and authentication.

## Project Structure
```text
RoundnetStatTracker/
├── backend/
│   ├── app.py           # Flask server & API routes
│   └── static/          # Frontend assets
│       ├── css/
│       ├── js/
│       └── index.html
├── .env                
├── .gitignore           
└── requirements.txt     
```

## Setup Instructions

1. **Clone the repository:**
   ```bash
   git clone <your-repo-url>
   cd RoundnetStatTracker
   ```

2. **Create a virtual environment:**
   ```bash
   python3 -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   ```

3. **Install dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

4. **Environment Configuration:**
   Create a `.env` file in the root directory with your Supabase credentials:
   ```env
   SUPABASE_URL=your_supabase_url
   SUPABASE_KEY=your_supabase_key
   ```
5. **Database Setup**
   This project requires you to host your own version of this database on a personal Supabase account. This can be done following tutorials online.
   I would love to host this on a domain in the future, but I have not been able to do this at the current moment. 
6. **Run the application:**
   ```bash
   python backend/app.py
   ```
   The application will be available at `http://127.0.0.1:5000`.

## Additional Info

1. I have also included the sqldatabase directly copied from Supabase if you would like to use it to create your own. It is only meant for context and will need some changes to create a replica of the database.
2. Also, if you see some errors in the schema, or have any ideas for changes please reach out. This is an ongoing project and I would love to add features over time.
