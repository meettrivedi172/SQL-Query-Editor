# SQL Query Builder – Function & Module Reference

This document explains why each major TypeScript function, component, and service exists inside the SQL Query Builder workspace. It focuses on “how the pieces fit together” so new contributors can reason about where to place changes without reverse‑engineering thousands of lines of code.

- **Scope.** Every component/service `.ts` file plus shared helpers such as the Monaco completion provider.
- **Grouping.** Extremely large files (`sql-editor.component.ts`, `results-grid.component.ts`, `sql-parser.service.ts`, etc.) are described by functional clusters to keep the catalog readable while still calling out the individual entry points.
- **Read me together with UI docs.** `QUERY_WRITING_OPTIONS.md` and `QUERY_DOCUMENTATION.md` describe authoring guidelines; this reference explains the mechanics in code.

---

## Application Shell

### `src/app/app.component.ts`

| Function | Why it exists |
| --- | --- |
| `ngAfterViewInit` | Waits until the SQL editor child is available via `@ViewChild` so toolbar callbacks can drive it. |
| `onSavedQueriesClick`, `onHistoryClick`, `onSaveQueryClick` | Forward header button clicks to `SqlEditorComponent` to open the relevant sidebars/modals. |

### `src/app/header/header.component.ts`

The header is intentionally dumb: it simply emits semantic events and lets the app shell decide what to do.

| Function | Why it exists |
| --- | --- |
| `onSavedQueriesClick`, `onHistoryClick`, `onSaveQueryClick` | Turn button taps into outputs, enabling parent components to remain in charge of side effects. |

---

## Schema Explorer

### `src/app/database-schema/database-schema.component.ts`

This standalone component visualizes the metadata service output, supports schema search, and exposes drag events so other components (SQL editors, visual builders) can react.

| Function(s) | Purpose |
| --- | --- |
| `ngOnInit`, `loadSchema` | Kick off schema fetches and populate tree nodes. |
| `buildTreeNodes`, `getFieldIcon`, `getDataTypeName` | Normalize API payloads into tree-ready nodes while annotating icons and badges. |
| `toggleNode`, `searchSchema`, `clearSearch`, `matchesSearch` | Manage UX state (expansion, search results). |
| `onTableDragStart/End`, `onFieldDragStart/End` | Emit drag payloads and give visual feedback for table/field drags. |
| `findParentNode`, `getFieldTooltip` | Utility helpers to enrich drag events and tooltips with descriptive metadata. |

---

## SQL Authoring (Editor + Monaco)

### `src/app/sql-editor/sql-editor.component.ts`

> _File size warning:_ this class orchestrates Monaco, validation, execution, formatting, result rendering, and query management. Functions are grouped logically below.

#### Lifecycle & Host Events

| Function(s) | Why we use them |
| --- | --- |
| `ngOnInit`, `ngAfterViewInit`, `ngOnDestroy` | Prepare state (parameter detection, validation debouncing), lazily initialize Monaco after the splitter renders, and dispose of observers/providers. |
| `handleKeyDown` | Captures F5 presses so we execute the query instead of refreshing the browser. |

#### Monaco Integration & Schema-Aware IntelliSense

| Function(s) | Why we use them |
| --- | --- |
| `initializeMonacoEditor` | Creates the editor, applies SQL language registration fallbacks, wires up suggestion triggers, and keeps models in sync with the component state. |
| `loadSchemaForAutocomplete` | Pulls schema data, feeds `SqlCompletionProvider`, and refreshes completions when metadata changes. |
| `onQueryChange` | Keeps `sqlQuery` in sync with Monaco, triggers validation/debounced updates, and prevents feedback loops when data grids push SQL changes back. |

#### Parameter Detection & Binding

| Function(s) | Purpose |
| --- | --- |
| `detectParameters`, `detectParameterType`, `getParameterValue` | Scan SQL for `@param` tokens, infer types (e.g., IDs → lookup, names → text), and expose values to the execution payload. |
| `validateParameters` (later in file) | Ensures required parameters are filled before running a query. |

#### Validation & Diagnostics

| Function(s) | Purpose |
| --- | --- |
| `validateQuery`, `validateSqlSyntaxWithParser`, `handleParserError` | Run lightweight checks, call the parser for deeper syntax validation, and convert parser errors into Monaco markers with line/column hints. |
| `updateValidationMarkers`, `clearValidationMarkers`, `getLineNumber`, `getColumnNumber`, `getWordAtPosition`, `levenshteinDistance`, `escapeRegex` | All support the UX requirement of surfacing squiggles in the editor and providing typo suggestions. |

#### Formatting & JSON Translation

