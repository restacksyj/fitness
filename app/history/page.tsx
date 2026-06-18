"use client";

import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import { format } from "date-fns";
import { Fragment, useEffect, useMemo, useState } from "react";
import { DayPicker, type DateRange } from "react-day-picker";
import "react-day-picker/style.css";
import { ArrowLeft, Calendar, Check, ChevronDown, ChevronLeft, ChevronRight, Dumbbell, Edit3, Plus, Search, Trash2, X } from "lucide-react";
import { isSupabaseConfigured, supabase, type ExerciseCatalogItem, type WorkoutExercise, type WorkoutSetRow } from "@/lib/supabase";

const PAGE_SIZE = 10;
const normalise = (name: string) => name.trim().toLowerCase();
type ExerciseSuggestion = Pick<ExerciseCatalogItem, "id" | "name" | "category" | "muscles" | "equipment" | "image_url"> & { source: "catalog" | "history" };

function inputDateToDate(value: string) {
    return value ? new Date(`${value}T00:00:00`) : undefined;
}

function dateToInputValue(date?: Date) {
    return date ? format(date, "yyyy-MM-dd") : "";
}

function DateRangePickerField({ from, to, onChange, compact = false }: { from: string; to: string; onChange: (range: { from: string; to: string }) => void; compact?: boolean }) {
    const selected: DateRange | undefined = from || to ? { from: inputDateToDate(from), to: inputDateToDate(to) } : undefined;
    const label = selected?.from
        ? selected.to
            ? `${format(selected.from, "MMM d, yyyy")} – ${format(selected.to, "MMM d, yyyy")}`
            : `${format(selected.from, "MMM d, yyyy")} – optional`
        : "Date range";

    return (
        <Dialog.Root>
            <Dialog.Trigger asChild>
                <button className={compact ? "bare-icon-btn" : "date-picker-trigger"} type="button" aria-label="Date range" title={label}>
                    <Calendar size={16} />
                    {!compact && <span>{label}</span>}
                </button>
            </Dialog.Trigger>
            <Dialog.Portal>
                <Dialog.Overlay className="dialog-overlay" />
                <Dialog.Content className="dialog-content date-dialog-content">
                    <Dialog.Title className="dialog-title">Date range</Dialog.Title>
                    <Dialog.Description className="dialog-description">Pick a start date. End date is optional.</Dialog.Description>
                    <DayPicker
                        mode="range"
                        selected={selected}
                        onSelect={(range) => onChange({ from: dateToInputValue(range?.from), to: dateToInputValue(range?.to) })}
                    />
                    <div className="dialog-actions">
                        <button className="btn secondary" onClick={() => onChange({ from: "", to: "" })}>Clear</button>
                        <Dialog.Close asChild><button className="btn">Done</button></Dialog.Close>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}

export default function HistoryPage() {
    const [userKey, setUserKey] = useState("");
    const [history, setHistory] = useState<WorkoutExercise[]>([]);
    const [search, setSearch] = useState("");
    const [catalogSuggestions, setCatalogSuggestions] = useState<ExerciseSuggestion[]>([]);
    const [isSearchFocused, setIsSearchFocused] = useState(false);
    const [dateFrom, setDateFrom] = useState("");
    const [dateTo, setDateTo] = useState("");
    const [page, setPage] = useState(0);
    const [expandedRecordId, setExpandedRecordId] = useState("");
    const [editingRecordId, setEditingRecordId] = useState("");
    const [editRows, setEditRows] = useState<WorkoutSetRow[]>([]);
    const [pendingDeleteRecord, setPendingDeleteRecord] = useState<WorkoutExercise | null>(null);

    useEffect(() => {
        const exercise = new URLSearchParams(window.location.search).get("exercise") ?? "";
        setSearch(exercise);

        async function initAuth() {
            if (!isSupabaseConfigured) return;
            const { data } = await supabase.auth.getUser();
            const user = data.user;
            if (!user) return;
            setUserKey(user.id);
            loadHistory(user.id);
        }
        initAuth();
    }, []);

    useEffect(() => {
        const query = search.trim();
        if (!isSupabaseConfigured || query.length < 2) {
            setCatalogSuggestions([]);
            return;
        }

        let cancelled = false;
        const timeout = window.setTimeout(async () => {
            const { data, error } = await supabase
                .from("exercise_catalog")
                .select("id,name,category,muscles,equipment,image_url")
                .ilike("name", `%${query}%`)
                .order("name", { ascending: true })
                .limit(8);

            if (cancelled) return;
            if (error) {
                console.error(error.message);
                setCatalogSuggestions([]);
                return;
            }

            setCatalogSuggestions(((data ?? []) as ExerciseSuggestion[]).map((exercise) => ({ ...exercise, source: "catalog" })));
        }, 180);

        return () => {
            cancelled = true;
            window.clearTimeout(timeout);
        };
    }, [search]);

    async function loadHistory(key = userKey) {
        if (!key || !isSupabaseConfigured) return;
        const { data, error } = await supabase
            .from("workout_exercises")
            .select("*")
            .eq("user_key", key)
            .order("created_at", { ascending: false })
            .limit(10);

        if (error) return console.error(error.message);
        setHistory(data ?? []);
    }

    const exerciseNames = useMemo(() => {
        return Array.from(new Set(history.map((h) => h.exercise_name)));
    }, [history]);

    const exerciseSuggestions = useMemo(() => {
        const q = normalise(search);
        if (!q) return [];

        const suggestions = new Map<string, ExerciseSuggestion>();
        exerciseNames
            .filter((name) => normalise(name).includes(q))
            .forEach((name) => {
                const key = normalise(name);
                if (!suggestions.has(key)) {
                    suggestions.set(key, { id: key, name, category: "Recent", muscles: [], equipment: [], image_url: null, source: "history" });
                }
            });
        catalogSuggestions.forEach((exercise) => {
            const key = normalise(exercise.name);
            if (!suggestions.has(key)) suggestions.set(key, exercise);
        });

        return Array.from(suggestions.values()).slice(0, 8);
    }, [catalogSuggestions, exerciseNames, search]);

    const filteredHistory = useMemo(() => {
        const q = normalise(search);
        const fromTime = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : null;
        const toTime = dateTo ? new Date(`${dateTo}T23:59:59`).getTime() : null;

        return history.filter((record) => {
            const recordTime = new Date(record.created_at).getTime();
            const matchesSearch = !q || normalise(record.exercise_name).includes(q);
            const matchesFrom = fromTime === null || recordTime >= fromTime;
            const matchesTo = toTime === null || recordTime <= toTime;
            return matchesSearch && matchesFrom && matchesTo;
        });
    }, [dateFrom, dateTo, history, search]);

    const totalPages = Math.max(1, Math.ceil(filteredHistory.length / PAGE_SIZE));
    const safePage = Math.min(page, totalPages - 1);
    const pageRows = filteredHistory.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

    function updateSearch(value: string) {
        setSearch(value);
        setPage(0);
    }

    function startEditing(record: WorkoutExercise, rows: WorkoutSetRow[]) {
        setEditingRecordId(record.id);
        setEditRows(rows.map((row, index) => ({ set: index + 1, reps: Number(row.reps), weight: Number(row.weight), notes: row.notes ?? "" })));
    }

    function updateEditRow(index: number, patch: Partial<WorkoutSetRow>) {
        setEditRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
    }

    function addEditRow() {
        setEditRows((current) => {
            const previous = current.at(-1);
            const next = previous ? { ...previous, set: current.length + 1 } : { set: 1, reps: 0, weight: 0, notes: "" };
            return [...current, next];
        });
    }

    function removeEditRow(indexToRemove: number) {
        setEditRows((current) => current.filter((_, index) => index !== indexToRemove).map((row, index) => ({ ...row, set: index + 1 })));
    }

    async function saveEdit(record: WorkoutExercise) {
        const rows = editRows
            .map((row, index) => ({ set: index + 1, reps: Number(row.reps), weight: Number(row.weight), notes: row.notes?.trim() || undefined }))
            .filter((row) => Number.isFinite(row.reps) && row.reps > 0 && Number.isFinite(row.weight) && row.weight >= 0);

        if (!rows.length) return alert("Add at least one valid set.");

        const payload = {
            sets: rows.length,
            reps: Math.max(...rows.map((row) => row.reps)),
            weight: Math.max(...rows.map((row) => row.weight)),
            volume: rows.reduce((sum, row) => sum + row.reps * row.weight, 0),
            set_rows: rows,
        };

        const { error } = await supabase.from("workout_exercises").update(payload).eq("id", record.id).eq("user_key", userKey);
        if (error) return alert(error.message);

        setHistory((current) => current.map((row) => row.id === record.id ? { ...row, ...payload } : row));
        setEditingRecordId("");
        setEditRows([]);
    }

    async function confirmDeleteRecord() {
        if (!pendingDeleteRecord) return;
        const { error } = await supabase.from("workout_exercises").delete().eq("id", pendingDeleteRecord.id).eq("user_key", userKey);
        if (error) return alert(error.message);

        setHistory((current) => current.filter((row) => row.id !== pendingDeleteRecord.id));
        setPendingDeleteRecord(null);
        setExpandedRecordId("");
        setEditingRecordId("");
        setEditRows([]);
    }

    return (
        <main>
            <header className="hero">
                <h1>Exercise records</h1>
            </header>

            <section className="card stack">
                <div className="section-title">
                    <div className="history-heading">
                        <Link className="nav-icon" aria-label="Back" href="/"><ArrowLeft size={17} /></Link>
                    </div>
                </div>

                <div className="input-icon-wrap search-combo">
                    <Search className="input-icon" size={17} />
                    <input
                        className="input with-icon with-clear"
                        style={{ paddingRight: 82 }}
                        placeholder="Search exercise records"
                        value={search}
                        onFocus={() => setIsSearchFocused(true)}
                        onBlur={() => setTimeout(() => setIsSearchFocused(false), 120)}
                        onChange={(event) => {
                            updateSearch(event.target.value);
                            setIsSearchFocused(true);
                        }}
                    />
                    {search && (
                        <button className="clear-input" style={{ right: 42 }} aria-label="Clear exercise search" onClick={() => updateSearch("")}>
                            <X size={16} />
                        </button>
                    )}
                    <div style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)" }}>
                        <DateRangePickerField
                            compact
                            from={dateFrom}
                            to={dateTo}
                            onChange={(range) => {
                                setDateFrom(range.from);
                                setDateTo(range.to);
                                setPage(0);
                            }}
                        />
                    </div>
                    {isSearchFocused && exerciseSuggestions.length > 0 && (
                        <div className="exercise-suggestions" role="listbox">
                            {exerciseSuggestions.map((exercise) => (
                                <div
                                    className="exercise-suggestion-item"
                                    key={`${exercise.source}-${exercise.id}`}
                                    role="option"
                                    tabIndex={0}
                                    onMouseDown={(event) => {
                                        event.preventDefault();
                                        updateSearch(exercise.name);
                                        setIsSearchFocused(false);
                                    }}
                                >
                                    <span className="exercise-suggestion-icon">
                                        {exercise.image_url ? <img src={exercise.image_url} alt="" /> : <Dumbbell size={17} />}
                                    </span>
                                    <span className="exercise-suggestion-copy">
                                        <span>{exercise.name}</span>
                                        <small>{[exercise.category, exercise.muscles?.[0], exercise.equipment?.[0]].filter(Boolean).join(" • ")}</small>
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {pageRows.length ? (
                    <>
                        <div className="table-wrap">
                            <table className="records-table">
                                <colgroup>
                                    <col style={{ width: 42 }} />
                                    <col style={{ width: 118 }} />
                                    <col />
                                    <col style={{ width: 70 }} />
                                    <col style={{ width: 112 }} />
                                    <col style={{ width: 96 }} />
                                    <col style={{ width: 76 }} />
                                </colgroup>
                                <thead>
                                    <tr>
                                        <th></th>
                                        <th>Date</th>
                                        <th>Exercise</th>
                                        <th>Sets</th>
                                        <th>Best</th>
                                        <th>Volume</th>
                                        <th></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {pageRows.map((record) => {
                                        const isExpanded = expandedRecordId === record.id;
                                        const isEditing = editingRecordId === record.id;
                                        const setRows = record.set_rows?.length ? record.set_rows : [{ set: 1, reps: record.reps, weight: record.weight }];
                                        const displayRows = isEditing ? editRows : setRows;
                                        return (
                                            <Fragment key={record.id}>
                                                <tr className="clickable-table-row" onClick={() => setExpandedRecordId(isExpanded ? "" : record.id)}>
                                                    <td>
                                                        <button className="table-toggle" aria-label={isExpanded ? "Collapse record" : "Expand record"}>
                                                            <ChevronDown className={isExpanded ? "chevron open" : "chevron"} size={16} />
                                                        </button>
                                                    </td>
                                                    <td>{new Date(record.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</td>
                                                    <td>{record.exercise_name}</td>
                                                    <td>{record.sets}</td>
                                                    <td>{record.weight} lbs × {record.reps}</td>
                                                    <td>{record.volume} lbs</td>
                                                    <td>
                                                        <div className="record-actions">
                                                            {isEditing ? (
                                                                <>
                                                                    <button className="table-toggle" aria-label="Save record" onClick={(event) => { event.stopPropagation(); saveEdit(record); }}><Check size={16} /></button>
                                                                    <button className="table-toggle" aria-label="Cancel edit" onClick={(event) => { event.stopPropagation(); setEditingRecordId(""); setEditRows([]); }}><X size={16} /></button>
                                                                </>
                                                            ) : (
                                                                <>
                                                                    <button className="table-toggle" aria-label="Edit record" onClick={(event) => { event.stopPropagation(); setExpandedRecordId(record.id); startEditing(record, setRows); }}><Edit3 size={15} /></button>
                                                                    <button className="table-toggle" aria-label="Delete record" onClick={(event) => { event.stopPropagation(); setPendingDeleteRecord(record); }}><Trash2 size={15} /></button>
                                                                </>
                                                            )}
                                                        </div>
                                                    </td>
                                                </tr>
                                                {isExpanded && (
                                                    <tr className="record-detail-row">
                                                        <td colSpan={7}>
                                                            <div className="record-detail-panel">
                                                                <div className="record-detail-top">
                                                                    <div className="record-detail-meta">
                                                                        <span>{new Date(record.created_at).toLocaleString()}</span>
                                                                        <span>{record.sets} sets</span>
                                                                        <span>{record.volume} lbs volume</span>
                                                                    </div>
                                                                </div>
                                                                <div className="set-detail-table">
                                                                    <div className="set-detail-head" style={{ gridTemplateColumns: isEditing ? "0.5fr 1fr 1fr 1.25fr 34px" : "0.6fr 1fr 1fr 1.3fr" }}>
                                                                        <span>Set</span>
                                                                        <span>Reps</span>
                                                                        <span>Weight</span>
                                                                        <span>Notes</span>
                                                                        {isEditing && <span></span>}
                                                                    </div>
                                                                    {displayRows.map((set, index) => (
                                                                        <div className="set-detail-row" style={{ gridTemplateColumns: isEditing ? "0.5fr 1fr 1fr 1.25fr 34px" : "0.6fr 1fr 1fr 1.3fr" }} key={`${record.id}-${set.set}-${index}`}>
                                                                            <span>{index + 1}</span>
                                                                            {isEditing ? (
                                                                                <>
                                                                                    <input className="detail-input" inputMode="numeric" value={set.reps} onChange={(event) => updateEditRow(index, { reps: Number(event.target.value.replace(/\D/g, "")) })} />
                                                                                    <input className="detail-input" inputMode="decimal" value={set.weight} onChange={(event) => updateEditRow(index, { weight: Number(event.target.value.replace(/[^0-9.]/g, "")) })} />
                                                                                    <input className="detail-input" value={set.notes ?? ""} placeholder="Notes" onChange={(event) => updateEditRow(index, { notes: event.target.value })} />
                                                                                    <button className="bare-icon-btn" aria-label={`Remove set ${index + 1}`} onClick={() => removeEditRow(index)}><X size={14} /></button>
                                                                                </>
                                                                            ) : (
                                                                                <>
                                                                                    <span>{set.reps}</span>
                                                                                    <span>{set.weight} lbs</span>
                                                                                    <span>{set.notes || "—"}</span>
                                                                                </>
                                                                            )}
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                                {isEditing && <button className="bare-icon-btn" aria-label="Add set" onClick={addEditRow}><Plus size={16} /></button>}
                                                            </div>
                                                        </td>
                                                    </tr>
                                                )}
                                            </Fragment>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>

                        <div className="pagination">
                            <button className="btn secondary icon-btn" aria-label="Previous page" disabled={safePage === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>
                                <ChevronLeft size={17} />
                            </button>
                            <span className="muted">Page {safePage + 1} of {totalPages}</span>
                            <button className="btn secondary icon-btn" aria-label="Next page" disabled={safePage >= totalPages - 1} onClick={() => setPage((current) => Math.min(totalPages - 1, current + 1))}>
                                <ChevronRight size={17} />
                            </button>
                        </div>
                    </>
                ) : <div className="empty">No records found.</div>}
            </section>

            <Dialog.Root open={Boolean(pendingDeleteRecord)} onOpenChange={(open) => !open && setPendingDeleteRecord(null)}>
                <Dialog.Portal>
                    <Dialog.Overlay className="dialog-overlay" />
                    <Dialog.Content className="dialog-content">
                        <Dialog.Title className="dialog-title">Delete record?</Dialog.Title>
                        <Dialog.Description className="dialog-description">
                            Delete {pendingDeleteRecord?.exercise_name} from your records? This cannot be undone.
                        </Dialog.Description>
                        <div className="dialog-actions">
                            <Dialog.Close asChild><button className="btn secondary">Cancel</button></Dialog.Close>
                            <button className="btn danger" onClick={confirmDeleteRecord}>Delete</button>
                        </div>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>
        </main>
    );
}
