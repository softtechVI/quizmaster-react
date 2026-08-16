import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

type DbQuestion = {
  id: string;
  domain: string | null;
  scenario: string;
  options: Record<string, string> | string[];
  correct_answer: string;
  hint: string | null;
  rationale_correct: string | null;
  rationale_incorrect: string | null;
};

type Question = {
  id: string;
  domain?: string;
  question: string;
  options: string[];
  optionKeys: string[];
  answerIndex: number;
  hint?: string;
  rationaleCorrect?: string;
  rationaleIncorrect?: string;
};

type Phase = "setup" | "test" | "results";

const LS_TIME = "mcq.totalMinutes";
const LS_COUNT = "mcq.qCount";
const LS_HISTORY = "mcq.history"; // { [questionId]: { c: 0|1 } }

type HistoryEntry = { c: 0 | 1 };
type History = Record<string, HistoryEntry>;

function loadHistory(): History {
  try {
    return JSON.parse(localStorage.getItem(LS_HISTORY) || "{}") as History;
  } catch {
    return {};
  }
}
function saveHistory(h: History) {
  localStorage.setItem(LS_HISTORY, JSON.stringify(h));
}

function normalize(row: DbQuestion): Question {
  let optionKeys: string[];
  let optionsArr: string[];
  if (Array.isArray(row.options)) {
    optionsArr = row.options.map(String);
    optionKeys = optionsArr.map((_, i) => String.fromCharCode(65 + i));
  } else {
    optionKeys = Object.keys(row.options);
    optionsArr = optionKeys.map((k) => String((row.options as Record<string, string>)[k]));
  }
  const ans = row.correct_answer;
  let answerIndex = optionKeys.indexOf(ans);
  if (answerIndex === -1) {
    const upper = ans.trim().toUpperCase();
    if (/^[A-Z]$/.test(upper)) answerIndex = upper.charCodeAt(0) - 65;
  }
  if (answerIndex < 0 || answerIndex >= optionsArr.length) answerIndex = 0;
  return {
    id: row.id,
    domain: row.domain ?? undefined,
    question: row.scenario,
    options: optionsArr,
    optionKeys,
    answerIndex,
    hint: row.hint ?? undefined,
    rationaleCorrect: row.rationale_correct ?? undefined,
    rationaleIncorrect: row.rationale_incorrect ?? undefined,
  };
}

