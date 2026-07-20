import sqlite3
from pathlib import Path
from typing import List, Dict, Any
import time
from src import config

DB_PATH = Path(config.DATA_DIR) / "chat_history.db"

def init_db():
    """Initializes the SQLite database and creates the chat history table."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp REAL NOT NULL
            )
        """)
        cursor.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_session_ts"
            " ON messages (session_id, timestamp)"
        )
        conn.commit()

def save_message(session_id: str, role: str, content: str):
    """Saves a single message to the database."""
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
            (session_id, role, content, time.time())
        )
        conn.commit()

def get_chat_history(session_id: str, limit: int = 50) -> List[Dict[str, Any]]:
    """Retrieves the most recent `limit` messages for a session, oldest first.

    The subquery selects the newest N rows; the outer ORDER BY restores
    chronological order for display. (A plain ASC LIMIT would return the
    oldest N and long conversations would never show recent messages.)
    """
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT role, content, timestamp FROM (
                SELECT id, role, content, timestamp FROM messages
                WHERE session_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?
            ) ORDER BY timestamp ASC, id ASC
            """,
            (session_id, limit)
        )
        rows = cursor.fetchall()
        return [{"role": row["role"], "content": row["content"], "timestamp": row["timestamp"]} for row in rows]
