import { getSupabase } from "./supabase.js";

/**
 * daily_log — the Supabase table already populated by the daily health log
 * form. One row per (user_id, log_date), enforced by the existing
 * `daily_log_user_id_log_date_key` unique constraint.
 *
 * Weight and water are deliberately NOT written here. They live in
 * weight_log and water_log so the existing trend tooling sees a single
 * canonical series; the daily_rollup view coalesces them back onto the day.
 */

export type Level = "high" | "medium" | "low";
export type StoolQuality = "loose" | "regular" | "solid";
export type Bloating = "none" | "mild" | "moderate" | "severe";

export interface DailyLogEntry {
    id: string;
    user_id: string;
    log_date: string;
    physical_mood: Level | null;
    mental_mood: Level | null;
    stress: Level | null;
    meditation_mins: number | null;
    recovery: number | null;
    weight_kg: number | null;
    waist_in: number | null;
    hips_in: number | null;
    chest_in: number | null;
    thigh_in: number | null;
    arm_in: number | null;
    water_litres: number | null;
    alcohol_units: number | null;
    caffeine_cutoff: string | null;
    stools: number | null;
    stool_quality: StoolQuality | null;
    bloating: Bloating | null;
    bp_systolic: number | null;
    bp_diastolic: number | null;
    blood_sugar: number | null;
    illness: string | null;
    notes: string | null;
    created_at: string;
    updated_at: string;
}

/**
 * Every field optional, and every field nullable:
 *   undefined -> leave whatever is already stored untouched
 *   null      -> explicitly clear the stored value
 * That distinction is what makes partial logging across the day safe.
 */
export interface DailyLogInput {
    physical_mood?: Level | null;
    mental_mood?: Level | null;
    stress?: Level | null;
    meditation_mins?: number | null;
    recovery?: number | null;
    waist_in?: number | null;
    hips_in?: number | null;
    chest_in?: number | null;
    thigh_in?: number | null;
    arm_in?: number | null;
    alcohol_units?: number | null;
    caffeine_cutoff?: string | null;
    stools?: number | null;
    stool_quality?: StoolQuality | null;
    bloating?: Bloating | null;
    bp_systolic?: number | null;
    bp_diastolic?: number | null;
    blood_sugar?: number | null;
    illness?: string | null;
    notes?: string | null;
}

export const DAILY_LOG_FIELDS: (keyof DailyLogInput)[] = [
    "physical_mood",
    "mental_mood",
    "stress",
    "meditation_mins",
    "recovery",
    "waist_in",
    "hips_in",
    "chest_in",
    "thigh_in",
    "arm_in",
    "alcohol_units",
    "caffeine_cutoff",
    "stools",
    "stool_quality",
    "bloating",
    "bp_systolic",
    "bp_diastolic",
    "blood_sugar",
    "illness",
    "notes",
];

export interface DailyLogUpsertResult {
    entry: DailyLogEntry;
    created: boolean;
    /** Fields this call actually wrote, for a useful confirmation message. */
    changed: string[];
    /** Fields that were already set and have now been overwritten. */
    overwritten: string[];
}

/** Postgres `time` wants HH:MM:SS; accept HH:MM from the model. */
export function normalizeTime(value: string): string {
    const m = value.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/);
    if (!m)
        throw new Error(
            `Invalid time '${value}'. Use 24-hour HH:MM, e.g. '14:30'.`,
        );
    const hh = m[1]!.padStart(2, "0");
    return `${hh}:${m[2]}:${m[3] ?? "00"}`;
}

export function assertValidDate(date: string): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
        throw new Error(`Invalid date '${date}'. Use YYYY-MM-DD.`);
}

/**
 * Read-merge-write rather than a blind upsert: a plain upsert would null out
 * every column the caller didn't mention, so logging stress at 9pm would wipe
 * the recovery score logged at 7am.
 */