| Function(s) | Purpose |
| --- | --- |
| `formatQuery`, `enhancedFormatQuery`, `postProcessFormattedQuery`, `splitSelectFields` | Wrap `sql-formatter` output with additional heuristics that match SSMS expectations (e.g., padded commas, join alignment). |
| `loadJson`, `loadSqlFromJson`, `getQueryJson` | Convert SQL ↔ QueryJson by delegating to `SqlParserService` and surfacing results in the JSON tab. |

#### Execution & Result Wiring

| Function(s) | Why we use them |
| --- | --- |
| `executeQuery`, `prepareExecutionPayload` (helper inside execute section), `applyGridFiltersToQuery` | Validate inputs, translate SQL to engine-friendly JSON, call `QueryExecutionService`, and reflect grid actions back into the SQL when necessary. |
| `handleExecutionSuccess`, `handleExecutionError`, `addQueryHistoryEntry` | Update `ResultsGridComponent`, raise toast notifications, and persist history entries on completion. |

#### Query Management Hooks

The UI integrates save/history sidebars via the following entry points (excerpt below):

```2894:3044:src/app/sql-editor/sql-editor.component.ts
openSaveQueryModal(): void {
  // ...
}

closeSaveQueryModal(): void { ... }
onSaveQuery(...): void { ... }
openSavedQueriesSidebar(): void { ... }
closeSavedQueriesSidebar(): void { ... }
onLoadSavedQuery(query: SavedQuery): void { ... }
onEditSavedQuery(query: SavedQuery): void { ... }
openQueryHistorySidebar(): void { ... }
closeQueryHistorySidebar(): void { ... }
onLoadQueryFromHistory(historyItem: QueryHistory): void { ... }
```

These functions let the editor act as the system-of-record: the component opens/ closes modals, keeps `currentQueryId` in sync, hydrates Monaco with historical SQL, and resets parameter values when a user loads a saved definition.

#### Utility Helpers

Remaining helpers—`getSqlKeywords`, `splitConditions`, `detectGridFilters`, etc.—support the features above (typo detection, SELECT clause analysis, grid ↔ SQL synchronization). Treat them as private implementation details scoped to the component.

### `src/app/sql-editor/monaco-sql-provider.ts`

`SqlCompletionProvider` is a thin wrapper around Monaco’s `CompletionItemProvider`. Key functions:

| Function | Purpose |
| --- | --- |
| `provideCompletionItems` | Central brain that inspects context (recent tokens, table aliases, WHERE/ORDER scope) and yields keyword/table/field suggestions. |
| `updateTables`, `updateSchema`, `extractTableAliases`, `getTableNameForAlias` | Keep completion data current with the metadata service and parse SQL aliases on the fly for accurate `table.field` completions. |
| `getSqlKeywords`, `getTableDisplayName` | Static helpers used to build human-readable completions. |

---

## Visual Query Builder UI

### `src/app/components/visual-query-builder/visual-query-builder.component.ts`

| Function(s) | Why we use them |
| --- | --- |
| `ngOnInit`, `ngOnChanges`, `loadSchema` | Initialize schema lists and re-parse SQL when the Visual tab becomes active or the backing SQL text changes elsewhere. |
| `onAppObjectChange`, `onFieldToggle`, `isFieldSelected`, `getSelectedField` | Manage SELECT field state when the user builds queries visually. |
| `addFilter/removeFilter`, `onFilterOperatorChange`, `getFilterInputType`, `isFilterValueRequired` | CRUD operations for WHERE filters with dynamic form controls. |
| `addSort/removeSort`, `moveSortUp/Down`, `onSortChange` | Keep ORDER BY clauses ordered and editable. |
| `addGroup/removeGroup`, `updateAggregatesForGrouping` | Enforce GROUP BY rules (e.g., clearing aggregates on grouped fields) and emit SQL changes. |
| `generateSQL`, `parseSQLToVisual`, `triggerSQLUpdate`, `queryChangeSubject` | Bridge between form state and SQL strings using `SqlParserService`, while debouncing updates to avoid feedback loops. |
| `syncWarning`, `executeQuery` outputs | Surface unsupported constructs (like JOIN editing) and forward “Run” clicks to the editor tab. |

---

## Results Presentation

### `src/app/components/results-grid/results-grid.component.ts`

The grid acts as a compatibility layer between Syncfusion’s data grid widget and our query lifecycle.

