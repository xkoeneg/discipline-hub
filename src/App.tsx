import { Capacitor, SystemBars, SystemBarsStyle } from "@capacitor/core";
import { Check, Moon, Pencil, Plus, RotateCcw, Settings2, Sun, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Task = { id: string; text: string };
type Routine = { title: string; time: string; items: Task[] };
// A group while it is being edited in a dialog; `pending` is text typed in "add a task" but not added yet.
type DraftGroup = Routine & { pending: string };
// Changes that apply to today only, layered on top of the challenge-wide routines.
type TodayEdits = { removed: Set<string>; renamed: Record<string, string>; added: Record<number, Task[]> };
type DayState = "complete" | "failed" | "rechecked" | "today" | "upcoming";

const mkTasks = (prefix: string, texts: string[]): Task[] => texts.map((text, i) => ({ id: `${prefix}-${i}`, text }));

const defaultRoutines: Routine[] = [
  { title: "Morning Routine", time: "05:00–09:00", items: mkTasks("morning", ["Hydration & mineral intake", "10 minute meditation", "Deep work: session I"]) },
  { title: "Active / Trading Focus", time: "09:00–17:00", items: mkTasks("focus", ["Pre-market liquidity analysis", "Execute only A-grade setups", "Log every trade"]) },
  { title: "Night Routine", time: "20:00–22:00", items: mkTasks("night", ["Review daily performance", "Prepare tomorrow's priorities", "Digital blackout by 22:00"]) },
];

const MAX_DAYS = 100;

const newId = () => `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const emptyEdits = (): TodayEdits => ({ removed: new Set(), renamed: {}, added: {} });
// Challenge days are counted from the start date, using local calendar dates.
const parseKey = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
};
const dayNumberOn = (startKey: string, key: string) => Math.round((parseKey(key).getTime() - parseKey(startKey).getTime()) / 86400000) + 1;
// Today's checklist = the challenge routines + today's own edits.
const applyTodayEdits = (routines: Routine[], edits: TodayEdits): Routine[] =>
  routines.map((routine, ri) => ({
    ...routine,
    items: [
      ...routine.items.filter((t) => !edits.removed.has(t.id)).map((t) => ({ ...t, text: edits.renamed[t.id] ?? t.text })),
      ...(edits.added[ri] ?? []),
    ],
  }));
const parseEdits = (e: unknown): TodayEdits => {
  const edits = emptyEdits();
  if (!e || typeof e !== "object") return edits;
  const o = e as { removed?: unknown; renamed?: unknown; added?: unknown };
  if (Array.isArray(o.removed)) edits.removed = new Set(o.removed.filter((x): x is string => typeof x === "string"));
  if (o.renamed && typeof o.renamed === "object") edits.renamed = o.renamed as Record<string, string>;
  if (o.added && typeof o.added === "object") edits.added = o.added as Record<number, Task[]>;
  return edits;
};
const toDraft = (routines: Routine[]): DraftGroup[] => routines.map((r) => ({ ...r, items: r.items.map((t) => ({ ...t })), pending: "" }));
// Folds any text left in the "add a task" box into the group's items.
const withPending = (g: DraftGroup): Task[] => (g.pending.trim() ? [...g.items, { id: newId(), text: g.pending.trim() }] : g.items);

// ---- Saving on the device (localStorage) -------------------------------------------------
const STORAGE_KEY = "discipline-hub:v2";
const localDateKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const isTask = (t: unknown): t is Task => !!t && typeof (t as Task).id === "string" && typeof (t as Task).text === "string";
const isRoutines = (r: unknown): r is Routine[] =>
  Array.isArray(r) && r.length > 0 && r.every((g) => g && typeof g.title === "string" && typeof g.time === "string" && Array.isArray(g.items) && g.items.every(isTask));

type SavedState = {
  dark: boolean;
  routines: Routine[];
  recheckTokens: number;
  startDate: string | null; // null = no challenge yet
  lastSettled: number; // days 1..lastSettled are final (complete / failed / re-checked)
  failedDays: Set<number>;
  recheckedDays: Set<number>;
  committedDay: number | null;
  checked: Set<string>;
  todayEdits: TodayEdits;
};

// Reads what was saved on this device. Runs once, before the first render, so there is no flash of default data.
function loadSaved(): SavedState {
  const state: SavedState = {
    dark: true,
    routines: defaultRoutines,
    recheckTokens: 3,
    startDate: null,
    lastSettled: 0,
    failedDays: new Set(),
    recheckedDays: new Set(),
    committedDay: null,
    checked: new Set(),
    todayEdits: emptyEdits(),
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return state;
    const saved = JSON.parse(raw);
    if (typeof saved.dark === "boolean") state.dark = saved.dark;
    if (isRoutines(saved.routines)) state.routines = saved.routines;
    if (typeof saved.recheckTokens === "number") state.recheckTokens = saved.recheckTokens;
    if (typeof saved.startDate === "string") state.startDate = saved.startDate;
    if (typeof saved.lastSettled === "number") state.lastSettled = saved.lastSettled;
    if (Array.isArray(saved.failedDays)) state.failedDays = new Set(saved.failedDays);
    if (Array.isArray(saved.recheckedDays)) state.recheckedDays = new Set(saved.recheckedDays);
    if (typeof saved.committedDay === "number") state.committedDay = saved.committedDay;

    const savedChecked = new Set<string>(Array.isArray(saved.checked) ? saved.checked : []);
    const savedEdits = parseEdits(saved.todayEdits);
    const todayKey = localDateKey();

    // Close out every day that has ended since the app was last open.
    if (state.startDate) {
      const upTo = Math.min(dayNumberOn(state.startDate, todayKey) - 1, MAX_DAYS);
      if (upTo > state.lastSettled) {
        // Only the day the saved checklist belongs to can have been completed; days the app was never opened are failed.
        const savedDay = typeof saved.date === "string" ? dayNumberOn(state.startDate, saved.date) : -1;
        const items = applyTodayEdits(state.routines, savedEdits).flatMap((g) => g.items);
        const allDone = items.length > 0 && items.every((t) => savedChecked.has(t.id));
        for (let d = state.lastSettled + 1; d <= upTo; d++) {
          if (!(d === savedDay && allDone)) state.failedDays.add(d);
        }
        state.lastSettled = upTo;
      }
    }

    // Checks and "Edit today" changes only belong to the day they were made on.
    if (saved.date === todayKey) {
      state.checked = savedChecked;
      state.todayEdits = savedEdits;
    }
  } catch {
    // Corrupt or unavailable storage: just start from the defaults.
  }
  return state;
}

function dayDate(startDate: string, day: number) {
  const d = parseKey(startDate);
  d.setDate(d.getDate() + day - 1);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

export default function App() {
  const [saved] = useState(loadSaved);
  const [dark, setDark] = useState(saved.dark);
  const [checked, setChecked] = useState(saved.checked);
  const [routines, setRoutines] = useState<Routine[]>(saved.routines); // challenge-wide (Configure)
  const [todayEdits, setTodayEdits] = useState<TodayEdits>(saved.todayEdits); // today only (Edit)
  const [configOpen, setConfigOpen] = useState(false);
  const [configDraft, setConfigDraft] = useState<DraftGroup[]>(() => toDraft(defaultRoutines));
  const [editOpen, setEditOpen] = useState(false);
  const [editDraft, setEditDraft] = useState<DraftGroup[]>(() => toDraft(defaultRoutines));
  const [startDate, setStartDate] = useState(saved.startDate);
  const [lastSettled, setLastSettled] = useState(saved.lastSettled);
  const [committedDay, setCommittedDay] = useState(saved.committedDay);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [failedDays, setFailedDays] = useState(saved.failedDays);
  const [recheckedDays, setRecheckedDays] = useState(saved.recheckedDays);
  const [recheckTokens, setRecheckTokens] = useState(saved.recheckTokens);
  const [tokensDraft, setTokensDraft] = useState(String(saved.recheckTokens));
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  const [dateKey] = useState(localDateKey); // the calendar date today's checklist belongs to
  const active = startDate !== null;
  const rawDay = startDate ? dayNumberOn(startDate, dateKey) : 0;
  const finished = active && rawDay > MAX_DAYS;
  const today = Math.min(Math.max(rawDay, 1), MAX_DAYS);

  const getDayState = (day: number): DayState => {
    if (!finished && day === today) return committedToday ? "complete" : "today";
    if (!finished && day > today) return "upcoming";
    if (failedDays.has(day)) return "failed";
    if (recheckedDays.has(day)) return "rechecked";
    return "complete";
  };

  const applyRecheck = (day: number) => {
    if (recheckTokens <= 0) return;
    setFailedDays((c) => { const n = new Set(c); n.delete(day); return n; });
    setRecheckedDays((c) => new Set(c).add(day));
    setRecheckTokens((t) => t - 1);
  };

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          dark,
          routines,
          recheckTokens,
          failedDays: [...failedDays],
          recheckedDays: [...recheckedDays],
          date: dateKey,
          startDate,
          lastSettled,
          committedDay,
          checked: [...checked],
          todayEdits: { removed: [...todayEdits.removed], renamed: todayEdits.renamed, added: todayEdits.added },
        }),
      );
    } catch {
      // Storage full or blocked: the app keeps working, it just won't remember.
    }
  }, [dark, routines, recheckTokens, failedDays, recheckedDays, checked, todayEdits, dateKey, startDate, lastSettled, committedDay]);

  // An installed app is usually resumed, not reloaded. When the date changes, reload so the finished day is
  // closed out (complete / failed) and a fresh checklist starts. Everything is already saved by then.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && localDateKey() !== dateKey) window.location.reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [dateKey]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    // On the phone, match the status/navigation bar icons to the theme.
    if (Capacitor.isNativePlatform()) {
      SystemBars.setStyle({ style: dark ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch(() => {});
    }
  }, [dark]);

  const todayRoutines = useMemo<Routine[]>(() => applyTodayEdits(routines, todayEdits), [routines, todayEdits]);
  const total = todayRoutines.reduce((sum, routine) => sum + routine.items.length, 0);
  const done = todayRoutines.reduce((sum, routine) => sum + routine.items.filter((t) => checked.has(t.id)).length, 0);
  const allDone = total > 0 && done === total;
  // Committing is only valid while every task is still ticked.
  const committedToday = active && !finished && committedDay === today && allDone;
  const completedCount = lastSettled - failedDays.size + (committedToday ? 1 : 0);
  const selectedState = selectedDay ? getDayState(selectedDay) : null;
  const isTodayView = selectedDay !== null && !finished && selectedDay === today;

  const toggleItem = (id: string) => {
    setChecked((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const startChallenge = () => {
    setStartDate(localDateKey());
    setLastSettled(0);
    setFailedDays(new Set());
    setRecheckedDays(new Set());
    setCommittedDay(null);
    setChecked(new Set());
    setTodayEdits(emptyEdits());
  };

  // Back to a clean slate (theme is kept).
  const deleteChallenge = () => {
    setStartDate(null);
    setLastSettled(0);
    setFailedDays(new Set());
    setRecheckedDays(new Set());
    setCommittedDay(null);
    setChecked(new Set());
    setTodayEdits(emptyEdits());
    setRoutines(defaultRoutines);
    setRecheckTokens(3);
    setSelectedDay(null);
    setDeleteOpen(false);
  };

  // Configure = the challenge-wide template (applies to every day).
  const openConfig = () => {
    setConfigDraft(toDraft(routines));
    setTokensDraft(String(recheckTokens));
    setConfigOpen(true);
  };

  const saveConfig = () => {
    const changedIds: string[] = [];
    const next: Routine[] = configDraft.map((group, ri) => {
      const prev = routines[ri] ?? group;
      const items: Task[] = [];
      withPending(group).forEach((item) => {
        const before = prev.items.find((t) => t.id === item.id);
        const text = item.text.trim() || before?.text || "";
        if (!text) return;
        if (before && before.text !== text) changedIds.push(item.id);
        items.push({ id: item.id, text });
      });
      return { title: group.title.trim() || prev.title, time: group.time.trim() || prev.time, items };
    });
    setRoutines(next);
    // A task renamed for the whole challenge shouldn't keep a stale "today only" name.
    if (changedIds.length) {
      setTodayEdits((e) => {
        const renamed = { ...e.renamed };
        changedIds.forEach((id) => delete renamed[id]);
        return { ...e, renamed };
      });
    }
    const n = parseInt(tokensDraft, 10);
    if (!Number.isNaN(n) && n >= 0) setRecheckTokens(Math.min(n, 99));
    setConfigOpen(false);
  };

  // Edit = today's tasks only. Challenge routines stay untouched.
  const openEdit = () => {
    setEditDraft(toDraft(todayRoutines));
    setEditOpen(true);
  };

  const resetEditDraft = () => setEditDraft(toDraft(routines));

  const saveEdit = () => {
    const next = emptyEdits();
    editDraft.forEach((group, ri) => {
      const base = routines[ri]?.items ?? [];
      const kept = new Set<string>();
      const extras: Task[] = [];
      withPending(group).forEach((item) => {
        const text = item.text.trim();
        const baseItem = base.find((t) => t.id === item.id);
        if (baseItem) {
          kept.add(baseItem.id);
          const current = todayRoutines[ri]?.items.find((t) => t.id === item.id)?.text ?? baseItem.text;
          const finalText = text || current;
          if (finalText !== baseItem.text) next.renamed[baseItem.id] = finalText;
        } else if (text) {
          extras.push({ id: item.id, text });
        }
      });
      base.forEach((t) => { if (!kept.has(t.id)) next.removed.add(t.id); });
      if (extras.length) next.added[ri] = extras;
    });
    setTodayEdits(next);
    setEditOpen(false);
  };

  return (
    <main className="min-h-screen bg-background pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] text-foreground transition-colors duration-300">
      <div className="mx-auto max-w-md space-y-8 px-5 pb-14 pt-7 sm:px-6 sm:pt-10">
        <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
          <div className="min-w-0 space-y-1">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-primary">Life Discipline Hub</p>
            <h1 className="truncate text-xl font-semibold leading-tight">Vanguard Protocol</h1>
            <p className="text-xs text-muted-foreground">{!active ? "No active challenge" : finished ? "Challenge complete" : `Active challenge · Day ${today} of ${MAX_DAYS}`}</p>
          </div>
          <Button variant="secondary" size="icon" className="shrink-0" onClick={() => setDark((value) => !value)} aria-label={`Switch to ${dark ? "light" : "dark"} mode`} title={`Switch to ${dark ? "light" : "dark"} mode`}>
            {dark ? <Sun className="size-4" aria-hidden="true" /> : <Moon className="size-4" aria-hidden="true" />}
          </Button>
        </header>

        {!active && (
          <section aria-label="No active challenge" className="space-y-4 rounded-lg border border-dashed border-border bg-card p-6 text-center">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">No active challenge</p>
            <h2 className="text-lg font-semibold">Ready when you are</h2>
            <p className="text-sm text-muted-foreground">Start a {MAX_DAYS}-day challenge. Day 1 begins today, and your checklist resets every morning.</p>
            <div className="space-y-2 pt-2">
              <Button className="h-12 w-full font-mono text-xs font-semibold uppercase tracking-wider" onClick={startChallenge}>
                Start {MAX_DAYS}-day challenge
              </Button>
              <Button variant="secondary" size="sm" className="h-8 w-full gap-1.5 font-mono text-[10px] uppercase tracking-wider" onClick={openConfig}>
                <Settings2 className="size-3.5" aria-hidden="true" />
                Configure tasks first
              </Button>
            </div>
          </section>
        )}

        {active && (<>
        <section aria-label="Challenge statistics" className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-border bg-border">
          <Stat label="Completed" value={String(completedCount).padStart(2, "0")} suffix="days" />
          <Stat label="Failed" value={String(failedDays.size).padStart(2, "0")} tone="danger" />
          <Stat label="Re-checks" value={String(recheckTokens).padStart(2, "0")} suffix="left" tone="primary" />
        </section>

        <section className="space-y-4" aria-labelledby="timeline-title">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-4">
            <div className="min-w-0">
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">100-day challenge</p>
              <h2 id="timeline-title" className="mt-1 text-sm font-semibold uppercase tracking-widest">Timeline log</h2>
            </div>
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{finished ? 100 : Math.round(((today - 1) / MAX_DAYS) * 100)}% elapsed</span>
          </div>

          <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
            <div className="grid grid-cols-10 gap-1.5" aria-label="Days 1 through 100">
              {Array.from({ length: 100 }, (_, index) => {
                const day = index + 1;
                const state = getDayState(day);
                const stateClass: Record<DayState, string> = {
                  complete: "bg-success text-success-foreground border-success",
                  failed: "bg-destructive text-destructive-foreground border-destructive",
                  rechecked: "bg-recheck text-recheck-foreground border-recheck",
                  today: "bg-accent text-accent-foreground border-primary ring-2 ring-primary/25",
                  upcoming: "bg-transparent text-muted-foreground border-border border-dashed",
                };
                return (
                  <button type="button" key={day} data-day-cell onClick={() => setSelectedDay(day)} title={`Day ${day}: ${state}`} aria-label={`Day ${day}, ${state}`} className={`grid cursor-pointer aspect-square select-none place-items-center rounded-sm border font-mono text-[7px] transition-transform hover:scale-110 ${stateClass[state]}`}>
                    {day}
                  </button>
                );
              })}
            </div>
            <div className="mt-4 flex flex-wrap gap-x-3 gap-y-2">
              <Legend color="bg-success" label="Complete" />
              <Legend color="bg-destructive" label="Failed" />
              <Legend color="bg-recheck" label="Re-checked" />
              <Legend color="bg-accent ring-1 ring-primary" label="Today" />
              <Legend color="border border-dashed border-border" label="Upcoming" />
            </div>
          </div>
        </section>

        {finished ? (
          <section className="space-y-3 rounded-lg border border-border bg-card p-5 text-center">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-primary">Challenge complete</p>
            <p className="text-sm text-muted-foreground">{completedCount} days completed, {failedDays.size} failed. Delete this challenge when you're ready to start a new one.</p>
            <Button variant="outline" className="w-full gap-2 border-destructive/50 text-destructive hover:border-destructive hover:text-destructive" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="size-4" aria-hidden="true" />
              Delete challenge
            </Button>
          </section>
        ) : (<>
        <section className="space-y-5" aria-labelledby="checklist-title">
          <div className="space-y-3">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-4">
              <div className="min-w-0">
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Today's protocol</p>
                <h2 id="checklist-title" className="mt-1 text-sm font-semibold uppercase tracking-widest">Daily checklist</h2>
              </div>
              <span className="shrink-0 font-mono text-[10px] text-primary">{done}/{total} complete</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" size="sm" className="h-8 gap-1.5 font-mono text-[10px] uppercase tracking-wider" onClick={openEdit}>
                <Pencil className="size-3.5" aria-hidden="true" />
                Edit today
              </Button>
              <Button variant="secondary" size="sm" className="h-8 gap-1.5 font-mono text-[10px] uppercase tracking-wider" onClick={openConfig}>
                <Settings2 className="size-3.5" aria-hidden="true" />
                Configure
              </Button>
            </div>
          </div>

          {todayRoutines.map((routine, routineIndex) => (
            <article key={routineIndex} className="space-y-3">
              <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
                <span className="rounded bg-secondary px-2 py-1 font-mono text-[9px] text-muted-foreground">{routine.time}</span>
                <h3 className="truncate text-xs font-semibold uppercase tracking-wider">{routine.title}</h3>
              </div>
              <div className="overflow-hidden rounded-lg border border-border bg-card">
                {routine.items.length === 0 && <p className="px-3.5 py-3 text-sm text-muted-foreground">No tasks in this group.</p>}
                {routine.items.map((item) => {
                  const isChecked = checked.has(item.id);
                  return (
                    <label key={item.id} className="grid min-h-12 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-border px-3.5 py-3 last:border-b-0 hover:bg-secondary/60">
                      <span className={`min-w-0 text-sm transition-colors ${isChecked ? "text-muted-foreground line-through" : "text-card-foreground"}`}>{item.text}</span>
                      <input className="sr-only" type="checkbox" checked={isChecked} onChange={() => toggleItem(item.id)} />
                      <span aria-hidden="true" className={`grid size-6 shrink-0 place-items-center rounded-sm border transition-all ${isChecked ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background"}`}>
                        {isChecked && <Check className="size-4" strokeWidth={2.5} />}
                      </span>
                    </label>
                  );
                })}
              </div>
            </article>
          ))}
        </section>

        <div className="space-y-2">
          <Button className="h-12 w-full gap-2 font-mono text-xs font-semibold uppercase tracking-wider" disabled={!allDone || committedToday} onClick={() => setCommittedDay(today)}>
            {committedToday ? <Check className="size-4" aria-hidden="true" /> : <RotateCcw className="size-4" aria-hidden="true" />}
            {committedToday ? "Today's entry committed" : "Commit today's entry"}
          </Button>
          {!allDone && <p className="text-center text-xs text-muted-foreground">Finish every task to commit today.</p>}
        </div>
        </>)}
        </>)}
      </div>

      <Dialog open={configOpen} onOpenChange={setConfigOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Configure checklist</DialogTitle>
            <DialogDescription>Set up groups, time windows and tasks for the whole challenge. Changes apply to every day.</DialogDescription>
          </DialogHeader>
          <div className="max-h-[min(60vh,calc(100dvh-17rem))] space-y-5 overflow-y-auto pr-1">
            {configDraft.map((group, index) => (
              <div key={index} className={cn("space-y-2", index > 0 && "border-t border-border pt-5")}>
                <Label htmlFor={`cfg-title-${index}`} className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Group {index + 1}
                </Label>
                <Input
                  id={`cfg-title-${index}`}
                  value={group.title}
                  onChange={(event) => setConfigDraft((current) => current.map((g, i) => (i === index ? { ...g, title: event.target.value } : g)))}
                  placeholder="Group name"
                />
                <Input
                  id={`cfg-time-${index}`}
                  value={group.time}
                  onChange={(event) => setConfigDraft((current) => current.map((g, i) => (i === index ? { ...g, time: event.target.value } : g)))}
                  placeholder="Time window, e.g. 05:00–09:00"
                  aria-label={`Time window for group ${index + 1}`}
                />
                <p className="pt-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Tasks</p>
                <TaskEditor group={group} onChange={(g) => setConfigDraft((current) => current.map((x, i) => (i === index ? g : x)))} placeholder="Add a task to every day…" />
              </div>
            ))}
            <div className="space-y-2 border-t border-border pt-5">
              <Label htmlFor="cfg-tokens" className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Re-check tokens</Label>
              <Input id="cfg-tokens" type="number" inputMode="numeric" min={0} max={99} value={tokensDraft} onChange={(e) => setTokensDraft(e.target.value)} />
              <p className="text-xs text-muted-foreground">Use a token to fix a failed day you actually completed.</p>
            </div>
            {active && (
              <div className="space-y-2 border-t border-border pt-5">
                <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Danger zone</p>
                <Button
                  variant="outline"
                  className="w-full gap-2 border-destructive/50 text-destructive hover:border-destructive hover:text-destructive"
                  onClick={() => {
                    setConfigOpen(false);
                    setDeleteOpen(true);
                  }}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  Delete challenge
                </Button>
                <p className="text-xs text-muted-foreground">Erases all progress, tasks and tokens and takes you back to the start.</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfigOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveConfig}>Save changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-sm" onOpenAutoFocus={(event) => event.preventDefault()}>
          <DialogHeader>
            <DialogTitle>Edit today's tasks</DialogTitle>
            <DialogDescription>Day {today} only. Tasks added, renamed or removed here won't touch other days — use Configure for that.</DialogDescription>
          </DialogHeader>
          <div className="max-h-[min(60vh,calc(100dvh-17rem))] space-y-5 overflow-y-auto pr-1">
            {editDraft.map((group, index) => (
              <div key={index} className="space-y-2">
                <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  {group.title} · {group.time}
                </p>
                <TaskEditor group={group} onChange={(g) => setEditDraft((current) => current.map((x, i) => (i === index ? g : x)))} placeholder="Add a task for today only…" />
              </div>
            ))}
            <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground" onClick={resetEditDraft}>
              <RotateCcw className="size-3.5" aria-hidden="true" />
              Reset to challenge tasks
            </Button>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveEdit}>Save changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete challenge?</DialogTitle>
            <DialogDescription>This erases your progress, every day on the timeline, your tasks and your re-check tokens. You can't undo this.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={deleteChallenge}>
              Delete challenge
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={selectedDay !== null} onOpenChange={(o) => !o && setSelectedDay(null)}>
        <DialogContent className="max-w-sm">
          {selectedDay !== null && selectedState && (
            <>
              <DialogHeader>
                <DialogTitle>Day {selectedDay}</DialogTitle>
                <DialogDescription>{startDate ? dayDate(startDate, selectedDay) : ""} · <span className="capitalize">{selectedState === "rechecked" ? "Re-checked" : selectedState}</span></DialogDescription>
              </DialogHeader>
              <div className="max-h-[50vh] space-y-4 overflow-y-auto">
                {(isTodayView ? todayRoutines : routines).map((routine, ri) => (
                  <div key={ri} className="space-y-1.5">
                    <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{routine.title} · {routine.time}</p>
                    <ul className="overflow-hidden rounded-md border border-border">
                      {routine.items.map((item) => {
                        const ok = isTodayView ? checked.has(item.id) : selectedState === "complete" || selectedState === "rechecked";
                        return (
                          <li key={item.id} className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 text-sm last:border-b-0">
                            <span className={ok ? "text-muted-foreground line-through" : ""}>{item.text}</span>
                            {selectedState !== "upcoming" && (ok ? <Check className="size-4 shrink-0 text-success" /> : <X className="size-4 shrink-0 text-destructive" />)}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
              {selectedState === "failed" && (
                <DialogFooter className="flex-col gap-2 sm:flex-col">
                  <Button onClick={() => applyRecheck(selectedDay)} disabled={recheckTokens <= 0} className="w-full gap-2">
                    <RotateCcw className="size-4" aria-hidden="true" />
                    Use re-check ({recheckTokens} left)
                  </Button>
                  {recheckTokens <= 0 && <p className="text-center text-xs text-muted-foreground">No re-checks left. Add more in Configure.</p>}
                </DialogFooter>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </main>
  );
}

function TaskEditor({ group, onChange, placeholder }: { group: DraftGroup; onChange: (group: DraftGroup) => void; placeholder: string }) {
  const add = () => {
    const text = group.pending.trim();
    if (!text) return;
    onChange({ ...group, items: [...group.items, { id: newId(), text }], pending: "" });
  };
  return (
    <div className="space-y-2">
      {group.items.map((item, i) => (
        <div key={item.id} className="flex items-center gap-2">
          <Input value={item.text} onChange={(event) => onChange({ ...group, items: group.items.map((t) => (t.id === item.id ? { ...t, text: event.target.value } : t)) })} aria-label={`Task ${i + 1} in ${group.title}`} />
          <Button variant="ghost" size="icon" className="size-8 shrink-0 text-destructive hover:text-destructive" onClick={() => onChange({ ...group, items: group.items.filter((t) => t.id !== item.id) })} aria-label={`Delete ${item.text}`}>
            <Trash2 className="size-4" aria-hidden="true" />
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Input
          value={group.pending}
          onChange={(event) => onChange({ ...group, pending: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter") add();
          }}
          placeholder={placeholder}
          aria-label={`New task in ${group.title}`}
        />
        <Button variant="secondary" size="icon" className="size-8 shrink-0" onClick={add} disabled={!group.pending.trim()} aria-label={`Add task to ${group.title}`}>
          <Plus className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

function Stat({ label, value, suffix, tone = "default" }: { label: string; value: string; suffix?: string; tone?: "default" | "danger" | "primary" }) {
  const color = tone === "danger" ? "text-destructive" : tone === "primary" ? "text-primary" : "text-foreground";
  return (
    <div className="min-w-0 bg-card p-3.5">
      <span className="block truncate font-mono text-[9px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <div className="mt-1 flex items-baseline gap-1">
        <span className={`text-xl font-semibold ${color}`}>{value}</span>
        {suffix && <span className="text-[9px] text-muted-foreground">{suffix}</span>}
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return <span className="flex items-center gap-1.5 font-mono text-[8px] uppercase text-muted-foreground"><i className={`size-2 rounded-sm ${color}`} />{label}</span>;
}
