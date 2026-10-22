export interface User {
  id: string;
  email: string;
}

export type Session = { user: User; expires: number };
