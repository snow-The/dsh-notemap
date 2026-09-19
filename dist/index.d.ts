export declare const name = "dsh-notemap";
export declare const inject: readonly ['tools'];
export declare function importSessions(opts?: {
    limit?: number;
    maxLines?: number;
    force?: boolean;
    sessionsDir?: string;
}): Promise<{
    scanned: number;
    sessions: number;
    checkpoints: number;
    events: number;
    assistants: number;
    skipped: number;
    imported: string[];
}>;
/**
 * Retrieval signals - the write side of L4 (proposal B, 31057 Tab.4).
 *
 * A degenerate answer (the list was CUT, or the handle did not resolve) is the only retrieval
 * event we can measure without a reward label, and it is what a budget policy would key on. It is
 * recorded here, in ONE place where the tool name is known, rather than at nine call sites; a clean
 * answer is deliberately NOT recorded, so the journal can never be inflated into a fake signal rate.
 *
 * The path is a shared file contract with dsh-session-handoff, whose acp_status reads it back as the
 * L4 layer: <DSH_HOME>/notemap-retrieval.jsonl (DSH_NOTEMAP_RETRIEVAL overrides it).
 */
export declare function retrievalJournalPath(): string;
/** Append one signal. NEVER throws: a measurement is not worth breaking the answer it describes. */
export declare function recordRetrievalSignal(tool: string, value: unknown, exec?: {
    agent?: {
        session?: {
            id?: string;
        };
    };
}): boolean;
export declare function apply(ctx: {
    tools: {
        register: (def: unknown) => unknown;
    };
}): void;
export declare function dispose(): void;
