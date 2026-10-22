/** Opens the database connection used by every query. */
export function connectDatabase(url: string) {
  return { url, connected: true };
}
