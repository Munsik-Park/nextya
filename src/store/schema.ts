import type Database from 'better-sqlite3';

/**
 * SQLite 스키마를 초기화한다.
 * 애플리케이션 시작 시 1회 호출.
 */
export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT DEFAULT '',
      state TEXT NOT NULL DEFAULT 'open',
      labels TEXT DEFAULT '[]',
      created_at TEXT,
      updated_at TEXT,
      closed_at TEXT,
      last_analyzed_at TEXT,
      UNIQUE(repo, number)
    );

    CREATE TABLE IF NOT EXISTS dependencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      depends_on_number INTEGER NOT NULL,
      confidence REAL DEFAULT 1.0,
      reason TEXT DEFAULT '',
      source TEXT DEFAULT 'llm',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(repo, issue_number, depends_on_number)
    );

    CREATE TABLE IF NOT EXISTS analysis_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      trigger TEXT NOT NULL,
      issue_number INTEGER,
      status TEXT NOT NULL,
      deps_found INTEGER DEFAULT 0,
      error TEXT,
      duration_ms INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_issues_repo_state ON issues(repo, state);
    CREATE INDEX IF NOT EXISTS idx_deps_repo_issue ON dependencies(repo, issue_number);
    CREATE INDEX IF NOT EXISTS idx_deps_repo_depends_on ON dependencies(repo, depends_on_number);
  `);

  console.info('[store] schema ready');
}
