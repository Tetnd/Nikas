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
    /** Optional "prefer X over Y" guidance — when this tool beats an alternative. */
    prefer?: string;
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
        prefer: 'Prefer targeted line-range reads over dumping an entire large file.',
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
        prefer: 'Prefer targeted edits (edit / replace_string) over rewriting an entire file.',
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
        prefer: 'Prefer search/grep over reading many files to find a symbol or string.',
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
        prefer: 'For test runs prefer the dedicated runTests/run_task tool over a hand-typed command.',
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

    // ═══════════════════════════════════════════════════════════════════
    //  SNAKE_CASE COPILOT-AGENT TOOLSET (from the Copilot bundle)
    //  Copilot's agent loop also exposes snake_case tool names. Both the
    //  camelCase built-ins above AND these appear in `options.tools`; the
    //  catalog keys on whichever name the provider receives, so cover both.
    // ═══════════════════════════════════════════════════════════════════

    // ── file read / write ──────────────────────────────────────────────
    read_file: {
        category: 'file',
        enrichedDescription: 'Read the contents of a file from the workspace. Prefer targeted reads over dumping whole large files; you can read a specific line range.',
        whenToUse: 'Use to inspect a file before editing it, or to confirm what code exists.',
    },
    view_image: {
        category: 'file',
        enrichedDescription: 'View the contents of an image file directly (png/jpg/gif/webp).',
        whenToUse: 'Use to look at a screenshot, diagram, or image asset the task references.',
    },
    write_file: {
        category: 'edit',
        enrichedDescription: 'Write content to a file (create or overwrite) in the workspace.',
        whenToUse: 'Use to create or fully rewrite a file.',
        caution: 'Overwrites existing content — do not clobber a file you have not read.',
        prefer: 'Prefer targeted edits over a full rewrite unless the whole file changes.',
    },
    edit_files: {
        category: 'edit',
        enrichedDescription: 'Edit one or more files in the workspace.',
        whenToUse: 'Use to apply code changes to one or several files.',
        caution: 'Changes are real and persistent — do not make edits you are not confident about.',
    },
    create_file: {
        category: 'edit',
        enrichedDescription: 'Create a new file in the workspace. Creates parent directories as needed.',
        whenToUse: 'Use to scaffold new files, modules, or configs.',
    },
    create_directory: {
        category: 'edit',
        enrichedDescription: 'Create a new directory (recursively if needed) in the workspace.',
        whenToUse: 'Use to create folders for a new module or structure.',
    },
    apply_patch: {
        category: 'edit',
        enrichedDescription: 'Apply a patch or diff to the workspace.',
        whenToUse: 'Use to apply a set of changes provided as a patch.',
    },
    insert_edit_into_file: {
        category: 'edit',
        enrichedDescription: 'Insert an edit into a file at a specified location.',
        whenToUse: 'Use to make a targeted insertion into existing file content.',
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

    // ── search / inspect ───────────────────────────────────────────────
    file_search: {
        category: 'search',
        enrichedDescription: 'Find files by name or glob pattern across the workspace.',
        whenToUse: 'Use to discover files by path pattern.',
    },
    grep_search: {
        category: 'search',
        enrichedDescription: 'Search the workspace for files or lines matching a regex/string. Returns file paths and matches.',
        whenToUse: 'Use to locate where a symbol, string, or pattern lives before editing.',
    },
    text_search: {
        category: 'search',
        enrichedDescription: 'Lexically search workspace files for text or regex matches.',
        whenToUse: 'Use to find exact strings or patterns across the codebase.',
    },
    semantic_search: {
        category: 'search',
        enrichedDescription: 'Semantic search across the codebase for relevant file chunks, symbols, and information.',
        whenToUse: 'Use to understand what code exists and where, when you do not know exact names.',
    },
    list_dir: {
        category: 'search',
        enrichedDescription: 'List the contents of a directory to see its files and subfolders.',
        whenToUse: 'Use to understand a project structure before navigating deeper.',
    },
    read_project_structure: {
        category: 'search',
        enrichedDescription: 'Read/analyze the overall structure of the project (folders, modules, key files).',
        whenToUse: 'Use to get oriented in an unfamiliar codebase.',
    },
    search_workspace_symbols: {
        category: 'search',
        enrichedDescription: 'Search the workspace for symbols (functions, classes, variables) by name.',
        whenToUse: 'Use to jump to a definition or find where a symbol is declared.',
    },
    get_changed_files: {
        category: 'search',
        enrichedDescription: 'List the files that have changed (e.g. in the working tree or recent edits).',
        whenToUse: 'Use to see what was modified before reviewing or committing.',
    },
    get_errors: {
        category: 'diagnostics',
        enrichedDescription: 'Retrieve compile or lint errors for a file (or across the workspace).',
        whenToUse: 'Use after edits to check for type/compile/lint errors and drive fixes.',
    },

    // ── terminal / execute ─────────────────────────────────────────────
    run_in_terminal: {
        category: 'terminal',
        enrichedDescription: 'Run a shell command in the workspace terminal and return its output. This is how you build, run tests, or execute scripts.',
        whenToUse: 'Use to build, run tests, run the app, or execute shell commands to verify behavior.',
        caution: 'Commands have real side effects (they run in the actual terminal). Prefer read-only commands when you only need information.',
    },
    send_to_terminal: {
        category: 'terminal',
        enrichedDescription: 'Send input text (or a keystroke) to an active terminal execution.',
        whenToUse: 'Use to answer interactive prompts or continue an in-progress command.',
    },
    get_terminal_output: {
        category: 'terminal',
        enrichedDescription: 'Read output from a background terminal execution by its id.',
        whenToUse: 'Use to check a running background command\'s output.',
    },
    kill_terminal: {
        category: 'terminal',
        enrichedDescription: 'Kill/stop a terminal execution by its id.',
        whenToUse: 'Use to clean up servers or background processes when done.',
    },
    terminal_selection: {
        category: 'terminal',
        enrichedDescription: 'Get the current selection in the active terminal.',
        whenToUse: 'Use to read text selected in the terminal.',
    },
    terminal_last_command: {
        category: 'terminal',
        enrichedDescription: 'Get the last command that was run in the active terminal.',
        whenToUse: 'Use to see what command previously ran.',
    },
    get_task_output: {
        category: 'terminal',
        enrichedDescription: 'Retrieve the output of a previously run task/command.',
        whenToUse: 'Use to check the result of a long-running background command.',
    },
    run_tests: {
        category: 'terminal',
        enrichedDescription: 'Run the project test suite and return the result.',
        whenToUse: 'Use after making changes to verify you did not break anything (a verify pass).',
    },
    run_task: {
        category: 'terminal',
        enrichedDescription: 'Run a defined VS Code task from the workspace.',
        whenToUse: 'Use to run an existing build/run/test task.',
    },
    create_and_run_task: {
        category: 'terminal',
        enrichedDescription: 'Create and run a build/run/custom task for the workspace.',
        whenToUse: 'Use to build or run the app when no task exists yet.',
    },
    test_search: {
        category: 'diagnostics',
        enrichedDescription: 'Find tests in the project relevant to the current change.',
        whenToUse: 'Use to locate the tests you should run or update.',
    },

    // ── subagents ──────────────────────────────────────────────────────
    runSubagent: {
        category: 'task',
        enrichedDescription: 'Dispatch a subagent to handle a complex, multi-step task autonomously and return its report.',
        whenToUse: 'Use to delegate research, search, or a well-scoped subtask to a fresh agent.',
    },
    search_subagent: {
        category: 'search',
        enrichedDescription: 'Dispatch a search subagent to explore the codebase and answer questions.',
        whenToUse: 'Use for broad exploration when you need to gather context across many files.',
    },
    explore_subagent: {
        category: 'search',
        enrichedDescription: 'Dispatch a subagent to explore a specific area of the codebase.',
        whenToUse: 'Use to investigate an unfamiliar module or subsystem.',
    },

    // ── browser ────────────────────────────────────────────────────────
    open_browser_page: {
        category: 'browser',
        enrichedDescription: 'Open a browser page at a URL (or share an existing one).',
        whenToUse: 'Use to open a web page or local UI for inspection.',
    },
    navigate_page: {
        category: 'browser',
        enrichedDescription: 'Navigate the current browser page (by URL, back, forward, or reload).',
        whenToUse: 'Use to move around a page or reload after a change.',
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
    click_element: {
        category: 'browser',
        enrichedDescription: 'Click an element on the current browser page (by selector or element reference).',
        whenToUse: 'Use to interact with a live UI — buttons, links, toggles.',
    },
    type_in_page: {
        category: 'browser',
        enrichedDescription: 'Type text or press keys into the focused element/page.',
        whenToUse: 'Use to fill inputs or send keystrokes in a live UI.',
    },
    hover_element: {
        category: 'browser',
        enrichedDescription: 'Hover over an element in the browser page to reveal tooltips/menus.',
        whenToUse: 'Use to trigger hover states before acting.',
    },
    drag_element: {
        category: 'browser',
        enrichedDescription: 'Drag an element from one position/target to another in the browser page.',
        whenToUse: 'Use to move elements or test drag-and-drop interactions.',
    },
    handle_dialog: {
        category: 'browser',
        enrichedDescription: 'Respond to a pending modal (alert/confirm/prompt) or file-chooser dialog on the page.',
        whenToUse: 'Use when the page shows a dialog that needs accepting/dismissing.',
    },
    run_playwright_code: {
        category: 'browser',
        enrichedDescription: 'Run a Playwright code snippet to control the browser page directly.',
        whenToUse: 'Use for advanced browser control when the higher-level browser tools are insufficient.',
    },

    // ── notebook ───────────────────────────────────────────────────────
    create_new_jupyter_notebook: {
        category: 'notebook',
        enrichedDescription: 'Create a new Jupyter Notebook (.ipynb) in the workspace.',
        whenToUse: 'Use when the task is data exploration/analysis and a notebook is appropriate.',
    },
    run_notebook_cell: {
        category: 'notebook',
        enrichedDescription: 'Run a code cell in a notebook file and return its output.',
        whenToUse: 'Use to execute notebook code and inspect results.',
    },
    edit_notebook_file: {
        category: 'notebook',
        enrichedDescription: 'Edit a cell (or insert/delete) in a notebook file.',
        whenToUse: 'Use to modify notebook code or structure.',
    },
    read_notebook_cell_output: {
        category: 'notebook',
        enrichedDescription: 'Retrieve the output of a notebook cell from its last execution.',
        whenToUse: 'Use to inspect notebook results without re-running.',
    },
    copilot_getNotebookSummary: {
        category: 'notebook',
        enrichedDescription: 'Return the list of notebook cells with ids, types, line ranges, language, and execution info.',
        whenToUse: 'Use to understand a notebook\'s structure before running or editing cells.',
    },

    // ── web ────────────────────────────────────────────────────────────
    fetch_webpage: {
        category: 'web',
        enrichedDescription: 'Fetch and summarize the main content of a web page or URL.',
        whenToUse: 'Use to read documentation, articles, or reference material from the web.',
    },
    github_repo: {
        category: 'web',
        enrichedDescription: 'Search a GitHub repository for relevant source code snippets.',
        whenToUse: 'Use to find code examples or implementations in a public repo.',
    },
    github_text_search: {
        category: 'web',
        enrichedDescription: 'Lexically search a GitHub repo or org for files containing keywords or code patterns.',
        whenToUse: 'Use to locate exact strings or identifiers in a GitHub codebase.',
    },

    // ── task / planning ────────────────────────────────────────────────
    manage_todo_list: {
        category: 'task',
        enrichedDescription: 'Track progress on a multi-step task via a structured todo list.',
        whenToUse: 'Use for complex multi-step work to keep the plan visible and ordered.',
    },
    tool_search: {
        category: 'task',
        enrichedDescription: 'Search/discover which tools are available for the current task.',
        whenToUse: 'Use to find the right tool when unsure what is available.',
    },
    task_complete: {
        category: 'task',
        enrichedDescription: 'Signal that the current task is complete.',
        whenToUse: 'Use to end the agent loop when the task is fully finished.',
    },

    // ── vscode / agent-control ─────────────────────────────────────────
    vscode_askQuestions: {
        category: 'vscode',
        enrichedDescription: 'Ask the user a small number of clarifying questions before proceeding.',
        whenToUse: 'Use when a task is ambiguous and a decision from the user would unblock correct work.',
    },
    vscode_reviewPlan: {
        category: 'vscode',
        enrichedDescription: 'Show the user a plan for review/approval before executing.',
        whenToUse: 'Use for large multi-step work where the user should approve the approach.',
    },
    vscode_get_confirmation: {
        category: 'vscode',
        enrichedDescription: 'Request the user\'s confirmation before a potentially destructive or costly action.',
        whenToUse: 'Use before irreversible operations (deletes, big rewrites, git operations).',
    },
    vscode_get_confirmation_with_options: {
        category: 'vscode',
        enrichedDescription: 'Request confirmation with a set of user-selectable options.',
        whenToUse: 'Use when the user should pick among a few defined choices.',
    },
    vscode_get_terminal_confirmation: {
        category: 'vscode',
        enrichedDescription: 'Request confirmation to run a terminal command (e.g. a permission gate).',
        whenToUse: 'Use before running commands that need explicit approval.',
    },
    vscode_renameSymbol: {
        category: 'vscode',
        enrichedDescription: 'Rename a code symbol across the workspace, updating all references.',
        whenToUse: 'Use to rename a function/class/variable precisely across the whole project.',
    },
    vscode_listCodeUsages: {
        category: 'vscode',
        enrichedDescription: 'Find all usages, references, and implementations of a code symbol across the workspace.',
        whenToUse: 'Use to see everywhere a symbol is referenced before refactoring or changing it.',
    },
    get_vscode_api: {
        category: 'vscode',
        enrichedDescription: 'Get VS Code API documentation and references for extension development.',
        whenToUse: 'Use when building or debugging VS Code extension code.',
    },
    switch_agent: {
        category: 'vscode',
        enrichedDescription: 'Switch to a different agent/mode for the current task.',
        whenToUse: 'Use when the task is better handled by a specialized agent.',
    },
    install_extension: {
        category: 'vscode',
        enrichedDescription: 'Install a VS Code extension as part of a new workspace setup.',
        whenToUse: 'Use when scaffolding a project that needs specific extensions.',
    },

    // ── memory / skills ────────────────────────────────────────────────
    resolve_memory_file_uri: {
        category: 'vscode',
        enrichedDescription: 'Resolve a memory-file path to its fully qualified URI.',
        whenToUse: 'Use when you need the actual URI of a memory/note file.',
    },
    skill: {
        category: 'task',
        enrichedDescription: 'Load/use a skill (packaged domain knowledge with instructions).',
        whenToUse: 'Use when a task falls within a known skill\'s domain.',
    },
    session_store_sql: {
        category: 'task',
        enrichedDescription: 'Query the local session store (past coding sessions) using SQL.',
        whenToUse: 'Use to search or analyze previous agent sessions.',
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
    if (k.prefer) parts.push(`Prefer: ${k.prefer}`);
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
/**
 * Build a compact, injection-ready "Copilot operating guide" for the system
 * prompt. Grounded in Copilot's OWN coding-agent workflow (extracted verbatim
 * from the Copilot bundle's gptAgentInstructions prompt element): a numbered
 * Understand → Investigate → Plan → Implement → Debug → Test → Iterate →
 * Reflect loop, with Copilot's exact rules. Keep it terse — it costs tokens.
 */
export function buildCopilotOperatingGuide(): string {
    return (
        'You are a coding agent inside VS Code Copilot Chat with a rich native toolset (file read/edit, ' +
        'workspace search, terminal, browser). Tool results frame as [tool NAME: STATUS] — treat ERROR as a failure to fix, ' +
        'not to ignore. Use multiple tools and do not give up until the task is complete or impossible. ' +
        'NEVER print codeblocks for file changes or commands — use the appropriate tool. ' +
        'Follow Copilot\'s workflow in order:\n' +
        '1. Understand the problem deeply — plan and edge cases before coding.\n' +
        '2. Investigate the codebase — search/read relevant files, gather context, find the root cause.\n' +
        '3. Develop a detailed, verifiable, step-by-step plan before changing anything.\n' +
        '4. Implement incrementally — read the relevant file first; prefer small, targeted edits over rewriting files.\n' +
        '5. Debug as needed — fix the root cause, not symptoms; change code only with high confidence.\n' +
        '6. Test frequently — run tests after each change; prefer the runTests tool over hand-typed commands.\n' +
        '7. Iterate until the root cause is fixed and all tests pass.\n' +
        '8. Reflect and validate — verify end-to-end and add tests, since hidden tests must also pass.\n' +
        '• Do not repeat work already done; continue from where you left off.\n' +
        '• For live UI/web pages: open/read the page, interact, then screenshot to confirm the change.'
    );
}
