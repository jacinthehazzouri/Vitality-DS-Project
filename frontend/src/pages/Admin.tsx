import { FormEvent, ReactNode, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, getToken } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Member = {
  id: string; full_name: string; email: string; is_active: boolean;
  membership: { membership_type: string; status: string; starts_at: string; expires_at: string } | null;
};
type GymClass = { id: string; name: string; description: string | null; category: string | null; is_active: boolean };
type Session = { id: string; class_name: string; starts_at: string; capacity: number; cancelled_at: string | null };
type Booking = { id: string; member_id: string; status: string };
type Block = { event_id: string; event_type: string; index: number; hash: string };
type Tab = "Members" | "Classes and sessions" | "Bookings" | "Audit";
const tabs: Tab[] = ["Members", "Classes and sessions", "Bookings", "Audit"];
const selectStyle = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
const sectionStyle = "space-y-4 rounded-lg border border-border bg-card p-5";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block space-y-1.5 text-sm font-medium"><span>{label}</span>{children}</label>;
}

function formatDate(date: string) {
  return new Date(date).toLocaleString();
}

function membershipLabel(member: Member) {
  const membership = member.membership;
  if (!membership) return "No membership";
  if (membership.status === "CANCELLED") return "Revoked";
  const now = Date.now();
  if (Date.parse(membership.expires_at) < now) return "Expired";
  if (Date.parse(membership.starts_at) > now) return "Scheduled";
  return member.is_active ? membership.membership_type.toLowerCase() + " · active" : "Account inactive";
}