export async function upsertDailyLog(
    userId: string,
    logDate: string,
    input: DailyLogInput,
): Promise<DailyLogUpsertResult> {
    assertValidDate(logDate);
    const sb = getSupabase();

    const { data: existing, error: selErr } = await sb
        .from("daily_log")
        .select("*")
        .eq("user_id", userId)
        .eq("log_date", logDate)
        .maybeSingle();
    if (selErr)
        throw new Error(`Failed to look up daily log: ${selErr.message}`);

    const patch: Record<string, unknown> = {};
    const changed: string[] = [];
    const overwritten: string[] = [];

    for (const field of DAILY_LOG_FIELDS) {
        const value = input[field];
        if (value === undefined) continue;
        const normalized =
            field === "caffeine_cutoff" && typeof value === "string"
                ? normalizeTime(value)
                : value;
        patch[field] = normalized;
        changed.push(field);
        const prior = existing
            ? (existing as Record<string, unknown>)[field]
            : null;
        if (
            prior !== null &&
            prior !== undefined &&
            String(prior) !== String(normalized)
        )
            overwritten.push(field);
    }

    if (changed.length === 0)
        throw new Error("No fields supplied — nothing to log.");

    patch.updated_at = new Date().toISOString();

    if (existing) {
        const { data, error } = await sb
            .from("daily_log")
            .update(patch)
            .eq("id", (existing as DailyLogEntry).id)
            .select()
            .single();
        if (error)
            throw new Error(`Failed to update daily log: ${error.message}`);
        return {
            entry: data as DailyLogEntry,
            created: false,
            changed,
            overwritten,
        };
    }

    const { data, error } = await sb
        .from("daily_log")
        .insert({ user_id: userId, log_date: logDate, ...patch })
        .select()
        .single();
    if (error) throw new Error(`Failed to insert daily log: ${error.message}`);
    return {
        entry: data as DailyLogEntry,
        created: true,
        changed,
        overwritten,
    };
}

export async function getDailyLogByDate(
    userId: string,
    date: string,
): Promise<DailyLogEntry | null> {
    assertValidDate(date);
    const sb = getSupabase();
    const { data, error } = await sb
        .from("daily_log")
        .select("*")
        .eq("user_id", userId)
        .eq("log_date", date)
        .maybeSingle();
    if (error) throw new Error(`Failed to get daily log: ${error.message}`);
    return (data as DailyLogEntry) ?? null;
}

export async function getDailyLogInRange(
    userId: string,
    startDate: string,
    endDate: string,
): Promise<DailyLogEntry[]> {
    assertValidDate(startDate);
    assertValidDate(endDate);
    const sb = getSupabase();
    const { data, error } = await sb
        .from("daily_log")
        .select("*")
        .eq("user_id", userId)
        .gte("log_date", startDate)
        .lte("log_date", endDate)
        .order("log_date", { ascending: true });
    if (error) throw new Error(`Failed to get daily logs: ${error.message}`);
    return (data ?? []) as DailyLogEntry[];
}

const LABELS: Record<string, string> = {
    physical_mood: "Physical mood",
    mental_mood: "Mental mood",
    stress: "Stress",
    meditation_mins: "Meditation (mins)",
    recovery: "Recovery (1-10)",
    weight_kg: "Weight (kg, form)",
    waist_in: "Waist (in)",
    hips_in: "Hips (in)",
    chest_in: "Chest (in)",
    thigh_in: "Thigh (in)",
    arm_in: "Arm (in)",
    water_litres: "Water (L, form)",
    alcohol_units: "Alcohol (units)",
    caffeine_cutoff: "Caffeine cutoff",
    stools: "Stools",
    stool_quality: "Stool quality",
    bloating: "Bloating",
    bp_systolic: "BP systolic",
    bp_diastolic: "BP diastolic",
    blood_sugar: "Blood sugar",
    illness: "Illness",
    notes: "Notes",
};

export function formatDailyLog(entry: DailyLogEntry): string {
    const rows = Object.entries(LABELS)
        .map(([key, label]) => {
            const value = (entry as unknown as Record<string, unknown>)[key];
            if (value === null || value === undefined) return null;
            return `${label}: ${value}`;
        })
        .filter((line): line is string => line !== null);
    if (rows.length === 0) return `${entry.log_date}: row exists but is empty.`;
    return `${entry.log_date}\n${rows.join("\n")}`;
}

export function formatFieldList(fields: string[]): string {
    return fields.map((f) => LABELS[f] ?? f).join(", ");
}
