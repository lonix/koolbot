/**
 * A store and a Discord for the REAL `EventNicknameTags` (#1194, #1228), for the
 * tests that drive it from somewhere else (the live edit, #1240). The event is
 * read from the caller's own in-memory event store, so what the live edit wrote
 * is exactly what the tag logic decides from. Types only are imported from the
 * service: the test file that uses this mocks the modules it needs first.
 */

import type {
  BackupRow,
  MemberView,
  TagDiscord,
  TagEventRow,
  TagStore,
} from "../../src/services/event-nickname-tags.js";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export class MemTagStore implements TagStore {
  rows = new Map<string, BackupRow>();
  constructor(
    private readonly events: () => Iterable<Record<string, unknown>>,
  ) {}

  private find(id: string): TagEventRow | null {
    for (const e of this.events()) {
      if (String(e._id) === id) return clone(e) as TagEventRow;
    }
    return null;
  }
  async readEvent(_g: string, id: string) {
    return this.find(id);
  }
  async readBackup(_g: string, memberId: string) {
    const r = this.rows.get(memberId);
    return r ? { ...r } : null;
  }
  async listBackups() {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
  async listBackupsOfEvent(_g: string, eventId: string) {
    return [...this.rows.values()]
      .filter((r) => r.eventId === eventId)
      .map((r) => ({ ...r }));
  }
  async listTaggedEvents() {
    return [...this.events()]
      .filter(
        (e) =>
          e.state === "active" &&
          e.tagsEnabled === true &&
          e.groupsEnabled === true,
      )
      .map((e) => clone(e) as TagEventRow);
  }
  async claim(_g: string, row: BackupRow) {
    if (this.rows.has(row.memberId)) return "exists" as const;
    this.rows.set(row.memberId, { ...row, confirmedTarget: null });
    return "claimed" as const;
  }
  private current(row: BackupRow): BackupRow | null {
    const cur = this.rows.get(row.memberId);
    return cur && cur.eventId === row.eventId && cur.intended === row.intended
      ? cur
      : null;
  }
  async advance(
    _g: string,
    row: BackupRow,
    intended: string,
    attemptedAt: number,
  ) {
    const cur = this.current(row);
    if (!cur) return false;
    cur.intended = intended;
    if (!cur.owned.includes(intended)) cur.owned.push(intended);
    cur.confirmedTarget = null;
    cur.attemptedAt = attemptedAt;
    cur.mismatches = 0;
    return true;
  }
  async markAttempt(_g: string, row: BackupRow, attemptedAt: number) {
    const cur = this.current(row);
    if (!cur) return false;
    cur.attemptedAt = attemptedAt;
    cur.confirmedTarget = null;
    cur.mismatches = 0;
    return true;
  }
  async noteMismatch(_g: string, row: BackupRow) {
    const cur = this.current(row);
    if (!cur) return false;
    cur.mismatches += 1;
    return true;
  }
  async confirm(_g: string, row: BackupRow, shown: string | null) {
    const cur = this.current(row);
    if (!cur) return false;
    cur.confirmedTarget = row.intended;
    if (shown && !cur.owned.includes(shown)) cur.owned.push(shown);
    return true;
  }
  async drop(_g: string, row: BackupRow) {
    if (!this.current(row)) return false;
    this.rows.delete(row.memberId);
    return true;
  }
}

export interface FakeMember {
  nickname: string | null;
  displayName: string;
}

export class FakeTagDiscord implements TagDiscord {
  members = new Map<string, FakeMember>();
  /** Every nickname edit, in order. */
  edits: Array<{ userId: string; nickname: string | null }> = [];
  /** The next edit of these users is applied, then fails (the answer was lost). */
  loseNext = new Set<string>();
  async fetchMember(_g: string, userId: string): Promise<MemberView | "gone"> {
    const m = this.members.get(userId);
    if (!m) return "gone";
    return {
      nickname: m.nickname,
      displayName: m.displayName,
      isOwner: false,
      manageable: true,
    };
  }
  async canManageNicknames() {
    return true;
  }
  async setNickname(_g: string, userId: string, nickname: string | null) {
    const m = this.members.get(userId);
    if (!m) throw Object.assign(new Error("Unknown Member"), { code: 10007 });
    m.nickname = nickname;
    this.edits.push({ userId, nickname });
    if (this.loseNext.delete(userId)) {
      throw new Error("the response was lost");
    }
    return nickname;
  }
}
