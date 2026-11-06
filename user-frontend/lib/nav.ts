// A full page load (not a client-side transition): after login / logout the server components must re-read
// the session cookie, and every client-side cache must be dropped.
export const reloadTo = (path: string) => window.location.assign(new URL(path, window.location.origin).toString());
