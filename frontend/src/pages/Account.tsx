import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import {
  api,
  clearSession,
  getMember,
  getToken,
} from "@/lib/api";

import { toast } from "sonner";

export default function Account() {
  const [member, setMember] = useState<any>(getMember());
  const [membership, setMembership] = useState<any>(null);
  const [bookings, setBookings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const navigate = useNavigate();

  useEffect(() => {
    if (!getToken()) {
      navigate("/login");
      return;
    }

    Promise.all([
      api<any>("/api/auth/me"),
      api<any>(
        `/api/members/${getMember()?.id}/membership`
      ).catch(() => null),
      api<any>("/api/bookings/me"),
    ])
      .then(([me, m, b]) => {
        setMember(me.member);
        setMembership(m?.membership ? { ...m.membership, is_active: m.is_active } : null);
        setBookings(b.bookings || []);
      })
      .catch((e) => toast.error(e.message))
      .finally(() => setLoading(false));
  }, [navigate]);

  async function cancel(id: string) {
    try {
      await api(`/api/bookings/${id}`, {
        method: "DELETE",
      });

      toast.success("Booking cancelled");

      setBookings((old) =>
        old.map((b) =>
          b.id === id ? { ...b, status: "CANCELLED" } : b
        )
      );
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  function logout() {
    clearSession();
    navigate("/");
    toast.success("Signed out");
  }

  return (
    <main className="min-h-screen bg-background py-12">
      <div className="container mx-auto px-6 max-w-5xl">
        <div className="flex justify-between items-center mb-10">
          <div>
            <Link to="/" className="text-primary text-sm">
              ← Vitality home
            </Link>

            {member?.role === "ADMIN" && <Link className="ml-4 text-primary underline" to="/admin">Admin panel</Link>}
            <h1 className="font-display text-5xl mt-3">
              MY ACCOUNT
            </h1>
          </div>

          <button
            onClick={logout}
            className="border rounded-lg px-4 py-2"
          >
            Logout
          </button>
        </div>

        {loading ? (
          <p>Loading your account...</p>
        ) : (
          <>
            <section className="bg-card border rounded-2xl p-6 mb-6">
              <p className="text-muted-foreground text-sm">
                Welcome back
              </p>

              <h2 className="font-display text-3xl">
                {member?.full_name}
              </h2>

              <p className="text-muted-foreground">
                {member?.email}
              </p>

              <span className="inline-block mt-3 rounded-full bg-primary/10 text-primary px-3 py-1 text-xs">
                {member?.role}
              </span>
            </section>

            <div className="grid md:grid-cols-2 gap-6 mb-8">
              <section className="bg-card border rounded-2xl p-6">
                <h3 className="font-display text-2xl mb-3">
                  MEMBERSHIP
                </h3>

                {membership ? (
                  <>
                    <p>{membership.membership_type}</p>

                    <p className="text-sm text-muted-foreground">
                      Expires:{" "}
                      {new Date(
                        membership.expires_at
                      ).toLocaleDateString()}
                    </p>

                    <span className="inline-block mt-3 text-sm font-semibold">
                      {membership.status === 'CANCELLED' ? 'CANCELLED'
                        : new Date(membership.expires_at) < new Date() ? 'EXPIRED'
                        : new Date(membership.starts_at) > new Date() ? 'SCHEDULED'
                        : membership.is_active ? 'ACTIVE' : 'INACTIVE'}
                    </span>
                  </>
                ) : (
                  <p className="text-muted-foreground">
                    No membership found. Please contact the gym
                    administrator.
                  </p>
                )}
              </section>

              <section className="bg-card border rounded-2xl p-6">
                <h3 className="font-display text-2xl mb-3">
                  BOOK A CLASS
                </h3>

                <p className="text-muted-foreground mb-4">
                  Explore available sessions and reserve your place.
                </p>

                <Link
                  to="/#schedule"
                  className="inline-block bg-primary text-primary-foreground rounded-lg px-4 py-2"
                >
                  View schedule
                </Link>
              </section>
            </div>

            <section className="bg-card border rounded-2xl p-6">
              <h3 className="font-display text-2xl mb-4">
                MY BOOKINGS
              </h3>

              {bookings.length === 0 ? (
                <p className="text-muted-foreground">
                  You have no bookings yet.
                </p>
              ) : (
                <div className="space-y-3">
                  {bookings.map((b) => (
                    <div
                      key={b.id}
                      className="flex flex-wrap items-center justify-between gap-3 border-b pb-3"
                    >
                      <div>
                        <p className="font-semibold">
                          {b.class_name}
                        </p>

                        <p className="text-sm text-muted-foreground">
                          {new Date(
                            b.starts_at
                          ).toLocaleString()}
                        </p>

                        <p className="text-xs">{b.status}</p>
                      </div>

                      {b.status === "CONFIRMED" && (
                        <button
                          onClick={() => cancel(b.id)}
                          className="border border-destructive text-destructive rounded-lg px-3 py-2 text-sm"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}