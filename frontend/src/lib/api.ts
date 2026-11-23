const API_BASE =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";

export function getToken() {
  return sessionStorage.getItem("vitality_token");
}

export function saveSession(token: string, member: any) {
  sessionStorage.setItem("vitality_token", token);
  sessionStorage.setItem(
    "vitality_member",
    JSON.stringify(member)
  );

  window.dispatchEvent(new Event("vitality-auth-changed"));
}

export function clearSession() {
  sessionStorage.removeItem("vitality_token");
  sessionStorage.removeItem("vitality_member");

  window.dispatchEvent(new Event("vitality-auth-changed"));
}

export function getMember() {
  const raw = sessionStorage.getItem("vitality_member");

  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function api<T = any>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken();

  const headers = new Headers(options.headers || {});

  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.error || `Request failed (${response.status})`
    );
  }

  return data as T;
}