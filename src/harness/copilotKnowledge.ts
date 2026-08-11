/**
 * Copilot "knowledge" for DeepSeek.
 *
 * When DeepSeek runs inside Copilot Chat via a BYOK provider, it only learns
 * about Copilot's native toolset through TWO channels we control:
 *   1. the tool SCHEMAS we send (name / description / parameters), and
 *   2. the SYSTEM PROMPT / instructions we inject.
 *
 * Copilot's own models get rich conditioning about their environment natively;
 * DeepSeek gets terse machine-oriented tool descriptions and a mostly-empty
 * system prompt. This module closes that gap WITHOUT replacing Copilot's loop
 * (so we keep native browser control, dev tools, workspace, terminal, etc.):
 *
 *   - `ToolKnowledgeCatalog`: tool name → { category, enrichedDescription,
 *     whenToUse, caution }. Used to enrich the `description` we send, so
 *     DeepSeek understands what each Copilot tool does and when to call it.
 *   - `augmentToolDescription(name, original)`: returns a richer description
 *     when the catalog has knowledge, else the original (safe fallback).
 *   - `buildCopilotOperatingGuide()`: a compact, injection-ready system-prompt
 *     block teaching DeepSeek the META of Copilot's environment (the agent
 *     loop, structured tool-result framing, when to use each native
 *     capability). Mirrors how `CONCISE_PROMPT_DIRECTIVE` is injected.
 *
 * Reuses the harness vocabulary (categories, tool catalog, structured-result
 * framing) but is a pure, dependency-free module so it's testable in Node.
 */

/** A piece of Copilot knowledge for one tool. */
export interface ToolKnowledge {
    /** Human category, e.g. 'browser' | 'file' | 'terminal' | 'search' | 'edit'. */
    category: string;
    /** Enriched description of what the tool does. */
    enrichedDescription: string;
    /** When to prefer this tool (a short hint for the model). */
    whenToUse: string;
    /** Optional caution (e.g. destructive operations, side effects). */
    caution?: string;
}

/**
 * Default knowledge catalog for common Copilot native tools. Keys are the
 * tool names Copilot exposes via `options.tools`. Anything not in the catalog
 * is passed through unchanged — the catalog is an additive improvement.
 */
/**
 * Default knowledge catalog for Copilot's NATIVE tools. Keys are the EXACT
 * tool names Copilot exposes to the default agent via `options.tools` — taken
 * from the live "Configure Tools" list (Built-In / vscode / web / container
 * groups). Anything not in the catalog passes through unchanged.
 *
 * NOTE: these are camelCase names (`edit`, `search`, `runInTerminal`), NOT
 * the agent-harness snake_case names (`edit_file`, `grep_search`). The lookup
 * in `mapTool` uses `tool.name`, which is the native Copilot name.
 */
