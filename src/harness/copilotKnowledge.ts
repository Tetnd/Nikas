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
const DEFAULT_CATALOG: Record<string, ToolKnowledge> = {
    read_file: {
        category: 'file',
        enrichedDescription: 'Read the contents of a file from the workspace. Prefer targeted reads over dumping whole large files; you can read a specific line range.',
        whenToUse: 'Use to inspect a file before editing it, or to confirm what code exists.',
    },
    edit_file: {
        category: 'edit',
        enrichedDescription: 'Apply an edit to a file. Returns whether the change applied.',
        whenToUse: 'Use to modify code. Prefer small, targeted edits over rewriting the whole file.',
        caution: 'Changes are real and persistent — do not make edits you are not confident about.',
    },
    replace_string_in_file: {
        category: 'edit',
        enrichedDescription: 'Replace an exact literal block of text in a file with new text. Requires the old text to match exactly (including whitespace).',
        whenToUse: 'Use for surgical, exact edits. Include enough surrounding context to make the match unique.',
    },
    multi_replace_string_in_file: {
        category: 'edit',
        enrichedDescription: 'Apply multiple exact-block replacements across one or more files in a single call.',
        whenToUse: 'Use when you need several related edits at once — batch them for efficiency.',
    },
    grep_search: {
        category: 'search',
        enrichedDescription: 'Search the workspace for files or lines matching a regex/string. Returns file paths and matches.',
        whenToUse: 'Use to locate where a symbol, string, or pattern lives before editing.',
    },
    file_search: {
        category: 'search',
        enrichedDescription: 'Find files by name/glob pattern across the workspace.',
        whenToUse: 'Use to discover files by path pattern.',
    },
    run_in_terminal: {
        category: 'terminal',
        enrichedDescription: 'Run a shell command in the workspace terminal and return its output. This is how you build, run tests, or execute scripts.',
        whenToUse: 'Use to build, run tests, run the app, or execute shell commands to verify behavior.',
        caution: 'Commands have real side effects (they run in the actual terminal). Prefer read-only commands when you only need information.',
    },
    run_tests: {
        category: 'terminal',
        enrichedDescription: 'Run the project test suite and return the result.',
        whenToUse: 'Use after making changes to verify you did not break anything (a verify pass).',
    },
    open_browser_page: {
        category: 'browser',
        enrichedDescription: 'Open a browser page at a URL. Grants access to web content and (with the browser tools) interactive page control.',
        whenToUse: 'Use when the task involves a web page, a local UI, or fetching a live site.',
    },
    navigate_page: {
        category: 'browser',
        enrichedDescription: 'Navigate the current browser page (by URL, back, forward, or reload).',
        whenToUse: 'Use to move around a page or reload after a change.',
    },
    click_element: {
        category: 'browser',
        enrichedDescription: 'Click an element on the current browser page (identified by selector or element reference).',
        whenToUse: 'Use to interact with a live UI — buttons, links, toggles.',
    },
    type_in_page: {
        category: 'browser',
        enrichedDescription: 'Type text or press keys into the focused element / page.',
        whenToUse: 'Use to fill inputs or send keystrokes in a live UI.',
    },
    read_page: {
        category: 'browser',
        enrichedDescription: 'Get an accessibility snapshot of the current browser page (better than a screenshot for understanding structure).',
        whenToUse: 'Use to understand what is on the page before acting on it.',
    },
    screenshot_page: {
        category: 'browser',
        enrichedDescription: 'Capture a screenshot of the current browser page.',
        whenToUse: 'Use to visually confirm layout or rendering.',
    },
    open_page: {
        category: 'browser',
        enrichedDescription: 'Open a browser page at a URL.',
        whenToUse: 'Use when the task involves a web page or a local UI.',
    },
    read_page_state: {
        category: 'browser',
        enrichedDescription: 'Get the current browser page state snapshot.',
        whenToUse: 'Use to inspect a page before interacting.',
    },
    get_task_output: {
        category: 'terminal',
        enrichedDescription: 'Retrieve the output of a previously run task/command.',
        whenToUse: 'Use to check the result of a long-running background command.',
    },
    create_file: {
        category: 'edit',
        enrichedDescription: 'Create a new file with the given content. Creates parent directories as needed.',
        whenToUse: 'Use to scaffold new files, modules, or configs.',
    },
    list_dir: {
        category: 'search',
        enrichedDescription: 'List the contents of a directory to see its files and subfolders.',
        whenToUse: 'Use to understand a project structure before navigating deeper.',
    },
    get_errors: {
        category: 'diagnostics',
        enrichedDescription: 'Retrieve compile or lint errors for a file (or across the workspace).',
        whenToUse: 'Use after edits to check for type/compile/lint errors and drive fixes.',
    },
    fetch_webpage: {
        category: 'web',
        enrichedDescription: 'Fetch and summarize the main content of a web page or URL.',
        whenToUse: 'Use to read documentation, articles, or reference material from the web.',
    },
    web_search: {
        category: 'web',
        enrichedDescription: 'Search the web for information and return results with content.',
        whenToUse: 'Use to find current information, docs, or solutions online.',
    },
    fetch: {
        category: 'web',
        enrichedDescription: 'Fetch the content of a URL.',
        whenToUse: 'Use to retrieve web content or an API endpoint.',
    },
    github_repo_search: {
        category: 'web',
        enrichedDescription: 'Search a GitHub repository for relevant source code snippets.',
        whenToUse: 'Use to find code examples or implementations in a public repo.',
    },
    github_text_search: {
        category: 'web',
        enrichedDescription: 'Lexically search a GitHub repo or org for files containing keywords or code patterns.',
        whenToUse: 'Use to locate exact strings or identifiers in a GitHub codebase.',
    },
    create_new_jupyter_notebook: {
        category: 'notebook',
        enrichedDescription: 'Generate a new Jupyter Notebook (.ipynb) in the workspace.',
        whenToUse: 'Use when the task is data exploration/analysis and a notebook is appropriate.',
    },
    run_notebook_cell: {
        category: 'notebook',
        enrichedDescription: 'Run a code cell in a notebook file and return its output.',
        whenToUse: 'Use to execute notebook code and inspect results.',
    },
    create_new_workspace: {
        category: 'project',
        enrichedDescription: 'Set up a complete new project structure/workspace scaffold.',
        whenToUse: 'Use when initializing a new project or framework.',
    },
    manage_todo_list: {
        category: 'task',
        enrichedDescription: 'Track progress on a multi-step task via a structured todo list.',
        whenToUse: 'Use for complex multi-step work to keep the plan visible and ordered.',
    },
    run_in_terminal_bg: {
        category: 'terminal',
        enrichedDescription: 'Run a long-lived process (server, watcher, daemon) in the background.',
        whenToUse: 'Use to start servers or watch tasks that must keep running.',
    },
    get_terminal_output: {
        category: 'terminal',
        enrichedDescription: 'Read output from a background terminal execution.',
        whenToUse: 'Use to check a running background command\'s output.',
    },
    kill_terminal: {
        category: 'terminal',
        enrichedDescription: 'Stop a running terminal/task by its id.',
        whenToUse: 'Use to clean up servers or background processes when done.',
    },
    run_command: {
        category: 'terminal',
        enrichedDescription: 'Execute a shell command and return its output.',
        whenToUse: 'Use to build, run, or inspect via the shell.',
    },
    apply_patch: {
        category: 'edit',
        enrichedDescription: 'Apply a patch or diff to the workspace.',
        whenToUse: 'Use to apply a set of changes provided as a patch.',
    },
    git_status: {
        category: 'git',
        enrichedDescription: 'Show the current git working-tree status.',
        whenToUse: 'Use to see what files changed before committing.',
    },
    git_diff: {
        category: 'git',
        enrichedDescription: 'Show the diff of changes in the working tree.',
        whenToUse: 'Use to review changes before committing.',
    },
    git_commit: {
        category: 'git',
        enrichedDescription: 'Create a git commit with the staged changes.',
        whenToUse: 'Use after finishing a logical unit of work.',
        caution: 'Commits are real history — use a clear, descriptive message.',
    },
    git_push: {
        category: 'git',
        enrichedDescription: 'Push local commits to the remote branch.',
        whenToUse: 'Use when the user asks to push or publish work.',
    },
    read_notebook_cell_output: {
        category: 'notebook',
        enrichedDescription: 'Retrieve the output of a notebook cell from its last execution.',
        whenToUse: 'Use to inspect notebook results without re-running.',
    },
    get_vscode_api: {
        category: 'diagnostics',
        enrichedDescription: 'Get VS Code API documentation/references for extension development.',
        whenToUse: 'Use when building or debugging VS Code extension code.',
    },
    memory: {
        category: 'task',
        enrichedDescription: 'Manage persistent notes/memory across sessions (user/session/repo scopes).',
        whenToUse: 'Use to save and retrieve cross-session context and conventions.',
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
