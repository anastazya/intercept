"""
SQLite database utilities for persistent settings storage.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any
from werkzeug.security import generate_password_hash
from config import ADMIN_USERNAME, ADMIN_PASSWORD

logger = logging.getLogger('intercept.database')

# Database file location
DB_DIR = Path(__file__).parent.parent / 'instance'
DB_PATH = DB_DIR / 'intercept.db'

# Thread-local storage for connections
_local = threading.local()


def get_db_path() -> Path:
    """Get the database file path, creating directory if needed."""
    DB_DIR.mkdir(parents=True, exist_ok=True)
    return DB_PATH


def get_connection() -> sqlite3.Connection:
    """Get a thread-local database connection."""
    if not hasattr(_local, 'connection') or _local.connection is None:
        db_path = get_db_path()
        _local.connection = sqlite3.connect(str(db_path), check_same_thread=False)
        _local.connection.row_factory = sqlite3.Row
        # Enable foreign keys
        _local.connection.execute('PRAGMA foreign_keys = ON')
    return _local.connection


@contextmanager
def get_db():
    """Context manager for database operations."""
    conn = get_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def init_db() -> None:
    """Initialize the database schema."""
    db_path = get_db_path()
    logger.info(f"Initializing database at {db_path}")

    with get_db() as conn:
        # Settings table for key-value storage
        conn.execute('''
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                value_type TEXT DEFAULT 'string',
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')

        # Signal history table for graphs
        conn.execute('''
            CREATE TABLE IF NOT EXISTS signal_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mode TEXT NOT NULL,
                device_id TEXT NOT NULL,
                signal_strength REAL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                metadata TEXT
            )
        ''')

        # Create index for faster queries
        conn.execute('''
            CREATE INDEX IF NOT EXISTS idx_signal_history_mode_device
            ON signal_history(mode, device_id, timestamp)
        ''')

        # Device correlation table
        conn.execute('''
            CREATE TABLE IF NOT EXISTS device_correlations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                wifi_mac TEXT,
                bt_mac TEXT,
                confidence REAL,
                first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                metadata TEXT,
                UNIQUE(wifi_mac, bt_mac)
            )
        ''')

        # Users table for authentication
        conn.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')

        cursor = conn.execute('SELECT COUNT(*) FROM users')
        if cursor.fetchone()[0] == 0:
            from config import ADMIN_USERNAME, ADMIN_PASSWORD
            
            logger.info(f"Creating default admin user: {ADMIN_USERNAME}")
            
            # Password hashing
            hashed_pw = generate_password_hash(ADMIN_PASSWORD)
            
            conn.execute('''
                INSERT INTO users (username, password_hash, role)
                VALUES (?, ?, ?)
            ''', (ADMIN_USERNAME, hashed_pw, 'admin'))

        logger.info("Database initialized successfully")


def close_db() -> None:
    """Close the thread-local database connection."""
    if hasattr(_local, 'connection') and _local.connection is not None:
        _local.connection.close()
        _local.connection = None


# =============================================================================
# Settings Functions
# =============================================================================

def get_setting(key: str, default: Any = None) -> Any:
    """
    Get a setting value by key.

    Args:
        key: Setting key
        default: Default value if not found

    Returns:
        Setting value (auto-converted from JSON for complex types)
    """
    with get_db() as conn:
        cursor = conn.execute(
            'SELECT value, value_type FROM settings WHERE key = ?',
            (key,)
        )
        row = cursor.fetchone()

        if row is None:
            return default

        value, value_type = row['value'], row['value_type']

        # Convert based on type
        if value_type == 'json':
            try:
                return json.loads(value)
            except json.JSONDecodeError:
                return default
        elif value_type == 'int':
            return int(value)
        elif value_type == 'float':
            return float(value)
        elif value_type == 'bool':
            return value.lower() in ('true', '1', 'yes')
        else:
            return value


def set_setting(key: str, value: Any) -> None:
    """
    Set a setting value.

    Args:
        key: Setting key
        value: Setting value (will be JSON-encoded for complex types)
    """
    # Determine value type and string representation
    if isinstance(value, bool):
        value_type = 'bool'
        str_value = 'true' if value else 'false'
    elif isinstance(value, int):
        value_type = 'int'
        str_value = str(value)
    elif isinstance(value, float):
        value_type = 'float'
        str_value = str(value)
    elif isinstance(value, (dict, list)):
        value_type = 'json'
        str_value = json.dumps(value)
    else:
        value_type = 'string'
        str_value = str(value)

    with get_db() as conn:
        conn.execute('''
            INSERT INTO settings (key, value, value_type, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                value_type = excluded.value_type,
                updated_at = CURRENT_TIMESTAMP
        ''', (key, str_value, value_type))


def delete_setting(key: str) -> bool:
    """
    Delete a setting.

    Args:
        key: Setting key

    Returns:
        True if setting was deleted, False if not found
    """
    with get_db() as conn:
        cursor = conn.execute('DELETE FROM settings WHERE key = ?', (key,))
        return cursor.rowcount > 0


def get_all_settings() -> dict[str, Any]:
    """Get all settings as a dictionary."""
    with get_db() as conn:
        cursor = conn.execute('SELECT key, value, value_type FROM settings')
        settings = {}

        for row in cursor:
            key, value, value_type = row['key'], row['value'], row['value_type']

            if value_type == 'json':
                try:
                    settings[key] = json.loads(value)
                except json.JSONDecodeError:
                    settings[key] = value
            elif value_type == 'int':
                settings[key] = int(value)
            elif value_type == 'float':
                settings[key] = float(value)
            elif value_type == 'bool':
                settings[key] = value.lower() in ('true', '1', 'yes')
            else:
                settings[key] = value

        return settings


# =============================================================================
# Signal History Functions
# =============================================================================

def add_signal_reading(
    mode: str,
    device_id: str,
    signal_strength: float,
    metadata: dict | None = None
) -> None:
    """Add a signal strength reading."""
    with get_db() as conn:
        conn.execute('''
            INSERT INTO signal_history (mode, device_id, signal_strength, metadata)
            VALUES (?, ?, ?, ?)
        ''', (mode, device_id, signal_strength, json.dumps(metadata) if metadata else None))


def get_signal_history(
    mode: str,
    device_id: str,
    limit: int = 100,
    since_minutes: int = 60
) -> list[dict]:
    """
    Get signal history for a device.

    Args:
        mode: Mode (wifi, bluetooth, adsb, etc.)
        device_id: Device identifier (MAC, ICAO, etc.)
        limit: Maximum number of readings
        since_minutes: Only get readings from last N minutes

    Returns:
        List of signal readings with timestamp
    """
    with get_db() as conn:
        cursor = conn.execute('''
            SELECT signal_strength, timestamp, metadata
            FROM signal_history
            WHERE mode = ? AND device_id = ?
              AND timestamp > datetime('now', ?)
            ORDER BY timestamp DESC
            LIMIT ?
        ''', (mode, device_id, f'-{since_minutes} minutes', limit))

        results = []
        for row in cursor:
            results.append({
                'signal': row['signal_strength'],
                'timestamp': row['timestamp'],
                'metadata': json.loads(row['metadata']) if row['metadata'] else None
            })

        return list(reversed(results))  # Return in chronological order


def cleanup_old_signal_history(max_age_hours: int = 24) -> int:
    """
    Remove old signal history entries.

    Args:
        max_age_hours: Maximum age in hours

    Returns:
        Number of deleted entries
    """
    with get_db() as conn:
        cursor = conn.execute('''
            DELETE FROM signal_history
            WHERE timestamp < datetime('now', ?)
        ''', (f'-{max_age_hours} hours',))
        return cursor.rowcount


# =============================================================================
# Device Correlation Functions
# =============================================================================

def add_correlation(
    wifi_mac: str,
    bt_mac: str,
    confidence: float,
    metadata: dict | None = None
) -> None:
    """Add or update a device correlation."""
    with get_db() as conn:
        conn.execute('''
            INSERT INTO device_correlations (wifi_mac, bt_mac, confidence, metadata, last_seen)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(wifi_mac, bt_mac) DO UPDATE SET
                confidence = excluded.confidence,
                last_seen = CURRENT_TIMESTAMP,
                metadata = excluded.metadata
        ''', (wifi_mac, bt_mac, confidence, json.dumps(metadata) if metadata else None))


def get_correlations(min_confidence: float = 0.5) -> list[dict]:
    """Get all device correlations above minimum confidence."""
    with get_db() as conn:
        cursor = conn.execute('''
            SELECT wifi_mac, bt_mac, confidence, first_seen, last_seen, metadata
            FROM device_correlations
            WHERE confidence >= ?
            ORDER BY confidence DESC
        ''', (min_confidence,))

        results = []
        for row in cursor:
            results.append({
                'wifi_mac': row['wifi_mac'],
                'bt_mac': row['bt_mac'],
                'confidence': row['confidence'],
                'first_seen': row['first_seen'],
                'last_seen': row['last_seen'],
                'metadata': json.loads(row['metadata']) if row['metadata'] else None
            })

        return results