const DEFAULT_CATALOG: Record<string, ToolKnowledge> = {
    // ── Built-In: file read / edit ──────────────────────────────────────
    read: {
        category: 'file',
        enrichedDescription: 'Read files in the workspace. Prefer targeted reads over dumping whole large files; you can read a specific line range.',
        whenToUse: 'Use to inspect a file before editing it, or to confirm what code exists.',
    },
    readFile: {
        category: 'file',
        enrichedDescription: 'Read the contents of a specific file from the workspace.',
        whenToUse: 'Use to inspect a file\'s contents before editing or to confirm what code exists.',
    },
    viewImage: {
        category: 'file',
        enrichedDescription: 'View the contents of an image file directly (png/jpg/gif/webp).',
        whenToUse: 'Use to look at a screenshot, diagram, or image asset the task references.',
    },
    edit: {
        category: 'edit',
        enrichedDescription: 'Edit files in the workspace. Applies one or more changes to file content.',
        whenToUse: 'Use to modify code. Prefer small, targeted edits over rewriting whole files.',
        caution: 'Changes are real and persistent — do not make edits you are not confident about.',
    },
    editFiles: {
        category: 'edit',
        enrichedDescription: 'Edit one or more files in the workspace.',
        whenToUse: 'Use to apply code changes to one or several files.',
        caution: 'Changes are real and persistent — do not make edits you are not confident about.',
    },
    createFile: {
        category: 'edit',
        enrichedDescription: 'Create a new file in the workspace. Creates parent directories as needed.',
        whenToUse: 'Use to scaffold new files, modules, or configs.',
    },
    createDirectory: {
        category: 'edit',
        enrichedDescription: 'Create a new directory (recursively if needed) in the workspace.',
        whenToUse: 'Use to create folders for a new module or structure.',
    },
    rename: {
        category: 'edit',
        enrichedDescription: 'Rename a code symbol across the workspace, updating all references.',
        whenToUse: 'Use to rename a function/class/variable precisely across the whole project.',
    },

    // ── Built-In: search ────────────────────────────────────────────────
    search: {
        category: 'search',
        enrichedDescription: 'Search files in the workspace for content matching a pattern.',
        whenToUse: 'Use to locate where a symbol, string, or pattern lives before editing.',
    },
    textSearch: {
        category: 'search',
        enrichedDescription: 'Lexically search workspace files for text or regex matches.',
        whenToUse: 'Use to find exact strings or patterns across the codebase.',
    },
    fileSearch: {
        category: 'search',
        enrichedDescription: 'Find files by name or glob pattern across the workspace.',
        whenToUse: 'Use to discover files by path pattern.',
    },
    codebase: {
        category: 'search',
        enrichedDescription: 'Semantic search across the codebase for relevant file chunks, symbols, and information.',
        whenToUse: 'Use to understand what code exists and where, when you do not know exact names.',
    },
    listDirectory: {
        category: 'search',
        enrichedDescription: 'List the contents of a directory to see its files and subfolders.',
        whenToUse: 'Use to understand a project structure before navigating deeper.',
    },
    usages: {
        category: 'search',
        enrichedDescription: 'Find all usages, references, and implementations of a code symbol across the workspace.',
        whenToUse: 'Use to see everywhere a symbol is referenced before refactoring or changing it.',
    },
    searchSubagent: {
        category: 'search',
        enrichedDescription: 'Dispatch a search subagent to explore the codebase and answer questions.',
        whenToUse: 'Use for broad exploration when you need to gather context across many files.',
    },
    problems: {
        category: 'diagnostics',
        enrichedDescription: 'Check compile or lint errors for a particular file (or the workspace).',
        whenToUse: 'Use after edits to check for type/compile/lint errors and drive fixes.',
    },

    // ── Built-In: terminal / execute ────────────────────────────────────
    runInTerminal: {
        category: 'terminal',
        enrichedDescription: 'Run a shell command in the workspace terminal and return its output. This is how you build, run tests, or execute scripts.',
        whenToUse: 'Use to build, run tests, run the app, or execute shell commands to verify behavior.',
        caution: 'Commands have real side effects (they run in the actual terminal). Prefer read-only commands when you only need information.',
    },
    execute: {
        category: 'terminal',
        enrichedDescription: 'Execute code and applications on the machine.',
        whenToUse: 'Use to run code, scripts, or applications.',
        caution: 'Executions have real side effects — prefer read-only commands when you only need information.',
    },
    runCommand: {
        category: 'terminal',
        enrichedDescription: 'Run a command in the terminal and return its output.',
        whenToUse: 'Use to build, run, or inspect via the shell.',
    },
    runTests: {
        category: 'terminal',
        enrichedDescription: 'Run the project test suite (optionally with coverage) and return results.',
        whenToUse: 'Use after making changes to verify you did not break anything (a verify pass).',
    },
    runTask: {
        category: 'terminal',
        enrichedDescription: 'Run a defined VS Code task from the workspace.',
        whenToUse: 'Use to run an existing build/run/test task.',
    },
    createAndRunTask: {
        category: 'terminal',
        enrichedDescription: 'Create and run a build/run/custom task for the workspace.',
        whenToUse: 'Use to build or run the app when no task exists yet.',
    },
    getTaskOutput: {
        category: 'terminal',
        enrichedDescription: 'Retrieve the output of a previously run task.',
        whenToUse: 'Use to check the result of a background or long-running task.',
    },
    sendToTerminal: {
        category: 'terminal',
        enrichedDescription: 'Send input text (or a keystroke) to an active terminal execution.',
        whenToUse: 'Use to answer interactive prompts or continue an in-progress command.',
    },
    getTerminalOutput: {
        category: 'terminal',
        enrichedDescription: 'Read output from a background terminal execution by its id.',
        whenToUse: 'Use to check a running background command\'s output.',
    },
    terminalLastCommand: {
        category: 'terminal',
        enrichedDescription: 'Get the last command that was run in the active terminal.',
        whenToUse: 'Use to see what command previously ran.',
    },
    terminalSelection: {
        category: 'terminal',
        enrichedDescription: 'Get the current selection in the active terminal.',
        whenToUse: 'Use to read text selected in the terminal.',
    },
    killTerminal: {
        category: 'terminal',
        enrichedDescription: 'Kill/stop a terminal execution by its id.',
        whenToUse: 'Use to clean up servers or background processes when done.',
    },
    testFailure: {
        category: 'diagnostics',
        enrichedDescription: 'Include the details of test failures from the most recent test run.',
        whenToUse: 'Use when a test failed to understand exactly what broke and where.',
    },

    // ── Built-In: browser ───────────────────────────────────────────────
    browser: {
        category: 'browser',
        enrichedDescription: 'Open and interact with integrated browser pages in the IDE.',
        whenToUse: 'Use when the task involves a web page, a local UI, or fetching a live site.',
    },
    openBrowserPage: {
        category: 'browser',
        enrichedDescription: 'Open a browser page at a URL (or share an existing one).',
        whenToUse: 'Use to open a web page or local UI for inspection.',
    },
    navigatePage: {
        category: 'browser',
        enrichedDescription: 'Navigate the current browser page (by URL, back, forward, or reload).',
        whenToUse: 'Use to move around a page or reload after a change.',
    },
    readPage: {
        category: 'browser',
        enrichedDescription: 'Get an accessibility snapshot of the current browser page (better than a screenshot for understanding structure).',
        whenToUse: 'Use to understand what is on the page before acting on it.',
    },
    screenshotPage: {
        category: 'browser',
        enrichedDescription: 'Capture a screenshot of the current browser page.',
        whenToUse: 'Use to visually confirm layout or rendering.',
    },
    clickElement: {
        category: 'browser',
        enrichedDescription: 'Click an element on the current browser page (by selector or element reference).',
        whenToUse: 'Use to interact with a live UI — buttons, links, toggles.',
    },
    typeInPage: {
        category: 'browser',
        enrichedDescription: 'Type text or press keys into the focused element/page.',
        whenToUse: 'Use to fill inputs or send keystrokes in a live UI.',
    },
    hoverElement: {
        category: 'browser',
        enrichedDescription: 'Hover over an element in the browser page to reveal tooltips/menus.',
        whenToUse: 'Use to trigger hover states before acting.',
    },
    dragElement: {
        category: 'browser',
        enrichedDescription: 'Drag an element from one position/target to another in the browser page.',
        whenToUse: 'Use to move elements or test drag-and-drop interactions.',
    },
    handleDialog: {
        category: 'browser',
        enrichedDescription: 'Respond to a pending modal (alert/confirm/prompt) or file-chooser dialog on the page.',
        whenToUse: 'Use when the page shows a dialog that needs accepting/dismissing.',
    },
    runPlaywrightCode: {
        category: 'browser',
        enrichedDescription: 'Run a Playwright code snippet to control the browser page directly.',
        whenToUse: 'Use for advanced browser control when the higher-level browser tools are insufficient.',
    },

    // ── Built-In: notebook ──────────────────────────────────────────────
    createJupyterNotebook: {
        category: 'notebook',
        enrichedDescription: 'Create a new Jupyter Notebook (.ipynb) in the workspace.',
        whenToUse: 'Use when the task is data exploration/analysis and a notebook is appropriate.',
    },
    runNotebookCell: {
        category: 'notebook',
        enrichedDescription: 'Execute a code cell in a notebook file and return its output.',
        whenToUse: 'Use to run notebook code and inspect results.',
    },
    editNotebook: {
        category: 'notebook',
        enrichedDescription: 'Edit a cell (or insert/delete) in a notebook file.',
        whenToUse: 'Use to modify notebook code or structure.',
    },
    getNotebookSummary: {
        category: 'notebook',
        enrichedDescription: 'Return the list of notebook cells with ids, types, line ranges, language, and execution info.',
        whenToUse: 'Use to understand a notebook\'s structure before running or editing cells.',
    },
    readNotebookCellOutput: {
        category: 'notebook',
        enrichedDescription: 'Retrieve the output of a notebook cell from its last execution.',
        whenToUse: 'Use to inspect notebook results without re-running.',
    },

    // ── Built-In: task ──────────────────────────────────────────────────
    todo: {
        category: 'task',
        enrichedDescription: 'Track progress on a multi-step task via a structured todo list.',
        whenToUse: 'Use for complex multi-step work to keep the plan visible and ordered.',
    },

    // ── vscode group ────────────────────────────────────────────────────
    vscode: {
        category: 'vscode',
        enrichedDescription: 'Run a VS Code command / interact with the VS Code API surface.',
        whenToUse: 'Use when the task involves VS Code commands or extension behavior.',
    },
    vscodeAPI: {
        category: 'vscode',
        enrichedDescription: 'Get VS Code API documentation and references for extension development.',
        whenToUse: 'Use when building or debugging VS Code extension code.',
    },
    askQuestions: {
        category: 'vscode',
        enrichedDescription: 'Ask the user a small number of clarifying questions before proceeding.',
        whenToUse: 'Use when a task is ambiguous and a decision from the user would unblock correct work.',
    },
    installExtension: {
        category: 'vscode',
        enrichedDescription: 'Install a VS Code extension as part of a new workspace setup.',
        whenToUse: 'Use when scaffolding a project that needs specific extensions.',
    },
    extensions: {
        category: 'vscode',
        enrichedDescription: 'Search the VS Code extension marketplace and retrieve extension information.',
        whenToUse: 'Use to find or inspect extensions.',
    },
    newWorkspace: {
        category: 'project',
        enrichedDescription: 'Set up a complete new project structure/workspace scaffold.',
        whenToUse: 'Use when initializing a new project or framework.',
    },
    resolveMemoryFileUri: {
        category: 'vscode',
        enrichedDescription: 'Resolve a memory-file path to its fully qualified URI.',
        whenToUse: 'Use when you need the actual URI of a memory/note file.',
    },
    memory: {
        category: 'task',
        enrichedDescription: 'Manage persistent notes/memory across sessions (user/session/repo scopes).',
        whenToUse: 'Use to save and retrieve cross-session context and conventions.',
    },

    // ── web group ───────────────────────────────────────────────────────
    web: {
        category: 'web',
        enrichedDescription: 'Fetch, search, and extract content from the web.',
        whenToUse: 'Use to find current information, docs, or solutions online.',
    },
    fetch: {
        category: 'web',
        enrichedDescription: 'Fetch and summarize the main content of a web page or URL.',
        whenToUse: 'Use to read documentation, articles, or reference material from the web.',
    },
    githubRepo: {
        category: 'web',
        enrichedDescription: 'Search a GitHub repository for relevant source code snippets.',
        whenToUse: 'Use to find code examples or implementations in a public repo.',
    },
    githubTextSearch: {
        category: 'web',
        enrichedDescription: 'Lexically search a GitHub repo or org for files containing keywords or code patterns.',
        whenToUse: 'Use to locate exact strings or identifiers in a GitHub codebase.',
    },

    // ── container group ─────────────────────────────────────────────────
    containerToolsConfig: {
        category: 'container',
        enrichedDescription: 'Get the container/orchestrator CLI configuration, including the correct base commands and environment.',
        whenToUse: 'Use before running any container or compose command, to get the right base command.',
    },
};

