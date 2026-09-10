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
export declare function apply(ctx: {
    tools: {
        register: (def: unknown) => unknown;
    };
}): void;
export declare function dispose(): void;
