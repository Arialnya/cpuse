import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { parameterSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools';
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client';
import '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-computer-use';
import { NativeBackend } from './backend.js';
import { Controller } from './controller.js';
import { methods, actions, type Method, type Screenshot, type WindowState } from './types.js';
import { descriptions, schemas } from './schemas.js';
import { guidance } from './guidance.js';

export const name = 'cpuse';
export const inject = ['tools', 'systemPrompt'];
export interface Config {
  helperPath?: string; timeoutMs: number; observationTtlMs: number; screenshots: boolean; allowPrintWindowFallback: boolean;
  allowedApps: string[]; deniedApps: string[]; approvalMode: 'always' | 'app';
}
export const Config: z<Config> = z.object({
  helperPath: z.string().description('Optional absolute path to the independently built native helper.'),
  timeoutMs: z.number().min(1000).max(120000).default(30000),
  observationTtlMs: z.number().min(1000).max(120000).default(30000),
  screenshots: z.boolean().default(true).description('Disable for a text-only model route; UIA remains available.'),
  allowPrintWindowFallback: z.boolean().default(false).description('Opt into explicitly labelled PrintWindow capture when WGC fails.'),
  allowedApps: z.array(z.string()).default([]).description('Exact returned app identifiers; empty permits apps subject to approval.'),
  deniedApps: z.array(z.string()).default([]),
  approvalMode: z.union(['always', 'app']).default('always').description('always asks on every input; app asks once per application per agent in this plugin lifetime.'),
});

function modelResult(value: unknown) {
  const maybeState = value as WindowState | { state?: WindowState } | null;
  const state = maybeState && 'screenshots' in maybeState ? maybeState as WindowState : maybeState && 'state' in maybeState ? maybeState.state : undefined;
  const images: Screenshot[] = state?.screenshots ?? [];
  const structuredContent = JSON.parse(JSON.stringify(value, (key, item) => key === 'url' && typeof item === 'string' && item.startsWith('data:image/') ? undefined : item));
  return {
    structuredContent,
    content: [
      { type: 'text', text: JSON.stringify(structuredContent) },
      ...images.map(screenshot => {
        const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(screenshot.url);
        if (!match) throw new Error('Invalid native PNG screenshot.');
        return { type: 'image', mimeType: 'image/png', data: match[1] };
      }),
    ],
  };
}

export async function apply(ctx: Context, config: Config) {
  const controller = new Controller(new NativeBackend({ helperPath: config.helperPath, timeoutMs: config.timeoutMs }), config);
  const toolNames = new Map(methods.map(method => [`computer_use_${method}`, method]));
  const approvedApps = new Set<string>();
  const lifetime = new AbortController();
  const pending = new Set<Promise<ToolExecutionResult>>();
  ctx.on('internal/plugin', fiber => {
    if (fiber === ctx.fiber && fiber.uid === null) lifetime.abort();
  }, { global: true });
  const shared = ctx.get('computerUse');
  const providerName = shared ? (await import('@deepseek-ai/dsh-computer-use/brand')).ComputerUseProviderName('cpuse') : undefined;
  lifetime.signal.throwIfAborted();
  // Cordis runs separate effects concurrently on unload. A generator owns
  // teardown and the provider reservation in reverse sequential order.
  ctx.effect(function* () {
    if (shared && providerName) yield shared.register(providerName);
    yield async () => {
      lifetime.abort();
      approvedApps.clear();
      await controller.dispose();
      await Promise.allSettled([...pending]);
    };
  }, 'cpuse.runtime');
  const owner = (exec: { agent?: { id: string } }) => exec.agent?.id ?? 'unscoped';
  const appFrom = (method: Method, args: unknown): string | undefined => {
    if (!args || typeof args !== 'object') return undefined;
    const input = args as { app?: unknown; window?: { app?: unknown } };
    const app = method === 'launch_app' || method === 'get_window' ? input.app : input.window?.app;
    return typeof app === 'string' ? app : undefined;
  };
  ctx.on('tools/pre-execute', async (exec, next) => {
    const prior = await next();
    if (prior.kind !== 'allow') return prior;
    const method = toolNames.get(exec.name);
    if (!method || ['list_apps', 'list_windows', 'capabilities'].includes(method)) return prior;
    const app = appFrom(method, exec.arguments);
    const key = `${owner(exec)}:${app?.toLowerCase()}`;
    if (app && approvedApps.has(key) && !(config.approvalMode === 'always' && (actions.has(method) || ['launch_app', 'activate_window'].includes(method)))) return prior;
    return { kind: 'ask', reason: `Computer Use ${method} in ${app ?? 'the selected application'}. This may expose window content or change the active desktop.` };
  });
  for (const method of methods) {
    const tool = createMcpToolDefinition(ctx, {
      name: `computer_use_${method}`, rawName: method, description: descriptions[method],
      inputSchema: { ...parameterSchemaSpecToJsonSchema(schemas[method]) },
      async call(args, exec) {
        const result = await controller.execute(method, args, { owner: owner(exec), signal: exec.signal });
        const app = appFrom(method, args);
        if (app) approvedApps.add(`${owner(exec)}:${app.toLowerCase()}`);
        return modelResult(result);
      },
    });
    ctx.tools.register(tool);
  }
  ctx.systemPrompt.section({ name: 'computer-use:cpuse', order: ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE'), text: guidance });
  ctx.on('tools/execute', async (exec, next) => {
    if (!toolNames.has(exec.name)) return next();
    const upstream = exec.signal;
    exec.signal = AbortSignal.any([upstream, lifetime.signal]);
    const operation = Promise.resolve().then(next);
    pending.add(operation);
    try { return await operation; }
    finally { pending.delete(operation); exec.signal = upstream; }
  });
}
