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
 *     whenToUse, caution, prefer }. Used to enrich the `description` we send.
 *   - `augmentToolDescription(name, original)`: returns the REAL description
 *     Copilot supplied (kept verbatim) plus our guidance, or the original
 *     unchanged (safe fallback).
 *
 * SOURCE-GROUNDED (v0.7.76): tool names + descriptions are verified against
 * the open-source Copilot reference at `reference/copilot-chat/`
 * (package.json `contributes.languageModelTools` `modelDescription` + the
 * `ToolName` enum in src/extension/tools/common/toolNames.ts). Providers
 * receive the snake_case `ToolName` values (e.g. `read_file`, `grep_search`)
 * — `toolsService.ts` maps contributed names via `getToolName()` before
 * handing them to BYOK providers. The catalog's `enrichedDescription` is a
 * fallback ONLY for tools Copilot ships with an empty description; it never
 * replaces the real one. Categories come from the source `ToolCategory`
 * grouping (Core / Jupyter Notebook / Web Interaction / VS Code Interaction /
 * Testing), mapped to our compact labels (file, edit, search, diagnostics,
 * terminal, browser, notebook, task, vscode, project, web, container).
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
        prefer: 'Give the subagent a detailed, self-contained prompt — it only receives a compacted AGENTS.md, not your full session.',
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
        prefer: 'Adapt syntax to the active shell — on Windows the terminal runs PowerShell (pwsh), so bash-isms (grep, cat, rm -rf, export VAR=) fail or differ; use PowerShell equivalents (Select-String, Get-Content, Remove-Item, $env:VAR). For test runs prefer the dedicated runTests/run_task tool over a hand-typed command.',
    },
    execute: {
        category: 'terminal',
        enrichedDescription: 'Execute code and applications on the machine.',
        whenToUse: 'Use to run code, scripts, or applications.',
        caution: 'Executions have real side effects — prefer read-only commands when you only need information.',
        prefer: 'Adapt syntax to the active shell — on Windows the terminal runs PowerShell (pwsh), not bash.',
    },
    runCommand: {
        category: 'terminal',
        enrichedDescription: 'Run a command in the terminal and return its output.',
        whenToUse: 'Use to build, run, or inspect via the shell.',
        prefer: 'Adapt syntax to the active shell — on Windows the terminal runs PowerShell (pwsh), not bash.',
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
        enrichedDescription: 'Capture a screenshot of the current browser page and RETURN the image directly to you for viewing. The image is shown inline in the conversation — you can see it. No file saving is needed or possible here.',
        whenToUse: 'Use whenever you want to SEE the current rendered page. This is THE tool for viewing a page visually.',
        prefer: 'MANDATORY: to look at a page, call screenshot_page/screenshotPage — never try to save a screenshot file and view_image it. screenshot_page returns the image straight to you; no file saving is needed or possible.',
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
        enrichedDescription: 'Run a Playwright code snippet to control the browser page directly. The snippet runs inside the browser page context (page.evaluate-style), NOT in Node — so require, fs, path, and file writes are UNAVAILABLE.',
        whenToUse: 'Use only for advanced browser control (e.g. running page.evaluate) when the higher-level browser tools are insufficient.',
        caution: 'The snippet executes IN THE BROWSER PAGE: Node APIs like require, fs, and path are NOT defined, and it CANNOT write files to disk. NEVER use it to save a screenshot or any file. To view the page, call screenshot_page/screenshotPage — it returns the image to you directly.',
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
    // Snake-case alias — Copilot's agent loop passes `create_new_workspace`,
    // not the camelCase `newWorkspace` above (verified in nikas.log:
    // enrichment was stuck at 47/51 because this name had no catalog entry).
    create_new_workspace: {
        category: 'project',
        enrichedDescription: 'Get comprehensive setup steps to help the user create complete project structures in a VS Code workspace. Designed for full project initialization and scaffolding (TypeScript projects, React apps, Next.js, Vite, MCP servers, VS Code extensions), not for creating individual files. Provides folder structure, package.json/dependencies, config files, boilerplate, and build/run instructions.',
        whenToUse: 'Use when initializing a new project or framework from scratch.',
    },
    get_project_setup_info: {
        category: 'project',
        enrichedDescription: 'Provides project setup information for a VS Code workspace based on a project type and programming language. Do not call this tool without first calling the tool to create a workspace.',
        whenToUse: 'Use after create_new_workspace to get setup details for the chosen project type.',
    },
    resolveMemoryFileUri: {
        category: 'vscode',
        enrichedDescription: 'Resolve a memory-file path to its fully qualified URI.',
        whenToUse: 'Use when you need the actual URI of a memory/note file.',
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
    // Kebab-case alias — the live tool name Copilot passes is
    // `container-tools_get-config` (contributed by ms-azuretools.vscode-containers),
    // not the camelCase `containerToolsConfig` above.
    'container-tools_get-config': {
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
        enrichedDescription: 'Read the contents of a file. You must specify the line range you are interested in. Line numbers are 1-indexed. If the file contents returned are insufficient, call this tool again to retrieve more content. Prefer reading larger ranges over doing many small reads. Binary files use startLine/endLine as byte offsets.',
        whenToUse: 'Use to inspect a file before editing it, or to confirm what code exists.',
        prefer: 'Prefer targeted line-range reads over dumping an entire large file.',
    },
    view_image: {
        category: 'file',
        enrichedDescription: 'View the contents of an image file. Use this instead of read_file for supported image files such as png, jpg, jpeg, gif, and webp. The tool returns the image directly to multimodal models and does not take line ranges or offsets.',
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
        enrichedDescription: 'This is a tool for creating a new file in the workspace. The file will be created with the specified content. The directory will be created if it does not already exist. Never use this tool to edit a file that already exists.',
        whenToUse: 'Use to scaffold new files, modules, or configs.',
    },
    create_directory: {
        category: 'edit',
        enrichedDescription: 'Create a new directory structure in the workspace. Will recursively create all directories in the path, like mkdir -p. You do not need to use this tool before using create_file, that tool will automatically create the needed directories.',
        whenToUse: 'Use to create folders for a new module or structure.',
    },
    // ── edit tools (source-grounded V4A / replace contracts) ───────────
    apply_patch: {
        category: 'edit',
        enrichedDescription: 'Edit text files. Do not use this tool to edit Jupyter notebooks. apply_patch allows you to execute a diff/patch against a text file, but the format of the diff specification is unique to this task. To use the apply_patch command, pass a message of the following structure as "input": *** Begin Patch / [YOUR_PATCH] / *** End Patch, where [YOUR_PATCH] uses the V4A diff format: *** [ACTION] File: [/absolute/path/to/file] -> ACTION can be one of Add, Update, or Delete. Do not use line numbers in this diff format.',
        whenToUse: 'Use to apply a set of changes provided as a patch.',
    },
    insert_edit_into_file: {
        category: 'edit',
        enrichedDescription: 'Insert new code into an existing file in the workspace. Use this tool once per file that needs to be modified, even if there are multiple changes for a file. Generate the "explanation" property first. The system is very smart and can understand how to apply your edits, you just need to provide minimal hints. Avoid repeating existing code, instead use comments to represent regions of unchanged code. Be as concise as possible.',
        whenToUse: 'Use to make a targeted insertion into existing file content.',
    },
    replace_string_in_file: {
        category: 'edit',
        enrichedDescription: 'This is a tool for making edits in an existing file in the workspace. For moving or renaming files, use the terminal mv command instead. For larger edits, split them into smaller edits and call the edit tool multiple times to ensure accuracy. Each use of this tool replaces exactly ONE occurrence of oldString. CRITICAL for oldString: must uniquely identify the single instance to change; include at least 3 lines of context BEFORE and AFTER the target text, matching whitespace and indentation precisely. Never use "Lines 123-456 omitted" or ...existing code... comments in the oldString or newString.',
        whenToUse: 'Use for surgical, exact edits. Include enough surrounding context to make the match unique.',
    },
    multi_replace_string_in_file: {
        category: 'edit',
        enrichedDescription: 'This tool allows you to apply multiple replace_string_in_file operations in a single call, which is more efficient than calling replace_string_in_file multiple times. It takes an array of replacement operations and applies them sequentially. Each replacement operation has the same parameters as replace_string_in_file: filePath, oldString, newString, and explanation. Ideal when you need to make multiple edits across different files or multiple edits in the same file. The tool will provide a summary of successful and failed operations.',
        whenToUse: 'Use when you need several related edits at once — batch them for efficiency.',
    },

    // ── search / inspect ───────────────────────────────────────────────
    file_search: {
        category: 'search',
        enrichedDescription: 'Search for files in the workspace by glob pattern. This only returns the paths of matching files. Use this tool when you know the exact filename pattern of the files you are searching for. Glob patterns match from the root of the workspace folder. Examples: **/*.{js,ts} to match all js/ts files in the workspace; src/** to match all files under the top-level src folder.',
        whenToUse: 'Use to discover files by path pattern.',
    },
    get_search_view_results: {
        category: 'search',
        enrichedDescription: 'The results from the search view (the workspace Search panel).',
        whenToUse: 'Use to read results the user already has in the Search view.',
    },
    grep_search: {
        category: 'search',
        enrichedDescription: 'Do a fast text search in the workspace. Use this tool when you want to search with an exact string or regex. If you are not sure what words will appear in the workspace, prefer using regex patterns with alternation (|) or character classes to search for multiple potential words at once. Use includePattern to search within files matching a specific pattern, or in a specific file, using a relative path. Use includeIgnoredFiles to include files normally ignored by .gitignore, other ignore files, and files.exclude and search.exclude settings.',
        whenToUse: 'Use to locate where a symbol, string, or pattern lives before editing.',
    },
    text_search: {
        category: 'search',
        enrichedDescription: 'Lexically search workspace files for text or regex matches.',
        whenToUse: 'Use to find exact strings or patterns across the codebase.',
    },
    semantic_search: {
        category: 'search',
        enrichedDescription: 'Run a natural language search for relevant code or documentation comments from the user\'s current workspace. Returns relevant code snippets from the user\'s current workspace if it is large, or the full contents of the workspace if it is small.',
        whenToUse: 'Use to understand what code exists and where, when you do not know exact names.',
    },
    list_dir: {
        category: 'search',
        enrichedDescription: 'List the contents of a directory. Result will have the name of the child. If the name ends in /, it is a folder, otherwise a file.',
        whenToUse: 'Use to understand a project structure before navigating deeper.',
    },
    read_project_structure: {
        category: 'search',
        enrichedDescription: 'Get a file tree representation of the workspace.',
        whenToUse: 'Use to get oriented in an unfamiliar codebase.',
    },
    search_workspace_symbols: {
        category: 'search',
        enrichedDescription: 'Search the user\'s workspace for code symbols using language services. Use this tool when the user is looking for a specific symbol in their workspace.',
        whenToUse: 'Use to jump to a definition or find where a symbol is declared.',
    },
    get_changed_files: {
        category: 'search',
        enrichedDescription: 'Get git diffs of current file changes in a git repository. You can also use run_in_terminal to run git commands in a terminal.',
        whenToUse: 'Use to see what was modified before reviewing or committing.',
    },
    get_errors: {
        category: 'diagnostics',
        enrichedDescription: 'Get any compile or lint errors in a specific file or across all files. If the user mentions errors or problems in a file, they may be referring to these. Use the tool to see the same errors that the user is seeing. Also use this tool after editing a file to validate the change.',
        whenToUse: 'Use after edits to check for type/compile/lint errors and drive fixes.',
    },
    test_failure: {
        category: 'diagnostics',
        enrichedDescription: 'Includes test failure information in the prompt (from the most recent test run).',
        whenToUse: 'Use when a test failed to understand exactly what broke and where.',
    },

    // ── terminal / execute ─────────────────────────────────────────────
    execution_subagent: {
        category: 'terminal',
        enrichedDescription: 'Launch an iterative execution-focused subagent that performs an execution-based task (run tests and summarize failures, install dependencies, etc.). USE THIS INSTEAD OF RUNNING INDIVIDUAL COMMANDS WITH run_in_terminal EXCEPT IN THE RARE CASES THAT YOU NEED THE FULL OUTPUT OF A COMMAND. Returns a list of commands that were run with relevant output excerpts.',
        whenToUse: 'Use to run tests and filter failures, install dependencies, or any execution task where you want a summarized outcome rather than raw full output.',
        prefer: 'Prefer execution_subagent over chaining individual run_in_terminal calls for execution tasks (tests, installs) unless you need the full command output.',
    },
    run_in_terminal: {
        category: 'terminal',
        enrichedDescription: 'Run a shell command in the workspace terminal and return its output. This is how you build, run tests, or execute scripts.',
        whenToUse: 'Use to build, run tests, run the app, or execute shell commands to verify behavior.',
        caution: 'Commands have real side effects (they run in the actual terminal). Prefer read-only commands when you only need information.',
        prefer: 'Adapt syntax to the active shell — on Windows the terminal runs PowerShell (pwsh), so bash-isms (grep, cat, rm -rf, export VAR=) fail or differ; use PowerShell equivalents (Select-String, Get-Content, Remove-Item, $env:VAR).',
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
        prefer: 'Prefer doing the work yourself unless delegation is clearly necessary (e.g. parallel independent areas). Give the subagent a detailed, self-contained prompt — it only receives a compacted AGENTS.md, not your full session.',
    },
    search_subagent: {
        category: 'search',
        enrichedDescription: 'Launch a fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). Returns a list of relevant files/snippet locations in the workspace.',
        whenToUse: 'Use for broad exploration when you need to gather context across many files.',
        prefer: 'Give the subagent a detailed, self-contained prompt — it only receives a compacted AGENTS.md, not your full session.',
    },
    explore_subagent: {
        category: 'search',
        enrichedDescription: 'Dispatch a subagent to explore a specific area of the codebase.',
        whenToUse: 'Use to investigate an unfamiliar module or subsystem.',
        prefer: 'Explore subagents are read-only (search/read/list and read-only commands only).',
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
        enrichedDescription: 'Capture a screenshot of the current browser page and RETURN the image directly to you for viewing. The image is shown inline in the conversation — you can see it. No file saving is needed or possible here.',
        whenToUse: 'Use whenever you want to SEE the current rendered page. This is THE tool for viewing a page visually.',
        prefer: 'MANDATORY: to look at a page, call screenshot_page/screenshotPage — never try to save a screenshot file and view_image it. screenshot_page returns the image straight to you; no file saving is needed or possible.',
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
        enrichedDescription: 'Run a Playwright code snippet to control the browser page directly. The snippet runs inside the browser page context (page.evaluate-style), NOT in Node — so require, fs, path, and file writes are UNAVAILABLE.',
        whenToUse: 'Use only for advanced browser control (e.g. running page.evaluate) when the higher-level browser tools are insufficient.',
        caution: 'The snippet executes IN THE BROWSER PAGE: Node APIs like require, fs, and path are NOT defined, and it CANNOT write files to disk. NEVER use it to save a screenshot or any file. To view the page, call screenshot_page/screenshotPage — it returns the image to you directly.',
    },

    // ── notebook ───────────────────────────────────────────────────────
    create_new_jupyter_notebook: {
        category: 'notebook',
        enrichedDescription: 'Create a new Jupyter Notebook (.ipynb) in the workspace.',
        whenToUse: 'Use when the task is data exploration/analysis and a notebook is appropriate.',
    },
    run_notebook_cell: {
        category: 'notebook',
        enrichedDescription: 'This is a tool for running a code cell in a notebook file directly in the notebook editor. The output from the execution will be returned. Code cells should be run as they are added or edited when working through a problem. Avoid executing Markdown cells or providing Markdown cell IDs, as Markdown cells cannot be executed.',
        whenToUse: 'Use to execute notebook code and inspect results.',
    },
    edit_notebook_file: {
        category: 'notebook',
        enrichedDescription: 'This is a tool for editing an existing Notebook file in the workspace. Generate the "explanation" property first. The system is very smart and can understand how to apply your edits to the notebooks. When updating the content of an existing cell, ensure newCode preserves whitespace and indentation exactly and does NOT include any code markers such as (...existing code...).',
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
        enrichedDescription: 'Fetches the main content from a web page. This tool is useful for summarizing or analyzing the content of a webpage. You should use this tool when you think the user is looking for information from a specific webpage.',
        whenToUse: 'Use to read documentation, articles, or reference material from the web.',
    },
    github_repo: {
        category: 'web',
        enrichedDescription: 'Searches a GitHub repository for relevant source code snippets. Only use this tool if the user is very clearly asking for code snippets from a specific GitHub repository. Do not use this tool for GitHub repos that the user has open in their workspace.',
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
        enrichedDescription: 'Search for relevant tools by describing what you need. Returns tool references for tools matching your query. Use this when you need to find a tool but are not sure of its exact name. Use broad queries to cover related tools in one search (e.g. "github" instead of separate searches for issues and PRs).',
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
    run_vscode_command: {
        category: 'vscode',
        enrichedDescription: 'Run a command in VS Code. Use this tool to run a command in Visual Studio Code as part of a new workspace creation process only.',
        whenToUse: 'Use when scaffolding a new workspace that needs a VS Code command executed.',
    },
    switch_agent: {
        category: 'vscode',
        enrichedDescription: 'Switch to the Plan agent to align on approach before implementing. Plan will explore the codebase, gather context, clarify requirements with the user, and create an actionable implementation plan. SWITCH TO PLAN when: adding new functionality, multiple valid approaches exist, modifying existing behavior, architectural decisions required, changes span multiple files, or requirements are underspecified. Do NOT switch when a detailed spec/plan is already provided, you already started editing files, the change is a single obvious fix (typo/rename), or the user gave explicit step-by-step instructions.',
        whenToUse: 'Use when the task is better handled by a specialized agent (planning first).',
    },
    install_extension: {
        category: 'vscode',
        enrichedDescription: 'Install a VS Code extension as part of a new workspace setup.',
        whenToUse: 'Use when scaffolding a project that needs specific extensions.',
    },

    // ── memory / skills ────────────────────────────────────────────────
    memory: {
        category: 'task',
        enrichedDescription: 'Manage a persistent memory system with three scopes for storing notes and information across conversations: /memories/ (user memory, persistent across workspaces), /memories/session/ (session-scoped, cleared after conversation), /memories/repo/ (repository-scoped, stored locally). Commands: view, create, str_replace, insert, delete, rename. Before creating new memory files, first view the /memories/ directory to understand what already exists.',
        whenToUse: 'Use to save and retrieve cross-session context and conventions.',
    },
    resolve_memory_file_uri: {
        category: 'vscode',
        enrichedDescription: 'Resolve a memory file path (like /memories/session/plan.md or /memories/repo/notes.md) to its fully qualified URI. Use this when you need the actual URI for a memory file, for example to pass it to setArtifacts. The path must start with /memories/.',
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
 *
 * SOURCE-GROUNDED (v0.7.76): the `original` description is the REAL one
 * Copilot sends — authored by Microsoft in `contributes.languageModelTools`
 * `modelDescription` (verified against the open-source reference at
 * reference/copilot-chat/package.json). We therefore KEEP it verbatim and only
 * APPEND our DeepSeek-specific guidance (when to use / caution / prefer).
 * The catalog's `enrichedDescription` is used ONLY as a fallback when Copilot
 * ships a tool with an empty description — never to replace a real one.
 * This eliminates the previous behavior where hand-written catalog text
 * clobbered Microsoft's authoritative tool descriptions ("tool guessing").
 */
export function augmentToolDescription(name: string, original: string): string {
    const k = DEFAULT_CATALOG[name];
    if (!k) return original;
    const base = original && original.trim() ? original : k.enrichedDescription;
    const parts = [base];
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