| Function Group | Why it exists |
| --- | --- |
| Lifecycle (`ngOnInit`, `ngAfterViewInit`, `ngOnChanges`, `initializeSyncfusionGrid`) | Lazily mount the third-party grid, detect data/column changes, and rebuild Syncfusion models without tearing down Angular inputs. |
| Column modeling (`initializeColumns`, `updateSyncfusionGridColumns`, `formatHeaderText`, `calculateColumnWidth`, `detectColumnType`, `detectSyncfusionColumnType`) | Auto-generate column definitions from result sets, including heuristics for common field names (IDs, dates, amounts). |
| Data processing (`processData`, `updateDisplayedData`, `onFilterChange`, `emitFilterChange`, `onSort`, `emitSortChange`, `onGroup`, `emitGroupChange`) | Maintain local filter/sort/group state so UX stays responsive even before the SQL is updated. |
| Paging & selection (`goToPage`, `nextPage`, `previousPage`, `toggleSelectAll`, `toggleRowSelection`, `isRowSelected`) | Provide SSMS-like pagination and multi-select controls. |
| Export (`exportCSV`, `exportExcel`, `copyToClipboard`, `refresh`) | Delegate to `ExportService` and clipboard APIs so users can quickly grab results. |
| Formatting & SQL sync (`formatValue`, `updateSQL`) | Ensure values render correctly (dates, booleans, currency) and optionally push grid filters back into the editor. |
| Syncfusion event wiring (`onGridActionBegin`, `onGridActionComplete`, `onGridDataBound`, `onGridFiltering`, `onGridSorted`, `onGridGrouping`) | Intercept grid popups/buttons to enforce validations and keep Angular-side filter/sort/group stores in sync with widget internals. |

---

## Query Management UI Components

### `src/app/components/save-query-modal/save-query-modal.component.ts`

| Function | Purpose |
| --- | --- |
| `ngOnInit` | Prefill the form when editing an existing query. |
| `onClose`, `onBackdropClick`, `reset` | Close UX affordances and clear validation errors/state. |
| `onSave` | Validate inputs (name length, tag count, SQL presence), normalize tags, and emit the sanitized payload. |

### `src/app/components/saved-queries-sidebar/saved-queries-sidebar.component.ts`

| Function Group | Why it exists |
| --- | --- |
| Lifecycle (`ngOnInit`, `ngOnDestroy`, `loadQueries`) | Populate the sidebar and keep it reactive via `QueryManagementService.savedQueries$`. |
| Filtering (`onSearchChange`, `onFilterChange`, `onSortChange`, `applyFiltersAndSort`) | Provide client-side search, favorite/filter toggles, and sorting modes. |
| Actions (`onQueryClick`, `onToggleFavorite`, `onEdit`, `onDuplicate`, `onShare`, `onDelete`) | Let users load, manage, and share saved queries. |
| Helpers (`getRelativeTime`, `formatExecutionTime`) | Human-readable metadata for list tiles. |

### `src/app/components/query-history-sidebar/query-history-sidebar.component.ts`

| Function Group | Why it exists |
| --- | --- |
| Lifecycle (`ngOnInit`, `ngOnDestroy`, `loadHistory`) | Pull recent history from `QueryManagementService`, subscribe to live updates, and set up a timer to refresh “time ago” text. |
| Actions (`onClose`, `onLoadQuery`, `onClearHistory`) | Let users reload past executions or clear the log. |
| UX helpers (`getRelativeTime`, `calculateRelativeTime`, `truncateSql`, `expandSql`, `isExpanded`) | Manage collapsed SQL previews and avoid Angular’s change detection warnings by caching computed strings. |

### `src/app/components/toast/toast.component.ts`

| Function | Purpose |
| --- | --- |
| `ngOnInit` | Subscribe to toast streams, queue new messages, and auto-dismiss on a timer when `duration` is provided. |
| `remove` | Imperatively remove a toast from the stack when it times out or is dismissed. |
| `ngOnDestroy` | Clean up subscriptions to prevent memory leaks. |

---

## Services

### `src/app/services/metadata.service.ts`

| Function | Why we use it |
| --- | --- |
| `getSchema`, `getAppObjectByName`, `getField`, `searchSchema` | Provide schema data and targeted lookups to every UI surface. |
| `getAppObjectNames`, `getAppObjectFields`, `getQualifiedFieldName` | Convenience helpers used by autocomplete and drag/drop features. |
| `parseDataType`, `isLookupField`, `mapApiDataToSchema` | Internal utilities that convert raw API payloads into the `AppObject`/`Field` shape consumed elsewhere. |

### `src/app/services/sql-parser.service.ts`

This class translates between SQL strings and the QueryJson format required by the backend. Key function families:

| Function Group | Purpose |
| --- | --- |
| Parsing primitives (`parseQuery`, `parseSelectFields`, `parseAggregateFunctions`, `parseJoins`, `parseWhereClause`, `parseHavingClause`, `parseOrderBy`, `parseLimit`, `parseParameters`) | Break SQL into structured objects while respecting nested expressions and aliases. |
| Condition helpers (`splitConditions`, `parseCondition`, `parseHavingCondition`, `buildFilterConditionFromJson`, `getSQLOperatorFromNumber`, `getRelationalOperatorFromSQLOperator`) | Normalize operators, conjunctions, BETWEEN syntax, LIKE variants, etc. |
| Schema lookup (`getTableIdFromSchema`, `getFieldIdFromSchema`) | Map textual table/field references to IDs when building JSON payloads. |
| Conversion surfaces (`sqlToJson`, `jsonToSql`) | Main entry points for Visual Builder, execution service, and import/export features. |

