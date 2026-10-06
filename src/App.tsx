import { Capacitor, SystemBars, SystemBarsStyle } from "@capacitor/core";
import { Check, Moon, Pencil, Plus, RotateCcw, Settings2, Sun, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Task = { id: string; text: string };
type Routine = { title: string; time: string; items: Task[] };
// A group while it is being edited in a dialog; `pending` is text typed in "add a task" but not added yet.
type DraftGroup = Routine & { pending: string };
type DayState = "complete" | "failed" | "rechecked" | "today" | "upcoming";
type FormMode = "create" | "edit";
type Form = { title: string; days: string; tokens: string; groups: DraftGroup[] };

const MIN_DAYS = 3;
const MAX_DAYS = 365;
const DEFAULT_DAYS = 100;
const DEFAULT_TOKENS = 3;
const MAX_TOKENS = 99;
const DEFAULT_TITLE = "Vanguard Protocol";

const mkTasks = (prefix: string, texts: string[]): Task[] => texts.map((text, i) => ({ id: `${prefix}-${i}`, text }));

const defaultRoutines: Routine[] = [
  { title: "Morning Routine", time: "05:00–09:00", items: mkTasks("morning", ["Hydration & mineral intake", "10 minute meditation", "Deep work: session I"]) },
  { title: "Active / Trading Focus", time: "09:00–17:00", items: mkTasks("focus", ["Pre-market liquidity analysis", "Execute only A-grade setups", "Log every trade"]) },
  { title: "Night Routine", time: "20:00–22:00", items: mkTasks("night", ["Review daily performance", "Prepare tomorrow's priorities", "Digital blackout by 22:00"]) },
];

const newId = () => `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
// Challenge days are counted from the start date, using local calendar dates.
const parseKey = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
};
const dayNumberOn = (startKey: string, key: string) => Math.round((parseKey(key).getTime() - parseKey(startKey).getTime()) / 86400000) + 1;
const toDraft = (routines: Routine[]): DraftGroup[] => routines.map((r) => ({ ...r, items: r.items.map((t) => ({ ...t })), pending: "" }));
// Folds any text left in the "add a task" box into the group's items.
const withPending = (g: DraftGroup): Task[] => (g.pending.trim() ? [...g.items, { id: newId(), text: g.pending.trim() }] : g.items);
const isWholeNumber = (v: string) => /^\d+$/.test(v.trim());

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
  title: string;
  length: number; // number of days in the challenge (3–365)
  routines: Routine[];
  recheckTotal: number; // fixed when the challenge is created; can never be raised
  startDate: string | null; // null = no challenge yet
  lastSettled: number; // days 1..lastSettled are final (complete / failed / re-checked)
  failedDays: Set<number>;
  recheckedDays: Set<number>;
  committedDay: number | null;
  checked: Set<string>;
};

// Reads what was saved on this device. Runs once, before the first render, so there is no flash of default data.
function loadSaved(): SavedState {
  const state: SavedState = {
    dark: true,
    title: DEFAULT_TITLE,
    length: DEFAULT_DAYS,
    routines: defaultRoutines,
    recheckTotal: DEFAULT_TOKENS,
    startDate: null,
    lastSettled: 0,
    failedDays: new Set(),
    recheckedDays: new Set(),
    committedDay: null,
    checked: new Set(),
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return state;
    const saved = JSON.parse(raw);
    if (typeof saved.dark === "boolean") state.dark = saved.dark;
    if (typeof saved.title === "string" && saved.title.trim()) state.title = saved.title.trim();
    if (Number.isInteger(saved.length)) state.length = Math.min(MAX_DAYS, Math.max(MIN_DAYS, saved.length));
    if (isRoutines(saved.routines)) state.routines = saved.routines;
    if (typeof saved.startDate === "string") state.startDate = saved.startDate;
    if (typeof saved.lastSettled === "number") state.lastSettled = saved.lastSettled;
    if (Array.isArray(saved.failedDays)) state.failedDays = new Set(saved.failedDays);
    if (Array.isArray(saved.recheckedDays)) state.recheckedDays = new Set(saved.recheckedDays);
    if (typeof saved.committedDay === "number") state.committedDay = saved.committedDay;
    // Older saves only stored the re-checks left, so the total is "left + already used".
    if (typeof saved.recheckTotal === "number") state.recheckTotal = saved.recheckTotal;
    else if (typeof saved.recheckTokens === "number") state.recheckTotal = saved.recheckTokens + state.recheckedDays.size;

    const savedChecked = new Set<string>(Array.isArray(saved.checked) ? saved.checked : []);
    const todayKey = localDateKey();

    // Close out every day that has ended since the app was last open.
    if (state.startDate) {
      const upTo = Math.min(dayNumberOn(state.startDate, todayKey) - 1, state.length);
      if (upTo > state.lastSettled) {
        // Only the day the saved checklist belongs to can have been completed; days the app was never opened are failed.
        const savedDay = typeof saved.date === "string" ? dayNumberOn(state.startDate, saved.date) : -1;
        const items = state.routines.flatMap((g) => g.items);
        const allDone = items.length > 0 && items.every((t) => savedChecked.has(t.id));
        for (let d = state.lastSettled + 1; d <= upTo; d++) {
          if (!(d === savedDay && allDone)) state.failedDays.add(d);
        }
        state.lastSettled = upTo;
      }
    }

    // Checks only belong to the day they were made on.
    if (saved.date === todayKey) state.checked = savedChecked;
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

// ---- Timeline grid: boxes never get smaller than MIN_BOX (so they stay easy to tap) and every row always
// fills the whole card. Days are split evenly over the rows; a row with fewer days gets wider boxes, so there are never gaps.
const GRID_GAP = 6;
const MIN_BOX = 36;

function useGridLayout(count: number) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  const w = width || 300;
  const maxCols = Math.max(1, Math.floor((w + GRID_GAP) / (MIN_BOX + GRID_GAP)));
  const rowCount = Math.max(1, Math.ceil(count / maxCols));
  const base = Math.floor(count / rowCount);
  const extra = count % rowCount; // the first `extra` rows hold one more day
  const rows: { start: number; count: number }[] = [];
  let start = 1;
  for (let r = 0; r < rowCount; r++) {
    const n = base + (r < extra ? 1 : 0);
    rows.push({ start, count: n });
    start += n;
  }
  const widest = Math.max(...rows.map((r) => r.count));
  const size = (w - (widest - 1) * GRID_GAP) / widest; // every row has this height
  const font = Math.round(Math.max(9, Math.min(22, size * 0.34)));
  return { setEl, rows, size, font };
}

export default function App() {
  const [saved] = useState(loadSaved);
  const [dark, setDark] = useState(saved.dark);
  const [title, setTitle] = useState(saved.title);
  const [length, setLength] = useState(saved.length);
  const [routines, setRoutines] = useState<Routine[]>(saved.routines);
  const [recheckTotal, setRecheckTotal] = useState(saved.recheckTotal);
  const [startDate, setStartDate] = useState(saved.startDate);
  const [lastSettled, setLastSettled] = useState(saved.lastSettled);
  const [failedDays, setFailedDays] = useState(saved.failedDays);
  const [recheckedDays, setRecheckedDays] = useState(saved.recheckedDays);
  const [committedDay, setCommittedDay] = useState(saved.committedDay);
  const [checked, setChecked] = useState(saved.checked);
  const [formMode, setFormMode] = useState<FormMode | null>(null);
  const [form, setForm] = useState<Form>(() => ({ title: "", days: String(DEFAULT_DAYS), tokens: String(DEFAULT_TOKENS), groups: toDraft(saved.routines) }));
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  const [dateKey] = useState(localDateKey); // the calendar date today's checklist belongs to
  const active = startDate !== null;
  const rawDay = startDate ? dayNumberOn(startDate, dateKey) : 0;
  const finished = active && rawDay > length;
  const today = Math.min(Math.max(rawDay, 1), length);
  const grid = useGridLayout(length);

  const recheckLeft = Math.max(0, recheckTotal - recheckedDays.size);
  const total = routines.reduce((sum, routine) => sum + routine.items.length, 0);
  const done = routines.reduce((sum, routine) => sum + routine.items.filter((t) => checked.has(t.id)).length, 0);
  const allDone = total > 0 && done === total;
  // Committing is only valid while every task is still ticked.
  const committedToday = active && !finished && committedDay === today && allDone;
  const completedCount = lastSettled - failedDays.size + (committedToday ? 1 : 0);

  const getDayState = (day: number): DayState => {
    if (!finished && day === today) return committedToday ? "complete" : "today";
    if (!finished && day > today) return "upcoming";
    if (failedDays.has(day)) return "failed";
    if (recheckedDays.has(day)) return "rechecked";
    return "complete";
  };

  const selectedState = selectedDay ? getDayState(selectedDay) : null;
  const isTodayView = selectedDay !== null && !finished && selectedDay === today;

  // Re-checks are capped by the number chosen when the challenge was created.
  const applyRecheck = (day: number) => {
    if (recheckLeft <= 0) return;
    setFailedDays((c) => { const n = new Set(c); n.delete(day); return n; });
    setRecheckedDays((c) => new Set(c).add(day));
  };

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          dark,
          title,
          length,
          routines,
          recheckTotal,
          failedDays: [...failedDays],
          recheckedDays: [...recheckedDays],
          date: dateKey,
          startDate,
          lastSettled,
          committedDay,
          checked: [...checked],
        }),
      );
    } catch {
      // Storage full or blocked: the app keeps working, it just won't remember.
    }
  }, [dark, title, length, routines, recheckTotal, failedDays, recheckedDays, checked, dateKey, startDate, lastSettled, committedDay]);

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

  const toggleItem = (id: string) => {
    setChecked((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // ---- Configure (new challenge) / Edit challenge --------------------------------------------
  const openCreate = () => {
    setForm({ title: "", days: String(DEFAULT_DAYS), tokens: String(DEFAULT_TOKENS), groups: toDraft(routines) });
    setFormMode("create");
  };

  const openEdit = () => {
    setForm({ title, days: String(length), tokens: String(recheckTotal), groups: toDraft(routines) });
    setFormMode("edit");
  };

  const minDays = formMode === "edit" ? Math.max(MIN_DAYS, today) : MIN_DAYS;
  const daysNum = isWholeNumber(form.days) ? parseInt(form.days, 10) : NaN;
  const daysError =
    Number.isNaN(daysNum) || daysNum < minDays || daysNum > MAX_DAYS
      ? minDays > MIN_DAYS
        ? `Enter ${minDays}–${MAX_DAYS} days (it can't end before today).`
        : `Enter ${MIN_DAYS}–${MAX_DAYS} days.`
      : null;
  const maxTokens = Math.min(MAX_TOKENS, Number.isNaN(daysNum) ? MAX_TOKENS : Math.max(daysNum, 0));
  const tokensNum = isWholeNumber(form.tokens) ? parseInt(form.tokens, 10) : NaN;
  const tokensError = formMode === "create" && (Number.isNaN(tokensNum) || tokensNum > maxTokens) ? `Enter 0–${maxTokens} re-checks.` : null;
  const formInvalid = daysError !== null || tokensError !== null;

  const saveForm = () => {
    if (!formMode || formInvalid) return;
    const nextRoutines: Routine[] = form.groups.map((group, ri) => {
      const prev = routines[ri] ?? group;
      const items: Task[] = [];
      withPending(group).forEach((item) => {
        const text = item.text.trim() || prev.items.find((t) => t.id === item.id)?.text || "";
        if (text) items.push({ id: item.id, text });
      });
      return { title: group.title.trim() || prev.title, time: group.time.trim() || prev.time, items };
    });
    const nextTitle = form.title.trim() || DEFAULT_TITLE;

    setTitle(nextTitle);
    setLength(daysNum);
    setRoutines(nextRoutines);
    if (formMode === "create") {
      setRecheckTotal(tokensNum);
      setStartDate(localDateKey());
      setLastSettled(0);
      setFailedDays(new Set());
      setRecheckedDays(new Set());
      setCommittedDay(null);
      setChecked(new Set());
    }
    setFormMode(null);
  };

  // Back to a clean slate (theme is kept).
  const deleteChallenge = () => {
    setStartDate(null);
    setTitle(DEFAULT_TITLE);
    setLength(DEFAULT_DAYS);
    setRoutines(defaultRoutines);
    setRecheckTotal(DEFAULT_TOKENS);
    setLastSettled(0);
    setFailedDays(new Set());
    setRecheckedDays(new Set());
    setCommittedDay(null);
    setChecked(new Set());
    setSelectedDay(null);
    setDeleteOpen(false);
  };

  const updateGroup = (index: number, patch: Partial<DraftGroup>) =>
    setForm((f) => ({ ...f, groups: f.groups.map((g, i) => (i === index ? { ...g, ...patch } : g)) }));

  return (
    <main className="min-h-screen bg-background pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] text-foreground transition-colors duration-300">
      <div className="mx-auto max-w-md space-y-8 px-5 pb-14 pt-7 sm:px-6 sm:pt-10">
        <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
          <div className="min-w-0 space-y-1">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-primary">Life Discipline Hub</p>
            <h1 className="truncate text-xl font-semibold leading-tight">{title}</h1>
            <p className="text-xs text-muted-foreground">{!active ? "No active challenge" : finished ? "Challenge complete" : `Active challenge · Day ${today} of ${length}`}</p>
          </div>
          <Button variant="secondary" size="icon" className="shrink-0" onClick={() => setDark((value) => !value)} aria-label={`Switch to ${dark ? "light" : "dark"} mode`} title={`Switch to ${dark ? "light" : "dark"} mode`}>
            {dark ? <Sun className="size-4" aria-hidden="true" /> : <Moon className="size-4" aria-hidden="true" />}
          </Button>
        </header>

        {!active && (
          <section aria-label="No active challenge" className="space-y-4 rounded-lg border border-dashed border-border bg-card p-6 text-center">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">No active challenge</p>
            <h2 className="text-lg font-semibold">Ready when you are</h2>
            <p className="text-sm text-muted-foreground">Set up your challenge: a title, how many days ({MIN_DAYS}–{MAX_DAYS}), your re-checks and your daily tasks. Day 1 begins today.</p>
            <div className="pt-2">
              <Button className="h-12 w-full gap-2 font-mono text-xs font-semibold uppercase tracking-wider" onClick={openCreate}>
                <Settings2 className="size-4" aria-hidden="true" />
                Configure new challenge
              </Button>
            </div>
          </section>
        )}

        {active && (
          <>
            <section aria-label="Challenge statistics" className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-border bg-border">
              <Stat label="Completed" value={String(completedCount).padStart(2, "0")} suffix="days" />
              <Stat label="Failed" value={String(failedDays.size).padStart(2, "0")} tone="danger" />
              <Stat label="Re-checks" value={String(recheckLeft).padStart(2, "0")} suffix="left" tone="primary" />
            </section>

            <section className="space-y-4" aria-labelledby="timeline-title">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-4">
                <div className="min-w-0">
                  <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{length}-day challenge</p>
                  <h2 id="timeline-title" className="mt-1 text-sm font-semibold uppercase tracking-widest">Timeline log</h2>
                </div>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{finished ? 100 : Math.round(((today - 1) / length) * 100)}% elapsed</span>
              </div>

              <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
                <div ref={grid.setEl} className="flex flex-col" style={{ gap: GRID_GAP }} aria-label={`Days 1 through ${length}`}>
                  {grid.rows.map((row) => (
                    <div key={row.start} className="flex" style={{ gap: GRID_GAP, height: grid.size }}>
                      {Array.from({ length: row.count }, (_, i) => {
                        const day = row.start + i;
                        const state = getDayState(day);
                        const stateClass: Record<DayState, string> = {
                          complete: "bg-success text-success-foreground border-success",
                          failed: "bg-destructive text-destructive-foreground border-destructive",
                          rechecked: "bg-recheck text-recheck-foreground border-recheck",
                          today: "bg-accent text-accent-foreground border-primary ring-2 ring-primary/25",
                          upcoming: "bg-transparent text-muted-foreground border-border border-dashed",
                        };
                        const isToday = !finished && day === today;
                        return (
                          <button type="button" key={day} data-day-cell onClick={() => setSelectedDay(day)} title={`Day ${day}: ${state}`} aria-label={`Day ${day}, ${state}`} style={{ fontSize: grid.font }} className={cn("grid h-full min-w-0 flex-1 cursor-pointer select-none place-items-center rounded-md border font-mono transition-transform hover:scale-105", stateClass[state], isToday && state === "complete" && "ring-2 ring-primary")}>
                            {day}
                          </button>
                        );
                      })}
                    </div>
                  ))}
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
            ) : (
              <>
                <section className="space-y-5" aria-labelledby="checklist-title">
                  <div className="space-y-3">
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-4">
                      <div className="min-w-0">
                        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Today's protocol</p>
                        <h2 id="checklist-title" className="mt-1 text-sm font-semibold uppercase tracking-widest">Daily checklist</h2>
                      </div>
                      <span className="shrink-0 font-mono text-[10px] text-primary">{done}/{total} complete</span>
                    </div>
                    <Button variant="secondary" size="sm" className="h-8 w-full gap-1.5 font-mono text-[10px] uppercase tracking-wider" onClick={openEdit}>
                      <Pencil className="size-3.5" aria-hidden="true" />
                      Edit challenge
                    </Button>
                  </div>

                  {routines.map((routine, routineIndex) => (
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
              </>
            )}
          </>
        )}
      </div>

      {/* Configure (new challenge) and Edit challenge share one form */}
      <Dialog open={formMode !== null} onOpenChange={(open) => !open && setFormMode(null)}>
        <DialogContent className="max-w-sm" onOpenAutoFocus={(event) => event.preventDefault()}>
          <DialogHeader>
            <DialogTitle>{formMode === "edit" ? "Edit challenge" : "Configure new challenge"}</DialogTitle>
            <DialogDescription>
              {formMode === "edit" ? "Change the title, length and tasks of your challenge." : "Pick a title, length, re-checks and your daily tasks. Day 1 starts today."}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[min(60vh,calc(100dvh-17rem))] space-y-5 overflow-y-auto pr-1">
            <div className="space-y-2">
              <Label htmlFor="f-title" className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Challenge title</Label>
              <Input id="f-title" value={form.title} maxLength={40} placeholder={DEFAULT_TITLE} onChange={(event) => setForm((f) => ({ ...f, title: event.target.value }))} />
            </div>

            <div className={cn("grid gap-3", formMode === "create" ? "grid-cols-2" : "grid-cols-1")}>
              <div className="space-y-2">
                <Label htmlFor="f-days" className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Days ({minDays}–{MAX_DAYS})</Label>
                <Input id="f-days" type="number" inputMode="numeric" min={minDays} max={MAX_DAYS} value={form.days} onChange={(event) => setForm((f) => ({ ...f, days: event.target.value }))} aria-invalid={daysError !== null} />
              </div>
              {formMode === "create" && (
                <div className="space-y-2">
                  <Label htmlFor="f-tokens" className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Re-checks</Label>
                  <Input id="f-tokens" type="number" inputMode="numeric" min={0} max={maxTokens} value={form.tokens} onChange={(event) => setForm((f) => ({ ...f, tokens: event.target.value }))} aria-invalid={tokensError !== null} />
                </div>
              )}
            </div>
            {daysError && <p className="text-xs text-destructive">{daysError}</p>}
            {tokensError && <p className="text-xs text-destructive">{tokensError}</p>}
            {formMode === "create" ? (
              <p className="text-xs text-muted-foreground">A re-check fixes a failed day you really completed. The number you set is the limit for the whole challenge and can't be changed later.</p>
            ) : (
              <div className="rounded-lg border border-border bg-secondary/40 px-3 py-2.5 text-xs text-muted-foreground">
                Re-checks: {recheckedDays.size} of {recheckTotal} used. This number was fixed when the challenge was created and can't be changed.
              </div>
            )}

            {form.groups.map((group, index) => (
              <div key={index} className="space-y-2 border-t border-border pt-5">
                <Label htmlFor={`f-title-${index}`} className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Group {index + 1}
                </Label>
                <Input id={`f-title-${index}`} value={group.title} onChange={(event) => updateGroup(index, { title: event.target.value })} placeholder="Group name" />
                <Input value={group.time} onChange={(event) => updateGroup(index, { time: event.target.value })} placeholder="Time window, e.g. 05:00–09:00" aria-label={`Time window for group ${index + 1}`} />
                <p className="pt-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Tasks</p>
                <TaskEditor group={group} onChange={(g) => updateGroup(index, g)} placeholder="Add a task…" />
              </div>
            ))}

            {formMode === "edit" && (
              <div className="space-y-2 border-t border-border pt-5">
                <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Danger zone</p>
                <Button
                  variant="outline"
                  className="w-full gap-2 border-destructive/50 text-destructive hover:border-destructive hover:text-destructive"
                  onClick={() => {
                    setFormMode(null);
                    setDeleteOpen(true);
                  }}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  Delete challenge
                </Button>
                <p className="text-xs text-muted-foreground">Erases all progress and takes you back to the start.</p>
              </div>
            )}
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="secondary" onClick={() => setFormMode(null)}>
              Cancel
            </Button>
            <Button onClick={saveForm} disabled={formInvalid}>
              {formMode === "edit" ? "Save changes" : "Start challenge"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete challenge?</DialogTitle>
            <DialogDescription>This erases your progress, every day on the timeline, your tasks and your re-checks. You can't undo this.</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
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
                {routines.map((routine, ri) => (
                  <div key={ri} className="space-y-1.5">
                    <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{routine.title} · {routine.time}</p>
                    <ul className="overflow-hidden rounded-lg border border-border">
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
                <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
                  <Button onClick={() => applyRecheck(selectedDay)} disabled={recheckLeft <= 0} className="w-full gap-2">
                    <RotateCcw className="size-4" aria-hidden="true" />
                    Use re-check ({recheckLeft} left)
                  </Button>
                  {recheckLeft <= 0 && <p className="text-center text-xs text-muted-foreground">No re-checks left for this challenge.</p>}
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
