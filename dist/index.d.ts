import { type UiCtx } from './ui.ts';
export declare const name = "dsh-notemap";
export declare function apply(ctx: {
    tools: {
        register: (def: unknown) => unknown;
    };
} & UiCtx): void;
export declare function dispose(): void;
