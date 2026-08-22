/**
 * @deepseek-ai/* packages are provided by the DSH host at runtime
 * (never bundled, never installed) — declare minimal shapes for tsc.
 */
declare module '@deepseek-ai/dsh-tools' {
  export interface ToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    output?: { schema: unknown; render?: (args: unknown, value: unknown) => unknown[] };
    timeoutMs?: number;
    execute(args: unknown): unknown | Promise<unknown>;
  }
  export function defineTool(def: ToolDefinition): ToolDefinition;
}