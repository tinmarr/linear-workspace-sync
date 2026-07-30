import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { IssueSnapshot, MappingRecord, WorkspaceKey } from "./domain.js";

type MappingRow = {
  personal_issue_id: string;
  external_workspace_key: string;
  external_issue_id: string;
  personal_issue_url: string;
  external_issue_url: string;
  active: number;
  conflict: number;
  broken: number;
};

export class SyncState {
  private readonly db: Database.Database;

  public constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  public close(): void {
    this.db.close();
  }

  public isInitialized(): boolean {
    const row = this.db
      .prepare("SELECT value FROM metadata WHERE key = 'initialized'")
      .get() as { value?: string } | undefined;
    return row?.value === "true";
  }

  public lastRunAt(): number | undefined {
    const row = this.db
      .prepare("SELECT value FROM metadata WHERE key = 'last_run_at'")
      .get() as { value?: string } | undefined;
    if (!row?.value) return undefined;
    const value = Number(row.value);
    return Number.isFinite(value) ? value : undefined;
  }

  public markRunCompleted(at = Date.now()): void {
    this.db
      .prepare(
        "INSERT INTO metadata(key, value) VALUES('last_run_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(String(at));
  }

  public markInitialized(): void {
    this.db
      .prepare(
        "INSERT INTO metadata(key, value) VALUES('initialized', 'true') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run();
  }

  public getMapping(
    personalIssueId: string,
    externalWorkspaceKey: WorkspaceKey,
  ): MappingRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT personal_issue_id, external_workspace_key, external_issue_id,
                personal_issue_url, external_issue_url, active, conflict, broken
           FROM mappings
          WHERE personal_issue_id = ? AND external_workspace_key = ?`,
      )
      .get(personalIssueId, externalWorkspaceKey) as MappingRow | undefined;
    return row ? this.mappingFromRow(row) : undefined;
  }

  public findMappingByExternal(
    externalWorkspaceKey: WorkspaceKey,
    externalIssueId: string,
  ): MappingRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT personal_issue_id, external_workspace_key, external_issue_id,
                personal_issue_url, external_issue_url, active, conflict, broken
           FROM mappings
          WHERE external_workspace_key = ? AND external_issue_id = ?`,
      )
      .get(externalWorkspaceKey, externalIssueId) as MappingRow | undefined;
    return row ? this.mappingFromRow(row) : undefined;
  }

  public listMappings(): MappingRecord[] {
    const rows = this.db
      .prepare(
        `SELECT personal_issue_id, external_workspace_key, external_issue_id,
                personal_issue_url, external_issue_url, active, conflict, broken
           FROM mappings
          ORDER BY personal_issue_id, external_workspace_key`,
      )
      .all() as MappingRow[];
    return rows.map((row) => this.mappingFromRow(row));
  }

  public upsertMapping(mapping: MappingRecord): void {
    this.db
      .prepare(
        `INSERT INTO mappings(
          personal_issue_id, external_workspace_key, external_issue_id,
          personal_issue_url, external_issue_url, active, conflict, broken
        ) VALUES (@personalIssueId, @externalWorkspaceKey, @externalIssueId,
          @personalIssueUrl, @externalIssueUrl, @active, @conflict, @broken)
        ON CONFLICT(personal_issue_id, external_workspace_key) DO UPDATE SET
          external_issue_id = excluded.external_issue_id,
          personal_issue_url = excluded.personal_issue_url,
          external_issue_url = excluded.external_issue_url,
          active = excluded.active,
          conflict = excluded.conflict,
          broken = excluded.broken`,
      )
      .run({
        ...mapping,
        active: mapping.active ? 1 : 0,
        conflict: mapping.conflict ? 1 : 0,
        broken: mapping.broken ? 1 : 0,
      });
  }