### `src/app/services/sql-validation.service.ts`

| Function | Why we use it |
| --- | --- |
| `validate` | High-level API that orchestrates all validations (syntax ordering, schema lookups, injection checks). |
| Helpers such as `stripComments`, `normalizeWhitespace`, `hasMultiStatement`, `hasDangerousPatterns`, `parenthesesBalanced` | Offer guardrails before we hit the database. |
| Clause analyzers (`validateClauseOrder`, `validateJoinSyntax`, `validateWhereHaving`, `validateGroupBy`, `validateOrderByLimit`) | Provide actionable feedback about clause ordering rules. |
| Schema-aware checks (`validateAgainstSchema`, `extractTables`, `extractTableAliases`, `extractColumnReferences`) | Ensure referenced tables/columns exist and catch ambiguous column usage. |
| UX helpers (`summarizeQuery`, `suggestImprovement`) | Feed the “validation summary” UI with human-readable hints. |

### `src/app/services/query-execution.service.ts`

| Function | Purpose |
| --- | --- |
| `executeQuery` | Converts SQL to QueryJson, POSTs to the backend, normalizes the result shape, and surfaces API error arrays as readable strings. |
| `handleError` | Returns a consistent failure object so the caller can display toasts/results without null checks. |

### `src/app/services/query-management.service.ts`

This service abstracts saved queries and history, with interchangeable storage backends (localStorage today, HTTP tomorrow).

| Function Group | Purpose |
| --- | --- |
| User helpers (`getCurrentUserId`, `getCurrentUserName`) | Provide deterministic IDs even when offline/local. |
| Saved queries (`saveQuery`, `updateQuery`, `deleteQuery`, `getSavedQueries`, `getSavedQuery`, `toggleFavorite`, `duplicateQuery`) | CRUD endpoints exposed to modals and sidebars. |
| History (`addToHistory`, `getQueryHistory`, `clearHistory`, `loadQueryFromHistory`) | Track past executions and allow reloading. |
| Local storage adapters (`saveQueryToLocalStorage`, `updateQueryInLocalStorage`, etc.) | Concrete implementations backing the default `useLocalStorage` flag. |
| API placeholders (`saveQueryToApi`, `updateQueryInApi`, …) | Stubbed out for future multi-user support. |
| Observables (`savedQueries$`, `queryHistory$`) | RxJS BehaviorSubjects so UI stays reactive. |
| Metrics (`recordQueryExecution`) | Updates execution counts/averages for UX cues. |

### `src/app/services/export.service.ts`

| Function | Purpose |
| --- | --- |
| `exportToCSV`, `exportToExcel` | Generate files (with BOM/Excel XML) directly in the browser to mirror SSMS export flows. |
| `copyToClipboard` | Copy tab-delimited data for quick Excel pastes. |
| `generateFilename`, `generateExcelXML`, `getExcelType` | Helper routines that keep exported filenames consistent and values correctly typed. |

### `src/app/services/toast.service.ts`

| Function | Purpose |
| --- | --- |
| `show` + variants (`success`, `error`, `warning`, `info`) | Push toast messages onto a shared Subject so UI components can render them. |
| `remove` | Invalidate a toast by ID (used by timers and manual dismissals). |
| `generateId` | Ensures IDs are unique even when toasts fire quickly in succession. |

---

## Supporting Utilities

### `src/app/components/toast/toast.component.ts`

Covered in the UI section above; pairs with `ToastService` to actually render messages.

### `src/app/services/query-execution.service.ts` & Grid interplay

When `SqlEditorComponent.executeQuery` succeeds, the normalized `QueryExecutionResponse` drives `ResultsGridComponent`. Grid events (`emitFilterChange`, `emitSortChange`, `emitGroupChange`) bubble back to the editor so we can optionally rewrite SQL—keeping UI and text in sync.

---

## Usage Tips

- **Need to extend validation?** Start in `SqlValidationService.validate`, add helper routines for the specific rule, and surface human text via `errors.push`.
- **Adding metadata-driven completions?** Update `MetadataService` (or its data file), then call `SqlCompletionProvider.updateSchema` inside `loadSchemaForAutocomplete`.
- **Keeping docs aligned:** Whenever you add or rename a function in any component/service listed above, update this markdown so newcomers understand the rationale.

---

_Last updated: 2025-11-17_

