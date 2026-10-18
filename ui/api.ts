// Talking to padd serve, and the one-line messages the UI shows when that fails.

/** Identifies this view, so the server's echo of our own writes can be skipped. */
export const clientId = Math.random().toString(36).slice(2, 12);

export async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const init: RequestInit =
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Padd-Client": clientId },
          body: JSON.stringify(body),
        };
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export function enc(...parts: string[]): string {
  return parts.map(encodeURIComponent).join("/");
}

let toastTimer = 0;

export function toast(text: string): void {
  const el = document.querySelector<HTMLElement>(".toast")!;
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 5000);
}

/** Reads browser storage without failing when it is off (private mode, blocked site data). */
export const remember = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // storage is a convenience only
    }
  },
};