  public replaceMapping(
    previousPersonalIssueId: string,
    mapping: MappingRecord,
  ): void {
    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `DELETE FROM mappings
            WHERE personal_issue_id = ? AND external_workspace_key = ?`,
        )
        .run(previousPersonalIssueId, mapping.externalWorkspaceKey);
      this.db
        .prepare(
          `DELETE FROM snapshots
            WHERE personal_issue_id = ? AND external_workspace_key = ?`,
        )
        .run(previousPersonalIssueId, mapping.externalWorkspaceKey);
      this.db
        .prepare(
          `DELETE FROM notifications
            WHERE personal_issue_id = ? AND external_workspace_key = ?`,
        )
        .run(previousPersonalIssueId, mapping.externalWorkspaceKey);
      this.upsertMapping(mapping);
    });
    transaction();
  }

  public getSnapshot(
    personalIssueId: string,
    externalWorkspaceKey: WorkspaceKey,
  ): IssueSnapshot | undefined {
    const row = this.db
      .prepare(
        `SELECT value_json FROM snapshots
          WHERE personal_issue_id = ? AND external_workspace_key = ?`,
      )
      .get(personalIssueId, externalWorkspaceKey) as { value_json?: string } | undefined;
    return row?.value_json ? (JSON.parse(row.value_json) as IssueSnapshot) : undefined;
  }

  public putSnapshot(snapshot: IssueSnapshot, externalWorkspaceKey: WorkspaceKey): void {
    this.db
      .prepare(
        `INSERT INTO snapshots(personal_issue_id, external_workspace_key, value_json)
         VALUES (?, ?, ?)
         ON CONFLICT(personal_issue_id, external_workspace_key) DO UPDATE SET
           value_json = excluded.value_json`,
      )
      .run(snapshot.id, externalWorkspaceKey, JSON.stringify(snapshot));
  }

  public clearConflict(
    personalIssueId: string,
    externalWorkspaceKey: WorkspaceKey,
  ): void {
    this.db
      .prepare(
        `UPDATE mappings SET conflict = 0
          WHERE personal_issue_id = ? AND external_workspace_key = ?`,
      )
      .run(personalIssueId, externalWorkspaceKey);
  }

  public setConflict(
    personalIssueId: string,
    externalWorkspaceKey: WorkspaceKey,
  ): void {
    this.db
      .prepare(
        `UPDATE mappings SET conflict = 1
          WHERE personal_issue_id = ? AND external_workspace_key = ?`,
      )
      .run(personalIssueId, externalWorkspaceKey);
  }

  public setBroken(
    personalIssueId: string,
    externalWorkspaceKey: WorkspaceKey,
    broken: boolean,
  ): void {
    this.db
      .prepare(
        `UPDATE mappings SET broken = ?
          WHERE personal_issue_id = ? AND external_workspace_key = ?`,
      )
      .run(broken ? 1 : 0, personalIssueId, externalWorkspaceKey);
  }

  public shouldNotify(
    personalIssueId: string,
    externalWorkspaceKey: WorkspaceKey,
    code: string,
    fingerprint: string,
  ): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO notifications(
          personal_issue_id, external_workspace_key, code, fingerprint
        ) VALUES (?, ?, ?, ?)`,
      )
      .run(personalIssueId, externalWorkspaceKey, code, fingerprint);
    return result.changes > 0;
  }

  public clearNotifications(
    personalIssueId: string,
    externalWorkspaceKey: WorkspaceKey,
    code: string,
  ): void {
    this.db
      .prepare(
        `DELETE FROM notifications
          WHERE personal_issue_id = ? AND external_workspace_key = ? AND code = ?`,
      )
      .run(personalIssueId, externalWorkspaceKey, code);
  }

  public recordFailure(scopeKey: string, issueId: string, message: string): number {
    const result = this.db
      .prepare(
        `INSERT INTO failures(scope_key, issue_id, message, count)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(scope_key, issue_id) DO UPDATE SET
           message = excluded.message,
           count = failures.count + 1,
           updated_at = CURRENT_TIMESTAMP`,
      )
      .run(scopeKey, issueId, message);
    const row = this.db
      .prepare(
        `SELECT count FROM failures WHERE scope_key = ? AND issue_id = ?`,
      )
      .get(scopeKey, issueId) as { count: number } | undefined;
    return row?.count ?? result.changes;
  }

  public clearFailure(scopeKey: string, issueId: string): void {
    this.db
      .prepare(`DELETE FROM failures WHERE scope_key = ? AND issue_id = ?`)
      .run(scopeKey, issueId);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mappings (
        personal_issue_id TEXT NOT NULL,
        external_workspace_key TEXT NOT NULL,
        external_issue_id TEXT NOT NULL,
        personal_issue_url TEXT NOT NULL,
        external_issue_url TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        conflict INTEGER NOT NULL DEFAULT 0,
        broken INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (personal_issue_id, external_workspace_key),
        UNIQUE (external_workspace_key, external_issue_id)
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        personal_issue_id TEXT NOT NULL,
        external_workspace_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        PRIMARY KEY (personal_issue_id, external_workspace_key)
      );

      CREATE TABLE IF NOT EXISTS notifications (
        personal_issue_id TEXT NOT NULL,
        external_workspace_key TEXT NOT NULL,
        code TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (personal_issue_id, external_workspace_key, code, fingerprint)
      );

      CREATE TABLE IF NOT EXISTS failures (
        scope_key TEXT NOT NULL,
        issue_id TEXT NOT NULL,
        message TEXT NOT NULL,
        count INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (scope_key, issue_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS mappings_one_external_per_personal_issue
        ON mappings(personal_issue_id);
    `);
  }

  private mappingFromRow(row: MappingRow): MappingRecord {
    return {
      personalIssueId: row.personal_issue_id,
      externalWorkspaceKey: row.external_workspace_key,
      externalIssueId: row.external_issue_id,
      personalIssueUrl: row.personal_issue_url,
      externalIssueUrl: row.external_issue_url,
      active: row.active === 1,
      conflict: row.conflict === 1,
      broken: row.broken === 1,
    };
  }
}