function fmt(secs: number) {
  const s = Math.max(0, Math.floor(secs));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function MCQApp() {
  const [phase, setPhase] = useState<Phase>("setup");
  const [minutes, setMinutes] = useState(10);
  const [qCount, setQCount] = useState(10);
  const [available, setAvailable] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [questions, setQuestions] = useState<Question[]>([]);
  const [current, setCurrent] = useState(0);
  // null = unanswered, number = locked selection
  const [answers, setAnswers] = useState<(number | null)[]>([]);
  const [perQTime, setPerQTime] = useState<number[]>([]);
  const [remaining, setRemaining] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [showHint, setShowHint] = useState(false);

  const [globalStats, setGlobalStats] = useState<{ total_correct: number; total_wrong: number } | null>(null);
  const [history, setHistory] = useState<History>({});

  const qStartRef = useRef<number>(0);
  const endAtRef = useRef<number>(0);

  // Load saved prefs + counts + global stats
  useEffect(() => {
    const t = localStorage.getItem(LS_TIME);
    if (t !== null) setMinutes(Number(t) || 0);
    const c = localStorage.getItem(LS_COUNT);
    if (c) setQCount(Math.max(1, Number(c) || 10));
    setHistory(loadHistory());

    (async () => {
      try {
        const { count, error: cErr } = await supabase
          .from("questions")
          .select("id", { count: "planned", head: true });
        if (cErr) throw cErr;
        setAvailable(count ?? 0);
      } catch {
        setError("Couldn't reach the database. Check your connection and retry.");
      }
      try {
        const { data } = await supabase
          .from("stats")
          .select("total_correct,total_wrong")
          .eq("id", "global")
          .maybeSingle();
        if (data) setGlobalStats(data);
      } catch {
        /* stats are non-critical */
      }
    })();
  }, []);

  // Timer
  useEffect(() => {
    if (phase !== "test") return;
    if (minutes === 0) {
      const startedAt = Date.now() - elapsed * 1000;
      const tick = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000));
      tick();
      const id = setInterval(tick, 500);
      return () => clearInterval(id);
    }
    const tick = () => {
      const left = Math.max(0, Math.ceil((endAtRef.current - Date.now()) / 1000));
      setRemaining(left);
      if (left <= 0) finishTest();
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  async function refreshStats() {
    const { data } = await supabase
      .from("stats")
      .select("total_correct,total_wrong")
      .eq("id", "global")
      .maybeSingle();
    if (data) setGlobalStats(data);
  }

  async function startTest() {
    setError(null);
    setLoading(true);
    try {
      localStorage.setItem(LS_TIME, String(minutes));
      localStorage.setItem(LS_COUNT, String(qCount));

      // Fetch a chunk and shuffle client-side. For larger pools, grab up to 500 rows.
      const fetchLimit = Math.min(Math.max(qCount * 5, 50), 1000);
      const { data, error: err } = await supabase
        .from("questions")
        .select("id,domain,scenario,options,correct_answer,hint,rationale_correct,rationale_incorrect")
        .limit(fetchLimit);
      if (err) throw err;
      if (!data || data.length === 0) throw new Error("No questions available");
      const picked = shuffle(data as unknown as DbQuestion[]).slice(0, qCount).map(normalize);

      setQuestions(picked);
      setAnswers(Array(picked.length).fill(null));
      setPerQTime(Array(picked.length).fill(0));
      setCurrent(0);
      setElapsed(0);
      setShowHint(false);
      endAtRef.current = minutes > 0 ? Date.now() + minutes * 60 * 1000 : 0;
      qStartRef.current = Date.now();
      setPhase("test");
    } catch (e: any) {
      setError(e.message || "Failed to load questions");
    } finally {
      setLoading(false);
    }
  }

  function recordTimeForCurrent() {
    const now = Date.now();
    const dt = (now - qStartRef.current) / 1000;
    qStartRef.current = now;
    setPerQTime((prev) => {
      const next = [...prev];
      next[current] = (next[current] || 0) + dt;
      return next;
    });
  }

  async function selectAnswer(i: number) {
    if (answers[current] !== null) return; // locked
    const q = questions[current];
    const isCorrect = i === q.answerIndex;
    setAnswers((prev) => {
      const next = [...prev];
      next[current] = i;
      return next;
    });
    // Local per-device history (only first attempt of each question counts toward bank progress)
    setHistory((prev) => {
      if (prev[q.id]) return prev; // already recorded — reattempts don't double count
      const next: History = { ...prev, [q.id]: { c: isCorrect ? 1 : 0 } };
      saveHistory(next);
      return next;
    });
    // Fire-and-forget DB update for global tally
    try {
      await supabase.rpc("record_answer", { is_correct: isCorrect });
      refreshStats();
    } catch {
      // swallow — UI keeps working offline
    }
  }

  // Reattempt the current question: clear local lock so the user can pick again.
  // Does NOT touch the global DB tally or the local history (so bank progress is preserved).
  function reattemptCurrent() {
    setAnswers((prev) => {
      const next = [...prev];
      next[current] = null;
      return next;
    });
    setShowHint(false);
    qStartRef.current = Date.now();
  }

  function goTo(idx: number) {
    if (idx < 0 || idx >= questions.length) return;
    recordTimeForCurrent();
    setCurrent(idx);
    setShowHint(false);
  }

  function finishTest() {
    recordTimeForCurrent();
    setPhase("results");
  }

  function resetAll() {
    setPhase("setup");
    setCurrent(0);
    setQuestions([]);
    setAnswers([]);
    setPerQTime([]);
    refreshStats();
  }

  const totalAnswered = useMemo(() => answers.filter((a) => a !== null).length, [answers]);
  const score = useMemo(
    () =>
      answers.reduce<number>(
        (acc, a, i) => acc + (a !== null && a === questions[i]?.answerIndex ? 1 : 0),
        0
      ),
    [answers, questions]
  );

  // ---------- SETUP ----------
  if (phase === "setup") {
    const attemptedIds = Object.keys(history);
    const attempted = attemptedIds.length;
    const localCorrect = attemptedIds.reduce((n, k) => n + (history[k].c ? 1 : 0), 0);
    const localWrong = attempted - localCorrect;
    const bankComplete = available > 0 && attempted >= available;
    const pct = available > 0 ? Math.min(100, Math.round((attempted / available) * 100)) : 0;

    return (
      <div className="min-h-screen bg-background text-foreground">
        <div className="mx-auto max-w-3xl px-4 py-10">
          <h1 className="text-3xl font-bold tracking-tight">MCQ Test Runner</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {available > 0
              ? `${available.toLocaleString()} questions available in the bank.`
              : "Loading question bank…"}
          </p>

          {/* Per-device bank progress */}
          {available > 0 && (
            <div className="mt-4 rounded-lg border border-border bg-card p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">Your progress through the bank</span>
                <span className="text-muted-foreground">
                  {attempted.toLocaleString()} / {available.toLocaleString()} ({pct}%)
                </span>
              </div>
              <div className="mt-2 h-2 w-full overflow-hidden rounded bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="mt-2 text-xs text-muted-foreground">
                Your correct: <span className="font-semibold text-primary">{localCorrect}</span> ·
                {" "}wrong: <span className="font-semibold text-destructive">{localWrong}</span>
                {attempted > 0 && (
                  <>
                    {" "}· accuracy:{" "}
                    <span className="font-semibold">
                      {Math.round((localCorrect / attempted) * 100)}%
                    </span>
                  </>
                )}
              </div>
              {bankComplete && (
                <div className="mt-3 rounded-md border border-primary/40 bg-primary/10 p-3 text-sm">
                  🏆 <span className="font-semibold">You've completed the entire bank!</span>{" "}
                  Final score: <span className="font-semibold">{localCorrect}</span> /{" "}
                  {available} ({Math.round((localCorrect / available) * 100)}%)
                </div>
              )}
              {attempted > 0 && (
                <button
                  onClick={() => {
                    if (confirm("Reset your per-device progress? Global tally is not affected.")) {
                      saveHistory({});
                      setHistory({});
                    }
                  }}
                  className="mt-3 text-xs font-medium text-muted-foreground underline hover:text-foreground"
                >
                  Reset my progress
                </button>
              )}
            </div>
          )}

          {globalStats && (
            <div className="mt-4 flex flex-wrap gap-3 text-sm">
              <div className="rounded-md border border-border bg-card px-3 py-2">
                <span className="text-muted-foreground">Global correct: </span>
                <span className="font-semibold text-primary">{globalStats.total_correct}</span>
              </div>
              <div className="rounded-md border border-border bg-card px-3 py-2">
                <span className="text-muted-foreground">Global wrong: </span>
                <span className="font-semibold text-destructive">{globalStats.total_wrong}</span>
              </div>
            </div>
          )}

          <div className="mt-6 grid gap-4 rounded-lg border border-border bg-card p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-sm font-medium">
                  Number of questions
                </label>
                <input
                  type="number"
                  min={1}
                  max={Math.max(1, available || 9999)}
                  value={qCount}
                  onChange={(e) => setQCount(Math.max(1, Number(e.target.value) || 1))}
                  className="mt-1 w-32 rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium">
                  Total time (minutes){" "}
                  <span className="text-xs text-muted-foreground">— 0 = unlimited</span>
                </label>
                <input
                  type="number"
                  min={0}
                  max={600}
                  value={minutes}
                  onChange={(e) => setMinutes(Math.max(0, Number(e.target.value) || 0))}
                  className="mt-1 w-32 rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </div>
            </div>

            <button
              onClick={startTest}
              disabled={loading || available === 0}
              className="w-fit rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? "Loading…" : "Start Test"}
            </button>

            {error && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ---------- TEST ----------
  if (phase === "test") {
    const q = questions[current];
    const userAns = answers[current];
    const locked = userAns !== null;
    const isCorrect = locked && userAns === q.answerIndex;

    return (
      <div className="min-h-screen bg-background text-foreground">
        <div className="mx-auto max-w-3xl px-4 py-6">
          <div className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3">
            <div className="text-sm text-muted-foreground">
              Question {current + 1} / {questions.length} · Answered {totalAnswered}
            </div>
            <div
              className={`font-mono text-lg font-semibold ${
                minutes > 0 && remaining < 60 ? "text-destructive" : ""
              }`}
            >
              {minutes === 0 ? `∞ ${fmt(elapsed)}` : fmt(remaining)}
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-border bg-card p-6">
            {q.domain && (
              <div className="mb-2 inline-block rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                {q.domain}
              </div>
            )}
            <h2 className="text-lg font-semibold leading-snug">{q.question}</h2>

            {q.hint && !locked && (
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => setShowHint((v) => !v)}
                  className="rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent"
                >
                  {showHint ? "Hide hint" : "💡 Show hint"}
                </button>
                {showHint && (
                  <p className="mt-2 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                    {q.hint}
                  </p>
                )}
              </div>
            )}

            <div className="mt-4 grid gap-2">
              {q.options.map((opt, i) => {
                const selected = userAns === i;
                const isAnsKey = i === q.answerIndex;
                let cls = "border-input bg-background hover:bg-accent";
                if (locked) {
                  if (isAnsKey) cls = "border-primary bg-primary/15";
                  else if (selected) cls = "border-destructive bg-destructive/10";
                  else cls = "border-input bg-background opacity-70";
                } else if (selected) {
                  cls = "border-primary bg-primary/10";
                }
                return (
                  <button
                    key={i}
                    onClick={() => selectAnswer(i)}
                    disabled={locked}
                    className={`rounded-md border px-4 py-3 text-left text-sm transition-colors ${cls}`}
                  >
                    <span className="mr-2 font-mono text-xs text-muted-foreground">
                      {q.optionKeys[i]}.
                    </span>
                    {opt}
                    {locked && isAnsKey && (
                      <span className="ml-2 text-xs font-semibold text-primary">✓ Correct</span>
                    )}
                    {locked && selected && !isAnsKey && (
                      <span className="ml-2 text-xs font-semibold text-destructive">✗ Your pick</span>
                    )}
                  </button>
                );
              })}
            </div>

            {locked && (
              <div className="mt-4 space-y-2 rounded-md border border-border bg-background p-4 text-sm">
                <div
                  className={`inline-block rounded px-2 py-0.5 text-xs font-semibold ${
                    isCorrect
                      ? "bg-primary/15 text-primary"
                      : "bg-destructive/15 text-destructive"
                  }`}
                >
                  {isCorrect ? "Correct!" : "Incorrect"}
                </div>
                {q.rationaleCorrect && (
                  <p>
                    <span className="font-semibold">Why {q.optionKeys[q.answerIndex]} is correct: </span>
                    <span className="text-muted-foreground">{q.rationaleCorrect}</span>
                  </p>
                )}
                {q.rationaleIncorrect && (
                  <p>
                    <span className="font-semibold">Why the others are wrong: </span>
                    <span className="text-muted-foreground">{q.rationaleIncorrect}</span>
                  </p>
                )}
                {q.hint && (
                  <p className="text-xs text-muted-foreground">💡 Hint: {q.hint}</p>
                )}
                <div className="pt-1">
                  <button
                    onClick={reattemptCurrent}
                    className="rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent"
                  >
                    ↻ Reattempt
                  </button>
                  <span className="ml-2 text-xs text-muted-foreground">
                    (only your first answer counts toward your bank progress)
                  </span>
                </div>
              </div>
            )}

            <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
              <button
                onClick={() => goTo(current - 1)}
                disabled={current === 0}
                className="rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
              >
                Previous
              </button>
              <div className="text-xs text-muted-foreground">
                Score so far: {score} / {totalAnswered}
              </div>
              {current < questions.length - 1 ? (
                <button
                  onClick={() => goTo(current + 1)}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  Next
                </button>
              ) : (
                <button
                  onClick={finishTest}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  Submit
                </button>
              )}
            </div>

            <div className="mt-4 flex flex-wrap gap-1">
              {questions.map((_, i) => {
                const a = answers[i];
                const status =
                  a === null
                    ? "bg-muted text-muted-foreground"
                    : a === questions[i].answerIndex
                      ? "bg-primary/30 text-foreground"
                      : "bg-destructive/30 text-foreground";
                return (
                  <button
                    key={i}
                    onClick={() => goTo(i)}
                    className={`h-7 w-7 rounded text-xs font-medium ${
                      i === current ? "ring-2 ring-primary " : ""
                    }${status}`}
                  >
                    {i + 1}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---------- RESULTS ----------
  const totalTime = perQTime.reduce((a, b) => a + b, 0);
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-4 py-10">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Results</h1>
          <button
            onClick={resetAll}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            New test
          </button>
        </div>
        <p className="mt-2 text-lg">
          Score: <span className="font-semibold">{score}</span> / {questions.length} ·{" "}
          <span className="text-muted-foreground">Total time: {fmt(totalTime)}</span>
        </p>
        {globalStats && (
          <p className="mt-1 text-sm text-muted-foreground">
            Global tally — correct: {globalStats.total_correct} · wrong: {globalStats.total_wrong}
          </p>
        )}

        <div className="mt-6 space-y-3">
          {questions.map((q, i) => {
            const userAns = answers[i];
            const correct = userAns === q.answerIndex;
            return (
              <div key={q.id} className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="text-sm font-medium">
                    {q.domain && (
                      <div className="mb-1 text-xs font-normal text-muted-foreground">
                        {q.domain}
                      </div>
                    )}
                    {i + 1}. {q.question}
                  </div>
                  <div className="shrink-0 text-xs text-muted-foreground">
                    ⏱ {fmt(perQTime[i] || 0)}
                  </div>
                </div>
                <div className="mt-2 text-sm">
                  <span
                    className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${
                      correct
                        ? "bg-primary/15 text-primary"
                        : userAns === null
                          ? "bg-muted text-muted-foreground"
                          : "bg-destructive/15 text-destructive"
                    }`}
                  >
                    {correct ? "Correct" : userAns === null ? "Skipped" : "Wrong"}
                  </span>
                  <div className="mt-2 text-muted-foreground">
                    Your answer:{" "}
                    <span className="text-foreground">
                      {userAns === null
                        ? "—"
                        : `${q.optionKeys[userAns]}. ${q.options[userAns]}`}
                    </span>
                  </div>
                  {!correct && (
                    <div className="text-muted-foreground">
                      Correct answer:{" "}
                      <span className="text-foreground">
                        {q.optionKeys[q.answerIndex]}. {q.options[q.answerIndex]}
                      </span>
                    </div>
                  )}
                  {(q.rationaleCorrect || q.rationaleIncorrect || q.hint) && (
                    <details className="mt-3 rounded-md border border-border bg-background p-3">
                      <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                        Explanation
                      </summary>
                      <div className="mt-2 space-y-2 text-xs">
                        {q.hint && (
                          <p>
                            <span className="font-semibold">Hint: </span>
                            <span className="text-muted-foreground">{q.hint}</span>
                          </p>
                        )}
                        {q.rationaleCorrect && (
                          <p>
                            <span className="font-semibold">Why correct: </span>
                            <span className="text-muted-foreground">{q.rationaleCorrect}</span>
                          </p>
                        )}
                        {q.rationaleIncorrect && (
                          <p>
                            <span className="font-semibold">Why others are wrong: </span>
                            <span className="text-muted-foreground">{q.rationaleIncorrect}</span>
                          </p>
                        )}
                      </div>
                    </details>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}