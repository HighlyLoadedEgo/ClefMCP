#!/usr/bin/env node
import { ClefError, errorJson, exitCodeFor } from '../clef/errors.js';
import { createClefServer } from '../mcp/server.js';
import { loadConfig } from '../config/env.js';
import { createLogger } from '../config/logger.js';
import { startDaemon } from '../daemon/daemon.js';
import { Command } from 'commander';
import { runDecide, type DecideOptions } from './decide.js';
import { runDoctor, type DoctorOptions } from './doctor.js';
import { runEvals, type EvalsOptions } from './evals.js';
import { runInstall, type InstallOptions } from './install.js';
import { runModels } from './models-cmd.js';
import { runSetup, type SetupOptions } from './setup.js';
import { runStatus } from './status.js';
import { runUninstall, type UninstallOptions } from './uninstall.js';
import { VERSION } from '../version.js';

function handleCliError(err: unknown): never {
  const structured = errorJson(err);
  // CLI errors go to stderr; stdout stays clean for scripting.
  console.error(`error: [${structured.error.code}] ${structured.error.message}`);
  if (structured.error.hint) console.error(`hint: ${structured.error.hint}`);
  process.exit(exitCodeFor(err));
}

const program = new Command();

program
  .name('clef-mcp')
  .description('Local MCP server for the Clef decision model (structured decisions, probability outputs).')
  .version(VERSION);

program.action(async () => {
  // Default action: run the MCP server on stdio. stdout is reserved for the
  // MCP protocol; logs go to stderr. Never downloads anything (see install).
  try {
    const config = loadConfig();
    const running = createClefServer({ config, version: VERSION });
    await running.start();
  } catch (err) {
    handleCliError(err);
  }
});

program
  .command('decide')
  .description('One-shot decision (no MCP session): JSON in, strict JSON result out. For hooks, CI and scripts.')
  .option('--state <source>', 'state: file path, "-" for stdin, or inline JSON/text')
  .option('--questions <source>', 'questions map: file path, "-" for stdin, or inline JSON')
  .option('--model <id>', 'model to use (default: CLEF_MODEL or clef-flash)')
  .option('--daemon', 'route through a running `clef-mcp daemon` (falls back to a cold run when none is reachable)')
  .action(async (opts: DecideOptions) => {
    try {
      await runDecide(opts);
      process.exit(0);
    } catch (err) {
      handleCliError(err);
    }
  });

program
  .command('daemon')
  .description('Keep the model warm and answer decide requests on a local unix socket in CLEF_HOME (used by decide --daemon).')
  .action(async () => {
    try {
      const config = loadConfig();
      const log = createLogger(config.logLevel);
      const daemon = startDaemon(config, log);
      await daemon.ready;
      // The socket server keeps the process alive; nothing else to do here.
    } catch (err) {
      handleCliError(err);
    }
  });

program
  .command('install')
  .description('Detect the machine, download a Clef model + runtime, verify checksum and inference.')
  .option('--model <id>', 'model to install (default: clef-flash)')
  .option('--quant <id>', 'quantization override: Q4_K_M | Q8_0 | BF16')
  .option('-y, --yes', 'assume yes for all prompts (non-interactive)')
  .option('--skip-runtime', 'do not download/verify the llama.cpp runtime')
  .option('--skip-probe', 'skip the post-install inference verification')
  .option('--runtime <id>', 'inference runtime: llama-cpp (default) | mlx (Apple Silicon)')
  .option('--setup', 'also register the MCP server + agent skill in detected clients (same as running `clef-mcp setup`)')
  .action(async (opts: InstallOptions) => {
    try {
      await runInstall(opts);
    } catch (err) {
      handleCliError(err);
    }
  });

program
  .command('setup')
  .description('Register the MCP server + agent skill in your clients (zcode, claude-code, codex, cursor).')
  .option('--clients <list>', 'comma-separated subset: zcode,claude-code,codex,cursor (default: all)')
  .option('--skill', 'install the agent skill (default)')
  .option('--no-skill', 'do not touch the agent skill')
  .option('-y, --yes', 'assume yes for all prompts (non-interactive)')
  .action(async (opts: SetupOptions) => {
    try {
      await runSetup(opts);
    } catch (err) {
      handleCliError(err);
    }
  });

program
  .command('models')
  .description('List known Clef models, quantizations and install status.')
  .action(async () => {
    try {
      await runModels();
    } catch (err) {
      handleCliError(err);
    }
  });

program
  .command('status')
  .description('Show runtime, model and memory status.')
  .action(async () => {
    try {
      await runStatus();
    } catch (err) {
      handleCliError(err);
    }
  });

program
  .command('doctor')
  .description('Diagnose platform, runtime, model, checksum, inference and MCP configuration.')
  .option('--deep', 're-verify model checksum (hashes the full model file)')
  .option('--json', 'machine-readable output')
  .action(async (opts: DoctorOptions) => {
    try {
      const failed = await runDoctor(opts);
      process.exit(failed ? 1 : 0);
    } catch (err) {
      handleCliError(err);
    }
  });

program
  .command('uninstall')
  .description('Remove the installed model (and optionally the managed runtime).')
  .option('--model <id>', 'model to remove (default: CLEF_MODEL or clef-flash)')
  .option('--runtime', 'also remove the managed llama.cpp runtime')
  .option('-y, --yes', 'assume yes for all prompts (non-interactive)')
  .action(async (opts: UninstallOptions) => {
    try {
      await runUninstall(opts);
    } catch (err) {
      handleCliError(err);
    }
  });

program
  .command('evals')
  .description('Run the evaluation dataset against the installed model.')
  .option('--dataset <path>', 'path to a dataset.jsonl (default: bundled eval dataset)')
  .option('--limit <n>', 'limit the number of cases', Number.parseInt)
  .option('--min-rate <r>', 'minimum pass rate, 0..1 (default 0.8)', Number.parseFloat)
  .action(async (opts: EvalsOptions) => {
    try {
      const passed = await runEvals(opts);
      process.exit(passed ? 0 : 1);
    } catch (err) {
      if (err instanceof ClefError) handleCliError(err);
      handleCliError(err);
    }
  });

program.parseAsync(process.argv).catch(handleCliError);