export default function Admin() {
  const [admin, setAdmin] = useState<{ id: string; full_name: string } | null>(null);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState<Tab>("Members");
  const [members, setMembers] = useState<Member[]>([]);
  const [classes, setClasses] = useState<GymClass[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<GymClass | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [ledger, setLedger] = useState<"loading" | "available" | "unavailable">("loading");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [people, schedule] = await Promise.all([
      api<{ members: Member[] }>("/api/admin/members"),
      api<{ classes: GymClass[]; sessions: Session[] }>("/api/admin/booking/schedule"),
    ]);
    setMembers(people.members);
    setClasses(schedule.classes);
    setSessions(schedule.sessions);
  }, []);

  const loadBookings = useCallback(async (id: string) => {
    if (!id) { setBookings([]); return; }
    const data = await api<{ bookings: Booking[] }>(`/api/admin/booking/sessions/${id}/bookings`);
    setBookings(data.bookings);
  }, []);

  useEffect(() => {
    if (!getToken()) { setChecking(false); return; }
    let active = true;
    api<{ member: { id: string; full_name: string; role: string } }>("/api/auth/me")
      .then(({ member }) => {
        if (!active) return;
        if (member.role === "ADMIN") {
          setAdmin(member);
          setEvents(JSON.parse(sessionStorage.getItem(`vitality-admin-events:${member.id}`) || "[]"));
        }
      })
      .catch((failure) => { if (active) setError(failure.message); })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (admin) refresh().catch((failure) => setError(failure.message));
  }, [admin, refresh]);

  useEffect(() => {
    let current = true;
    setBookings([]);
    if (sessionId) {
      api<{ bookings: Booking[] }>(`/api/admin/booking/sessions/${sessionId}/bookings`)
        .then(({ bookings }) => { if (current) setBookings(bookings); })
        .catch((failure) => { if (current) setError(failure.message); });
    }
    return () => { current = false; };
  }, [sessionId]);

  useEffect(() => {
    if (tab !== "Audit" || !admin) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const result = await api<{ valid: boolean; blocks: Block[] }>("/api/blockchain/chain",
          { signal: AbortSignal.timeout(8000) });
        if (!result.valid || !Array.isArray(result.blocks)) throw new Error("Invalid ledger response");
        if (active) { setBlocks(result.blocks); setLedger("available"); }
      } catch {
        if (active) setLedger("unavailable");
      } finally {
        if (active) timer = setTimeout(check, 2500);
      }
    };
    setLedger("loading");
    void check();
    return () => { active = false; clearTimeout(timer); };
  }, [admin, tab]);

  async function change(path: string, method: string, body?: Record<string, unknown>, form?: HTMLFormElement) {
    if (!admin || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ event_id?: string }>(path, {
        method,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
      if (result.event_id) {
        const recent = [result.event_id, ...events].slice(0, 30);
        setEvents(recent);
        sessionStorage.setItem(`vitality-admin-events:${admin.id}`, JSON.stringify(recent));
      }
      form?.reset();
      setNotice("Change saved." + (result.event_id ? ` Audit event ${result.event_id}` : ""));
      if (path.startsWith("/api/admin/booking/classes/") && method === "PATCH") setEditing(null);
      await Promise.all([refresh(), loadBookings(sessionId)]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Request failed");
    } finally { setBusy(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>, action: (data: FormData, form: HTMLFormElement) => void) {
    event.preventDefault();
    action(new FormData(event.currentTarget), event.currentTarget);
  }

  if (checking) return <main className="p-8">Checking administrator access…</main>;
  if (!admin) return <main className="space-y-3 p-8">
    <h1 className="text-2xl font-semibold">Administrator access required</h1>
    {error && <p role="alert">{error}</p>}
    <Link className="text-primary underline" to={getToken() ? "/account" : "/login"}>{getToken() ? "My account" : "Log in"}</Link>
  </main>;

  const memberById = new Map(members.map((member) => [member.id, member]));
  const session = sessions.find((item) => item.id === sessionId);
  const shownMembers = members.filter((member) => `${member.full_name} ${member.email}`.toLowerCase().includes(search.trim().toLowerCase()));
  const byId = new Map(blocks.map((block) => [block.event_id, block]));

  return <main className="mx-auto max-w-6xl space-y-6 px-5 py-8">
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div><h1 className="text-3xl font-bold">Vitality admin</h1><p className="text-sm text-muted-foreground">{admin.full_name}</p></div>
      <Link className="text-sm text-primary underline" to="/account">My account</Link>
    </header>
    <nav aria-label="Admin sections" className="flex flex-wrap gap-2">
      {tabs.map((item) => <Button key={item} variant={tab === item ? "default" : "outline"}
        aria-pressed={tab === item} disabled={busy} onClick={() => { setTab(item); setError(""); }}>{item}</Button>)}
    </nav>
    {error && <p role="alert" className="rounded border border-destructive p-3 text-sm">{error}</p>}
    {notice && <p role="status" className="break-words rounded border p-3 text-sm">{notice}</p>}

    {tab === "Members" && <div className="grid gap-5 md:grid-cols-[1fr_2fr]">
      <form className={sectionStyle} onSubmit={(event) => submit(event, (data, form) => {
        void change("/api/admin/members", "POST", Object.fromEntries(data), form);
      })}>
        <h2 className="text-xl font-semibold">Create member</h2>
        <Field label="Full name"><Input name="fullName" required maxLength={160} /></Field>
        <Field label="Email"><Input name="email" type="email" required maxLength={255} /></Field>
        <Field label="Initial password"><Input name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={72} /></Field>
        <Button disabled={busy}>Create member</Button>
      </form>
      <section className={sectionStyle}>
        <Field label="Search members"><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name or email" /></Field>
        {shownMembers.length === 0 && <p>No members found.</p>}
        {shownMembers.map((member) => <article key={member.id} className="space-y-3 border-t border-border pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div><h3 className="font-semibold">{member.full_name}</h3><p className="break-all text-sm text-muted-foreground">{member.email}</p></div>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => {
              if (member.is_active && !window.confirm(`Deactivate ${member.full_name}?`)) return;
              void change(`/api/admin/members/${member.id}/status`, "PATCH", { active: !member.is_active });
            }}>{member.is_active ? "Deactivate" : "Reactivate"}</Button>
          </div>
          <p className="text-sm">Membership: {membershipLabel(member)}</p>
          <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => submit(event, (data) => {
            const start = new Date();
            const end = new Date(start);
            end.setUTCDate(end.getUTCDate() + Number(data.get("days")));
            void change(`/api/members/${member.id}/membership`, "POST", {
              membershipType: data.get("type"), startsAt: start.toISOString(), expiresAt: end.toISOString(),
            });
          })}>
            <Field label="Plan"><select name="type" className={selectStyle} onChange={(event) => {
              const days = event.currentTarget.form?.elements.namedItem("days") as HTMLInputElement | null;
              if (days) days.value = ({ MONTHLY: "30", QUARTERLY: "90", ANNUAL: "365" })[event.target.value];
            }}><option>MONTHLY</option><option>QUARTERLY</option><option>ANNUAL</option></select></Field>
            <Field label="Days"><Input name="days" type="number" min={1} max={3650} defaultValue={30} required className="w-24" /></Field>
            <Button size="sm" disabled={busy || !member.is_active}>Grant / renew</Button>
            <Button type="button" size="sm" variant="outline" disabled={busy || member.membership?.status !== "ACTIVE"} onClick={() => {
              if (window.confirm(`Revoke membership for ${member.full_name}?`)) void change(`/api/members/${member.id}/membership`, "DELETE");
            }}>Revoke</Button>
          </form>
        </article>)}
      </section>
    </div>}

    {tab === "Classes and sessions" && <div className="grid gap-5 md:grid-cols-2">
      <section className={sectionStyle}>
        <form key={editing?.id || "new"} className="space-y-3" onSubmit={(event) => submit(event, (data, form) => {
          void change(editing ? `/api/admin/booking/classes/${editing.id}` : "/api/classes",
            editing ? "PATCH" : "POST", Object.fromEntries(data), form);
        })}>
          <h2 className="text-xl font-semibold">{editing ? "Edit class" : "Create class"}</h2>
          <Field label="Name"><Input name="name" required maxLength={120} defaultValue={editing?.name} /></Field>
          <Field label="Category"><Input name="category" maxLength={80} defaultValue={editing?.category || ""} /></Field>
          <Field label="Description"><Input name="description" defaultValue={editing?.description || ""} /></Field>
          <div className="flex gap-2"><Button disabled={busy}>{editing ? "Save changes" : "Create class"}</Button>
            {editing && <Button type="button" variant="outline" onClick={() => setEditing(null)}>Cancel edit</Button>}</div>
        </form>
        {classes.map((item) => <article key={item.id} className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <span>{item.name}{item.is_active ? "" : " · archived"}</span>
          {item.is_active && <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing(item)} disabled={busy}>Edit</Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => {
              if (window.confirm(`Archive ${item.name}?`)) void change(`/api/admin/booking/classes/${item.id}`, "DELETE");
            }}>Archive</Button>
          </div>}
        </article>)}
      </section>
      <section className={sectionStyle}>
        <form className="space-y-3" onSubmit={(event) => submit(event, (data, form) => {
          void change("/api/sessions", "POST", { classId: data.get("classId"), instructor: data.get("instructor"),
            startsAt: new Date(String(data.get("start"))).toISOString(),
            endsAt: new Date(String(data.get("end"))).toISOString(), capacity: Number(data.get("capacity")) }, form);
        })}>
          <h2 className="text-xl font-semibold">Schedule a session</h2>
          <Field label="Class"><select name="classId" className={selectStyle} required>
            <option value="">Choose a class</option>
            {classes.filter((item) => item.is_active).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></Field>
          <Field label="Instructor"><Input name="instructor" maxLength={160} /></Field>
          <Field label="Starts"><Input name="start" type="datetime-local" required /></Field>
          <Field label="Ends"><Input name="end" type="datetime-local" required /></Field>
          <Field label="Capacity"><Input name="capacity" type="number" min={1} defaultValue={1} required /></Field>
          <Button disabled={busy || !classes.some((item) => item.is_active)}>Schedule session</Button>
        </form>
        {sessions.map((item) => <article key={item.id} className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <div><strong>{item.class_name}</strong><p className="text-sm text-muted-foreground">{formatDate(item.starts_at)} · {item.cancelled_at ? "Cancelled" : `Capacity ${item.capacity}`}</p></div>
          {!item.cancelled_at && Date.parse(item.starts_at) > Date.now() && <Button variant="outline" size="sm" disabled={busy} onClick={() => {
            if (window.confirm("Cancel this session and all its confirmed bookings?")) void change(`/api/admin/booking/sessions/${item.id}`, "DELETE");
          }}>Cancel session</Button>}
        </article>)}
      </section>
    </div>}

    {tab === "Bookings" && <section className={sectionStyle}>
      <h2 className="text-xl font-semibold">Session roster</h2>
      <Field label="Session"><select className={selectStyle} value={sessionId} disabled={busy} onChange={(event) => setSessionId(event.target.value)}>
        <option value="">Choose a session</option>
        {sessions.map((item) => <option key={item.id} value={item.id}>{item.class_name} · {formatDate(item.starts_at)}{item.cancelled_at ? " · cancelled" : ""}</option>)}
      </select></Field>
      {session && <>
        {!session.cancelled_at && Date.parse(session.starts_at) > Date.now() && <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => submit(event, (data, form) => {
          void change("/api/bookings", "POST", { sessionId, memberId: data.get("memberId") }, form);
        })}>
          <Field label="Book for member"><select className={selectStyle} name="memberId" required>
            <option value="">Choose a member</option>
            {members.filter((member) => member.is_active).map((member) => <option key={member.id} value={member.id}>{member.full_name} · {member.email}</option>)}
          </select></Field>
          <Button disabled={busy}>Book seat</Button>
        </form>}
        {bookings.length === 0 && <p>No bookings for this session.</p>}
        {bookings.map((booking) => <article key={booking.id} className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <span>{memberById.get(booking.member_id)?.full_name || booking.member_id} · {booking.status.toLowerCase()}</span>
          {booking.status === "CONFIRMED" && <Button variant="outline" size="sm" disabled={busy} onClick={() => {
            if (window.confirm("Cancel this member’s booking?")) void change(`/api/bookings/${booking.id}`, "DELETE");
          }}>Cancel booking</Button>}
        </article>)}
      </>}
    </section>}

    {tab === "Audit" && <section className={sectionStyle}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold">Audit trail</h2>
        <a className="text-sm text-primary underline" href="http://localhost:15672/" target="_blank" rel="noreferrer">Open RabbitMQ</a>
      </div>
      {ledger === "unavailable" && <p role="status">The blockchain ledger is unavailable. Recent events will be checked again automatically.</p>}
      {ledger === "loading" && <p>Checking the ledger…</p>}
      {events.map((id) => {
        const block = byId.get(id);
        return <div className="break-all border-t pt-3 text-sm" key={id}>
          <p className="font-semibold">{block ? `Verified · block ${block.index} · ${block.event_type}` : "Awaiting verification"}</p>
          <p>Event {id}</p>{block && <p>Hash {block.hash}</p>}
        </div>;
      })}
      <h3 className="font-semibold">Recent confirmed blocks</h3>
      {blocks.filter((block) => block.index > 0).slice(-10).reverse().map((block) => <div className="break-all border-t pt-3 text-sm" key={block.event_id}>
        <p>Block {block.index} · {block.event_type}</p><p className="text-muted-foreground">{block.event_id}</p>
      </div>)}
      {ledger === "available" && blocks.length <= 1 && <p>No audit events have been recorded yet.</p>}
    </section>}
  </main>;
}