/**
 * Return an enriched description for a tool when the catalog has knowledge,
 * else the original description unchanged (safe fallback).
 */
export function augmentToolDescription(name: string, original: string): string {
    const k = DEFAULT_CATALOG[name];
    if (!k) return original;
    const parts = [k.enrichedDescription];
    if (k.whenToUse) parts.push(`When to use: ${k.whenToUse}`);
    if (k.caution) parts.push(`Caution: ${k.caution}`);
    return parts.join(' ');
}

/** Return the catalog entry for a tool, if any. */
export function getToolKnowledge(name: string): ToolKnowledge | undefined {
    return DEFAULT_CATALOG[name];
}

/** The categories covered by the knowledge catalog. */
export function knownCategories(): string[] {
    return Array.from(new Set(Object.values(DEFAULT_CATALOG).map(k => k.category)));
}

/** Group a list of tool names by their catalog category (unknown → 'other'). */
export function categorizeTools(names: string[]): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const n of names) {
        const cat = DEFAULT_CATALOG[n]?.category ?? 'other';
        (out[cat] ??= []).push(n);
    }
    return out;
}

/**
 * Build a compact, injection-ready "Copilot operating guide" for the system
 * prompt. Teaches DeepSeek the meta of the Copilot agent environment so it
 * uses the native tools well. Keep it terse — it costs tokens every request.
 */
export function buildCopilotOperatingGuide(): string {
    return (
        'You are running inside VS Code Copilot Chat as a coding agent. Copilot exposes a rich native toolset ' +
        '(file read/edit, workspace search, terminal, and a live browser with page control and dev tools). ' +
        'Tool results come back framed as [tool NAME: STATUS] with OK or ERROR — treat ERROR as a failure to fix, not to ignore. ' +
        'Follow these Copilot-environment rules:\n' +
        '• To understand code before editing: use search/read tools; gather context first, then act.\n' +
        '• To modify code: prefer targeted edit tools over rewriting whole files.\n' +
        '• To build/verify: use the terminal (run build/tests) after edits; confirm the result.\n' +
        '• If the task involves a live UI or a web page: use the browser tools (open, read page, click, type) and the page snapshot to inspect before acting.\n' +
        '• Batch independent read-only calls together; do not repeat work already done.\n' +
        '• When finished, give a concise final result. Do not stop at analysis — complete the task end-to-end.'
    );
}
