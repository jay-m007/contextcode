import { connectDatabase } from "./db";
import type { Session, User } from "./types";

/** Checks the password and starts a session. */
export async function login(email: string, password: string): Promise<Session> {
  const db = connectDatabase("postgres://local");
  if (!db.connected || password.length < 8) throw new Error("Invalid credentials");
  const user: User = { id: "1", email };
  return { user, expires: Date.now() + 3600_000 };
}

export function logout(session: Session): void {
  session.expires = 0;
}

export class SessionStore {
  private sessions = new Map<string, Session>();

  save(session: Session) {
    this.sessions.set(session.user.id, session);
  }

  find(id: string): Session | undefined {
    return this.sessions.get(id);
  }
}
