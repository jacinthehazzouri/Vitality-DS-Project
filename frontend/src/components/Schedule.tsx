import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { api, getToken } from "@/lib/api";

export default function Schedule() {
  const [sessions, setSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [live, setLive] = useState(false);

  async function load() {
    try {
      const result = await api<any>("/api/sessions");

      setSessions(result.sessions || []);
      setLive(true);
    } catch {
      setLive(false);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function book(sessionId: string) {
    if (!getToken()) {
      toast.error("Please log in before booking a class");
      return;
    }

    setBusy(sessionId);

    try {
      const result = await api<any>("/api/bookings", {
        method: "POST",
        body: JSON.stringify({ sessionId }),
      });

      toast.success(
        `Booking confirmed. Audit: ${
          result.audit_status || "pending"
        }`
      );

      await load();
    } catch (e: any) {
      toast.error(e.message || "Could not book this session");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section id="schedule" className="py-24 bg-secondary">
      <div className="container mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-12"
        >
          <h2 className="font-display text-5xl md:text-7xl gradient-text mb-6">
            CLASS SCHEDULE
          </h2>

          <p className="max-w-2xl mx-auto text-muted-foreground text-lg">
            Choose an upcoming session and reserve your place.
          </p>

          <p className="mt-3 text-xs">
            {loading
              ? "Loading sessions..."
              : live
                ? "● Live schedule from Vitality database"
                : "Unable to reach booking service"}
          </p>
        </motion.div>

        {loading ? (
          <p className="text-center">Loading sessions...</p>
        ) : !live ? (
          <div className="bg-card border rounded-xl p-6 text-center">
            The live schedule is currently unavailable. Please try
            again later.
          </div>
        ) : sessions.length === 0 ? (
          <div className="bg-card border rounded-xl p-8 text-center">
            <p className="font-semibold mb-2">
              No upcoming sessions yet
            </p>

            <p className="text-muted-foreground text-sm">
              The administrator needs to add classes and schedule
              sessions.
            </p>
          </div>
        ) : (
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-5">
            {sessions.map((s) => (
              <article
                key={s.id}
                className="bg-card border border-border rounded-2xl p-6"
              >
                <div className="flex justify-between gap-3">
                  <h3 className="font-display text-2xl">
                    {s.class_name}
                  </h3>

                  <span className="text-xs rounded-full bg-primary/10 text-primary px-3 py-1 h-fit">
                    {s.available_places} places left
                  </span>
                </div>

                <p className="text-muted-foreground text-sm mt-2">
                  Instructor: {s.instructor || "Vitality Team"}
                </p>

                <p className="mt-4 font-medium">
                  {new Date(s.starts_at).toLocaleString()}
                </p>

                <p className="text-xs text-muted-foreground">
                  Ends: {new Date(s.ends_at).toLocaleTimeString()}
                </p>

                <button
                  disabled={
                    busy === s.id ||
                    Number(s.available_places) <= 0
                  }
                  onClick={() => book(s.id)}
                  className="mt-5 w-full rounded-lg bg-primary text-primary-foreground py-3 font-semibold disabled:opacity-50"
                >
                  {busy === s.id
                    ? "Booking..."
                    : Number(s.available_places) <= 0
                      ? "Full"
                      : "Book this class"}
                </button>
              </article>
            ))}
          </div>
        )}

        <div className="text-center mt-8">
          <Link
            to={getToken() ? "/account" : "/login"}
            className="text-primary underline underline-offset-4"
          >
            {getToken()
              ? "View my bookings"
              : "Login to manage your bookings"}
          </Link>
        </div>
      </div>
    </section>
  );
}