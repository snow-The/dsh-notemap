import { type UiCtx } from './ui.ts';
export declare const name = "dsh-notemap";
export declare const inject: readonly ['tools', 'webServer'];
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
} & UiCtx): void;
export declare function dispose(): void;
