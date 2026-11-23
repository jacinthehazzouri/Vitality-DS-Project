import { FormEvent, useState } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";

import { ArrowLeft, Dumbbell } from "lucide-react";
import { api, saveSession } from "@/lib/api";
import { toast } from "sonner";

export default function AuthPage() {
  const [params] = useSearchParams();
  const location = useLocation();

  const [mode, setMode] = useState<"login" | "register">(
    location.pathname === "/register" ||
      params.get("mode") === "register"
      ? "register"
      : "login"
  );

  const [busy, setBusy] = useState(false);

  const navigate = useNavigate();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);

    const form = new FormData(e.currentTarget);

    const payload: any = {
      email: String(form.get("email") || ""),
      password: String(form.get("password") || ""),
    };

    if (mode === "register") {
      payload.fullName = String(form.get("fullName") || "");
    }

    try {
      if (mode === "register") {
        await api("/api/auth/register", {
          method: "POST",
          body: JSON.stringify(payload),
        });

        toast.success("Account created. Please log in.");
        setMode("login");
      } else {
        const result = await api<any>("/api/auth/login", {
          method: "POST",
          body: JSON.stringify(payload),
        });

        saveSession(result.token, result.member);

        toast.success(`Welcome, ${result.member.full_name}!`);

        navigate("/account");
      }
    } catch (err: any) {
      toast.error(err.message || "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-background flex items-center justify-center px-5 py-16">
      <div className="w-full max-w-md">
        <Link
          to="/"
          className="inline-flex items-center gap-2 text-muted-foreground hover:text-primary mb-8"
        >
          <ArrowLeft size={16} />
          Back to Vitality
        </Link>

        <div className="bg-card border border-border rounded-2xl p-8 shadow-xl">
          <div className="flex items-center gap-3 mb-6">
            <div className="rounded-xl bg-primary/10 p-3">
              <Dumbbell className="text-primary" />
            </div>

            <div>
              <p className="font-display text-3xl">VITALITY</p>
              <p className="text-sm text-muted-foreground">
                Member portal
              </p>
            </div>
          </div>

          <div className="flex gap-2 p-1 bg-secondary rounded-lg mb-6">
            <button
              onClick={() => setMode("login")}
              className={`flex-1 py-2 rounded-md font-medium ${
                mode === "login" ? "bg-background shadow" : ""
              }`}
            >
              Login
            </button>

            <button
              onClick={() => setMode("register")}
              className={`flex-1 py-2 rounded-md font-medium ${
                mode === "register" ? "bg-background shadow" : ""
              }`}
            >
              Register
            </button>
          </div>

          <h1 className="font-display text-3xl mb-2">
            {mode === "login"
              ? "Welcome back"
              : "Create your account"}
          </h1>

          <p className="text-muted-foreground mb-6">
            {mode === "login"
              ? "Sign in to manage your membership and bookings."
              : "Join Vitality and start your fitness journey."}
          </p>

          <form onSubmit={submit} className="space-y-4">
            {mode === "register" && (
              <label className="block text-sm font-medium">
                Full name
                <input
                  name="fullName"
                  required
                  minLength={2}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-3"
                  placeholder="John Smith"
                />
              </label>
            )}

            <label className="block text-sm font-medium">
              Email
              <input
                name="email"
                type="email"
                required
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-3"
                placeholder="you@example.com"
              />
            </label>

            <label className="block text-sm font-medium">
              Password
              <input
                name="password"
                type="password"
                required
                minLength={8}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-3"
                placeholder="At least 8 characters"
              />
            </label>

            <button
              disabled={busy}
              className="w-full rounded-lg bg-primary text-primary-foreground py-3 font-semibold disabled:opacity-50"
            >
              {busy
                ? "Please wait..."
                : mode === "login"
                  ? "Sign in"
                  : "Create account"}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}