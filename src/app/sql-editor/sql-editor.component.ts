import { Component, OnInit, ElementRef, ViewChild, AfterViewInit, OnDestroy, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject, debounceTime } from 'rxjs';
import { MetadataService, AppObject, Field } from '../services/metadata.service';
import { SqlParserService } from '../services/sql-parser.service';
import { SqlValidationService, SqlValidationResult } from '../services/sql-validation.service';
import { QueryExecutionService, QueryExecutionResponse } from '../services/query-execution.service';
import { ToastService } from '../services/toast.service';
import { QueryManagementService, SavedQuery, QueryHistory } from '../services/query-management.service';
import { ResultsGridComponent, GridFilter, GridSort, GridGroup } from '../components/results-grid/results-grid.component';
import { SaveQueryModalComponent } from '../components/save-query-modal/save-query-modal.component';
import { SavedQueriesSidebarComponent } from '../components/saved-queries-sidebar/saved-queries-sidebar.component';
import { QueryHistorySidebarComponent } from '../components/query-history-sidebar/query-history-sidebar.component';
import { VisualQueryBuilderComponent } from '../components/visual-query-builder/visual-query-builder.component';
import * as monaco from 'monaco-editor';
import { SqlCompletionProvider } from './monaco-sql-provider';
import { SplitterModule } from '@syncfusion/ej2-angular-layouts';
// Import SQL language support
import * as monacoSqlLanguages from 'monaco-sql-languages';
import { format } from 'sql-formatter';
import { Parser } from 'node-sql-parser';

interface QueryParameter {
  name: string;
  value: any;
  type: 'text' | 'number' | 'date' | 'lookup';
  required: boolean;
  options?: any[];
}

interface ValidationError {
  message: string;
  line?: number;
  column?: number;
  severity: 'error' | 'warning';
}

@Component({
  selector: 'app-sql-editor',
  standalone: true,
  imports: [
    CommonModule, 
    FormsModule, 
    ResultsGridComponent,
    SplitterModule,
    SaveQueryModalComponent,
    SavedQueriesSidebarComponent,
    QueryHistorySidebarComponent,
    VisualQueryBuilderComponent
  ],
  templateUrl: './sql-editor.component.html',
  styleUrl: './sql-editor.component.css'
})
export class SqlEditorComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('editorContainer', { static: false }) editorContainer!: ElementRef<HTMLDivElement>;
  
  private editor: monaco.editor.IStandaloneCodeEditor | null = null;
  private completionProvider: SqlCompletionProvider | null = null;
  private completionProviderDisposable: monaco.IDisposable | null = null;
  private resizeObserver?: ResizeObserver;
  private editorInitialized: boolean = false;

  activeTab: 'sql' | 'visual' | 'json' = 'sql';
  sqlQuery: string = '';
  forceVisualParse: boolean = false;
  formattedQuery: string = '';
  jsonInput: string = '';
  parameters: QueryParameter[] = [];
  isExecuting: boolean = false;
  hasValidationErrors: boolean = false;
  validationErrors: ValidationError[] = [];
  showValidationErrors: boolean = false;
  validationSuccess: boolean = false;
  
  // Query execution results
  queryResults: QueryExecutionResponse | null = null;
  showResults: boolean = false;
  
  // Query Management
  showSaveQueryModal: boolean = false;
  showSavedQueriesSidebar: boolean = false;
  showQueryHistorySidebar: boolean = false;
  editingQuery: SavedQuery | null = null;
  currentQueryId: string | null = null; // Track if current query is from a saved query
  
  private queryChangeSubject = new Subject<string>();
  private schemaData: { appObjects: AppObject[] } | null = null;

  private sqlParser: Parser;

  constructor(
    private elementRef: ElementRef,
    private metadataService: MetadataService,
    private sqlParserService: SqlParserService,
    private queryExecutionService: QueryExecutionService,
    private toastService: ToastService,
    private queryManagementService: QueryManagementService,
    private sqlValidationService: SqlValidationService
  ) {
    // Initialize node-sql-parser
    // Note: node-sql-parser has limited SQL Server support, so we use generic parser
    // and catch errors only for true syntax errors
    this.sqlParser = new Parser();
  }

  ngOnInit(): void {
    this.originalQuery = this.sqlQuery;

    this.detectParameters();
    this.queryChangeSubject.pipe(
      debounceTime(500)
    ).subscribe(query => {
      this.validateQuery(query);
    });
  }

  ngAfterViewInit(): void {
    // Load schema first
    this.loadSchemaForAutocomplete();
    
    // Initialize editor after splitter is ready
    // Use multiple checks to ensure splitter is fully rendered
    setTimeout(() => {
      this.initializeMonacoEditor();
    }, 100);
    
    // Also initialize when splitter is ready (if it takes longer)
    setTimeout(() => {
      if (!this.editorInitialized && this.editorContainer) {
        this.initializeMonacoEditor();
      }
    }, 300);
  }

  ngOnDestroy(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    if (this.completionProviderDisposable) {
      this.completionProviderDisposable.dispose();
    }
    if (this.editor) {
      this.editor.dispose();
      this.editor = null;
    }
  }

  /**
   * Handle F5 key press to execute query
   * Prevents default browser refresh behavior when F5 is pressed while Monaco editor is focused
   */
  @HostListener('window:keydown', ['$event'])
  handleKeyDown(event: KeyboardEvent): void {
    // Check if F5 is pressed
    if (event.key === 'F5' || event.keyCode === 116) {
      // Check if Monaco editor is focused
      if (this.editor && this.editor.hasTextFocus()) {
        event.preventDefault();
        event.stopPropagation();
        
        // Execute query if we have a query and not already executing
        if (this.sqlQuery.trim() && !this.isExecuting) {
          this.executeQuery();
        }
      }
    }
  }

  /**
   * Initialize Monaco Editor with SQL language support
   */
  private initializeMonacoEditor(): void {
    if (!this.editorContainer) {
      console.error('Editor container not found');
      return;
    }

    // Check if container has dimensions
    const containerElement = this.editorContainer.nativeElement;
    const containerRect = containerElement.getBoundingClientRect();
    if (containerRect.width === 0 || containerRect.height === 0) {
      // Container not ready yet, try again later
      setTimeout(() => {
        this.initializeMonacoEditor();
      }, 100);
      return;
    }

    // Check if editor is already initialized
    if (this.editor) {
      // Editor already exists, just update the value and trigger layout
      // CRITICAL: Ensure language mode is maintained
      const model = this.editor.getModel();
      if (model && model.getLanguageId() !== 'sql') {
        monaco.editor.setModelLanguage(model, 'sql');
      }
      this.editor.setValue(this.sqlQuery);
      // Use setTimeout to ensure the container is rendered
      setTimeout(() => {
        this.editor?.layout();
      }, 0);
      this.editorInitialized = true;
      return;
    }

    // Register SQL language with proper support using monaco-sql-languages
    // This package provides syntax highlighting and SQL dialect support
    if (!monaco.languages.getLanguages().find(lang => lang.id === 'sql')) {
      let sqlLanguageRegistered = false;
      
      try {
        // Check all possible exports from monaco-sql-languages
        const exports = monacoSqlLanguages as any;
        
        // Log available exports for debugging
        const exportKeys = Object.keys(exports);
        
        // Try common export patterns
        if (typeof exports.registerSQLLanguage === 'function') {
          exports.registerSQLLanguage(monaco);
          sqlLanguageRegistered = true;
        } else if (typeof exports.registerLanguage === 'function') {
          exports.registerLanguage(monaco);
          sqlLanguageRegistered = true;
        } else if (typeof exports.default === 'function') {
          exports.default(monaco);
          sqlLanguageRegistered = true;
        } else if (typeof exports === 'function') {
          exports(monaco);
          sqlLanguageRegistered = true;
        } else {
          // Try accessing specific SQL language registrations
          const sqlKeys = exportKeys.filter(k => k.toLowerCase().includes('sql'));
          const registerKeys = exportKeys.filter(k => k.toLowerCase().includes('register'));
          
          // Try register functions first
          for (const key of registerKeys) {
            if (typeof exports[key] === 'function') {
              try {
                exports[key](monaco);
                sqlLanguageRegistered = true;
                break;
              } catch (e) {
                console.warn(`Failed to register with ${key}:`, e);
              }
            }
          }
          
          // If still not registered, try SQL-related functions
          if (!sqlLanguageRegistered) {
            for (const key of sqlKeys) {
              if (typeof exports[key] === 'function') {
                try {
                  exports[key](monaco);
                  sqlLanguageRegistered = true;
                  break;
                } catch (e) {
                  console.warn(`Failed to register with ${key}:`, e);
                }
              }
            }
          }
        }
      } catch (error) {
        console.warn('Failed to register SQL language with monaco-sql-languages:', error);
      }
      
      // Fallback to basic registration if nothing worked
      if (!sqlLanguageRegistered) {
        monaco.languages.register({ id: 'sql' });
        
        // CRITICAL: Add basic SQL syntax highlighting manually
        monaco.languages.setMonarchTokensProvider('sql', {
          tokenizer: {
            root: [
              // SQL Keywords
              [/\b(SELECT|FROM|WHERE|JOIN|INNER|LEFT|RIGHT|FULL|OUTER|CROSS|ON|AS|AND|OR|NOT|IN|LIKE|BETWEEN|IS|NULL|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|INSERT|INTO|VALUES|UPDATE|SET|DELETE|UNION|ALL|DISTINCT|COUNT|SUM|AVG|MAX|MIN|CASE|WHEN|THEN|ELSE|END|ASC|DESC|EXISTS|ANY|SOME)\b/i, 'keyword'],
              // Comments
              [/--.*$/, 'comment'],
              [/\/\*[\s\S]*?\*\//, 'comment'],
              // Strings
              [/'([^'\\]|\\.)*'/, 'string'],
              [/"/, 'string', '@doubleString'],
              // Numbers
              [/\d+\.?\d*/, 'number'],
              // Operators
              [/[=<>!]+/, 'operator'],
              // Identifiers (table/column names)
              [/[a-zA-Z_][a-zA-Z0-9_]*/, 'identifier']
            ],
            doubleString: [
              [/[^\\"]+/, 'string'],
              [/"/, 'string', '@pop']
            ]
          }
        });
        
        // Set SQL theme colors
        monaco.editor.defineTheme('sql-dark', {
          base: 'vs-dark',
          inherit: true,
          rules: [
            { token: 'keyword', foreground: '569CD6', fontStyle: 'bold' },
            { token: 'string', foreground: 'CE9178' },
            { token: 'comment', foreground: '6A9955', fontStyle: 'italic' },
            { token: 'number', foreground: 'B5CEA8' },
            { token: 'operator', foreground: 'D4D4D4' },
            { token: 'identifier', foreground: 'D4D4D4' }
          ],
          colors: {}
        });
        
        monaco.editor.setTheme('sql-dark');
      }
    }
    
    // CRITICAL: Always ensure SQL language is set on the model
    // This must be done AFTER editor creation
    setTimeout(() => {
      if (this.editor) {
        const model = this.editor.getModel();
        if (model) {
          if (model.getLanguageId() !== 'sql') {
            monaco.editor.setModelLanguage(model, 'sql');
          }
        }
      }
    }, 0);

    // Create Monaco Editor instance
    this.editor = monaco.editor.create(containerElement, {
      value: this.sqlQuery,
      language: 'sql',
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 14,
      lineNumbers: 'on',
      roundedSelection: false,
      cursorStyle: 'line',
      wordWrap: 'on',
      formatOnPaste: true,
      suggestOnTriggerCharacters: true,
      quickSuggestions: {
        other: true,  // SSMS-like: Show suggestions as you type
        comments: false,
        strings: false
      },
      // CRITICAL: Enable suggestions on all characters, not just trigger characters
      suggest: {
        showKeywords: true,
        showSnippets: true
      },
      quickSuggestionsDelay: 0,  // Instant suggestions - show immediately on typing
      suggestSelection: 'first',
      wordBasedSuggestions: 'allDocuments',
      acceptSuggestionOnCommitCharacter: true,
      acceptSuggestionOnEnter: 'on',
      snippetSuggestions: 'inline',
      tabSize: 2,
      insertSpaces: true
    });

    // CRITICAL: Trigger suggestions on every keystroke (including after backspace)
    // This ensures suggestions appear immediately when typing
    this.editor.onKeyDown((e) => {
      // Trigger suggestions on any character key or backspace
      const isCharacterKey = e.keyCode >= 48 && e.keyCode <= 90; // A-Z, 0-9
      const isBackspace = e.keyCode === monaco.KeyCode.Backspace;
      const isDelete = e.keyCode === monaco.KeyCode.Delete;
      
      if (isCharacterKey || isBackspace || isDelete) {
        // Small delay to let the character be inserted/deleted first
        setTimeout(() => {
          if (this.editor) {
            // Only trigger if user is typing (not if suggestions are already showing)
            const position = this.editor.getPosition();
            if (position) {
              const currentLine = this.editor.getModel()?.getLineContent(position.lineNumber) || '';
              const lineBeforeCursor = currentLine.substring(0, position.column - 1);
              const hasWord = /(\w+)$/.test(lineBeforeCursor);
              
              // Trigger suggestions if there's a word being typed (1+ chars)
              // This ensures suggestions appear immediately, even for single characters
              const wordMatch = lineBeforeCursor.match(/(\w+)$/);
              if (wordMatch && wordMatch[1] && wordMatch[1].length >= 1) {
                this.editor.trigger('keyboard', 'editor.action.triggerSuggest', {});
              }
            }
          }
        }, 10);
      }
    });

    // Listen to editor content changes
    this.editor.onDidChangeModelContent(() => {
      const value = this.editor?.getValue() || '';
      this.sqlQuery = value;
      this.onQueryChange();
    });

    // Initialize completion provider - ALWAYS register to ensure it's active
    // CRITICAL: Dispose old provider if exists to avoid duplicates
    if (this.completionProviderDisposable) {
      this.completionProviderDisposable.dispose();
    }
    
    // Always create new provider to ensure it's fresh
    this.completionProvider = new SqlCompletionProvider([]);
    this.completionProviderDisposable = monaco.languages.registerCompletionItemProvider('sql', this.completionProvider);

    // Set up ResizeObserver to handle splitter resize events
    this.resizeObserver = new ResizeObserver(() => {
      if (this.editor) {
        setTimeout(() => {
          this.editor?.layout();
        }, 0);
      }
    });
    this.resizeObserver.observe(containerElement);

    // Set up drag and drop handlers
    if (containerElement) {
      containerElement.addEventListener('dragenter', this.onDragEnter.bind(this));
      containerElement.addEventListener('dragover', this.onDragOver.bind(this));
      containerElement.addEventListener('drop', this.onDrop.bind(this));
      containerElement.addEventListener('dragleave', this.onDragLeave.bind(this));
    }

    this.editorInitialized = true;
    
    // Force layout after a short delay to ensure splitter is fully rendered
    setTimeout(() => {
      if (this.editor) {
        this.editor.layout();
      }
    }, 50);
  }

  /**
   * Load schema data and update autocomplete provider
   */
  private loadSchemaForAutocomplete(): void {
    this.metadataService.getSchema().subscribe({
      next: (schema) => {
        this.schemaData = schema;
        const tableNames = schema.appObjects.map(obj => obj.name);
        const schemaMap = new Map<string, string[]>();

        // Build table -> fields mapping
        schema.appObjects.forEach(appObject => {
          const fieldNames = appObject.fields.map(field => field.name);
          schemaMap.set(appObject.name.toLowerCase(), fieldNames);
        });

        // Update completion provider
        if (this.completionProvider) {
          this.completionProvider.updateTables(tableNames);
          this.completionProvider.updateSchema(schemaMap);
        }
      },
      error: (error) => {
        console.error('Error loading schema for autocomplete:', error);
      }
    });
  }

  onQueryChange(): void {
    // Sync Monaco editor value if it changed externally (but not from visual builder)
    // Visual builder updates are handled separately to avoid conflicts
    if (this.editor && this.activeTab === 'sql') {
      const editorValue = this.editor.getValue();
      if (editorValue !== this.sqlQuery) {
        // Only update if the change came from SQL editor itself, not from visual builder
        // Check if we're currently on SQL tab to avoid updating when visual builder changes SQL
        // CRITICAL: Ensure language mode is maintained when updating
        const model = this.editor.getModel();
        if (model && model.getLanguageId() !== 'sql') {
          monaco.editor.setModelLanguage(model, 'sql');
        }
        this.editor.setValue(this.sqlQuery);
      }
    }
    
    // If query is manually changed (not from grid update), update original query
    if (!this.isUpdatingFromGrid) {
      // Check if this is a significant change (not just grid filter update)
      // We'll update original query when user manually edits
      const currentValue = this.editor?.getValue() || this.sqlQuery;
      if (currentValue !== this.originalQuery && !this.isUpdatingFromGrid) {
        // Only update if it's a substantial change (not just grid modifications)
        // This helps distinguish between user edits and grid updates
        const hasGridFilters = this.currentGridFilters.length > 0 || 
                               this.currentGridSorts.length > 0 || 
                               this.currentGridGroups.length > 0;
        
        // If no grid modifications, update original query
        if (!hasGridFilters) {
          this.originalQuery = currentValue;
        }
      }
    }
    
    this.detectParameters();
    // Don't clear validation errors here - let validation run and update them
    // The validation will be triggered by queryChangeSubject and will update hasValidationErrors
    this.queryChangeSubject.next(this.sqlQuery);
  }

  detectParameters(): void {
    const paramRegex = /@(\w+)/g;
    const matches = Array.from(this.sqlQuery.matchAll(paramRegex));
    const uniqueParams = [...new Set(matches.map(m => m[1]))];
    
    this.parameters = uniqueParams.map(paramName => ({
      name: paramName,
      value: this.getParameterValue(paramName),
      type: this.detectParameterType(paramName),
      required: true,
      options: []
    }));
  }

  getParameterValue(name: string): any {
    const existing = this.parameters.find(p => p.name === name);
    return existing?.value || '';
  }

  detectParameterType(paramName: string): 'text' | 'number' | 'date' | 'lookup' {
    const lowerName = paramName.toLowerCase();
    
    if (lowerName.includes('id')) return 'lookup';
    if (lowerName.includes('date')) return 'date';
    if (lowerName.includes('count') || lowerName.includes('amount') || lowerName.includes('priority')) return 'number';
    
    return 'text';
  }

  validateQuery(query: string): void {
    this.validationErrors = [];
    
    // Clear existing markers
    this.clearValidationMarkers();
    
    // Basic validation
    if (!query.trim()) {
      this.hasValidationErrors = false;
      this.validationErrors = [];
      this.showValidationErrors = false;
      this.validationSuccess = false;
      return;
    }

    // Only use node-sql-parser for SQL syntax validation (SQL Server style errors)
    // All custom error validations removed - only using parser-based syntax checking
    this.validateSqlSyntaxWithParser(query);
    
    this.hasValidationErrors = this.validationErrors.length > 0;
    
    // Show validation errors panel if there are errors
    if (this.hasValidationErrors) {
      this.showValidationErrors = true;
      this.validationSuccess = false;
    } else {
      this.showValidationErrors = false;
      this.validationSuccess = true;
    }
    
    // Update Monaco editor markers to show errors in red
    this.updateValidationMarkers();
  }

  /**
   * Validate SQL syntax using ONLY node-sql-parser
   * Note: node-sql-parser has limited SQL Server support, so we're lenient with errors
   */
  private validateSqlSyntaxWithParser(query: string): void {
    // Remove comments for validation (but keep them in original for line mapping)
    const queryWithoutComments = query
      .replace(/--.*$/gm, '') // Remove single-line comments
      .replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments
      .trim();
    
    if (!queryWithoutComments) {
      return; // Skip validation if query is empty after removing comments
    }

    // Use ONLY node-sql-parser to validate SQL syntax
    // Note: node-sql-parser doesn't fully support SQL Server syntax (like TOP, WITH, etc.)
    // So we catch errors but only report them if they seem like real syntax errors
    try {
      // Try to parse the query - if it succeeds, syntax is valid
      const ast = this.sqlParser.astify(queryWithoutComments);
      // If parsing succeeds, syntax is valid - no errors
    } catch (error: any) {
      const errorMessage = error.message || '';
      
      // Check if error is related to SQL Server-specific syntax that parser doesn't support well
      // Common SQL Server features that node-sql-parser may flag as errors:
      // - TOP n (e.g., SELECT TOP 8) - parser doesn't support this
      // - WITH clauses
      // - SQL Server-specific functions
      
      // Check if query contains SQL Server-specific syntax
      const hasTopSyntax = /\bselect\s+top\s+\d+/i.test(queryWithoutComments);
      const hasWithSyntax = /\bwith\s+\(/i.test(queryWithoutComments);
      const hasSqlServerFeatures = hasTopSyntax || hasWithSyntax;
      
      // Check if the error message indicates it's complaining about numbers after TOP
      // Common error pattern: "Expected ... but "8" found" or similar
      const errorComplainsAboutNumber = 
        errorMessage.includes('but') && 
        errorMessage.match(/but\s+["']?\d+["']?/i);
      
      const errorComplainsAboutTop = 
        errorMessage.toLowerCase().includes('top') ||
        (errorComplainsAboutNumber && hasTopSyntax);
      
      // If query contains SQL Server-specific syntax (like TOP 8),
      // and the error is complaining about it, skip the error as false positive
      if (hasSqlServerFeatures && (errorComplainsAboutTop || errorComplainsAboutNumber)) {
        // This is a false positive - node-sql-parser doesn't support SQL Server TOP syntax
        // Don't report this error
        return;
      }
      
      // Also check for other common SQL Server syntax that causes false positives
      if (hasTopSyntax && (
        errorMessage.toLowerCase().includes('expected') ||
        errorMessage.toLowerCase().includes('unexpected') ||
        errorMessage.toLowerCase().includes('but') ||
        errorMessage.toLowerCase().includes('found')
      )) {
        // Likely complaining about TOP syntax - skip it
        return;
      }
      
      // Parser error occurred - extract error information
      this.handleParserError(error, query, queryWithoutComments);
    }
  }

  /**
   * Handle parser errors from node-sql-parser
   * Uses parser's error message but makes it more readable
   */
  private handleParserError(error: any, originalQuery: string, queryWithoutComments: string): void {
    let errorMessage = error.message || 'Unknown syntax error';
    
    // Try to extract line and column from error object (from parser)
    let lineNumber = 1;
    let columnNumber = 1;
    
    // Check if error has location information from parser
    if (error.location) {
      lineNumber = error.location.line || error.location.lineNumber || 1;
      columnNumber = error.location.column || error.location.columnNumber || 1;
    } else if (error.line !== undefined) {
      lineNumber = error.line;
      columnNumber = error.column || 1;
    } else {
      // Try to extract from error message (parser might include it)
      const lineMatch = errorMessage.match(/line\s*(\d+)/i) || 
                       errorMessage.match(/at\s+line\s*(\d+)/i) ||
                       errorMessage.match(/position\s*(\d+)/i);
      if (lineMatch) {
        lineNumber = parseInt(lineMatch[1], 10);
      }
      
      const colMatch = errorMessage.match(/column\s*(\d+)/i) || 
                      errorMessage.match(/position\s*\d+.*?(\d+)/i);
      if (colMatch) {
        columnNumber = parseInt(colMatch[1], 10);
      }
    }

    // Map line number from queryWithoutComments to originalQuery
    const originalLines = originalQuery.split('\n');
    let mappedLineNumber = lineNumber;
    
    // If we have the line number, map it to original query
    if (lineNumber > 0 && lineNumber <= originalLines.length) {
      mappedLineNumber = lineNumber;
    }

    // Try to extract token from error message to make it clearer
    // Pattern: "but 'X' found" or "but "X" found" - extract the token
    const tokenMatch = errorMessage.match(/but\s+["']?([^"'[\]]+)["']?\s+found/i);
    let nearToken = '';
    
    // Collect a canonical list of SQL keywords for dynamic suggestion
    const keywordSet = this.getSqlKeywords();
    const keywords = Array.from(keywordSet);
    
    // Extract the error line content
    const currentLineText = mappedLineNumber > 0 && mappedLineNumber <= originalLines.length
      ? originalLines[mappedLineNumber - 1]
      : '';
    
    if (tokenMatch && tokenMatch[1]) {
      nearToken = tokenMatch[1].trim();
    }
    
    // Build candidate list of non-keyword words on the line with distance to closest keyword
    const wordRegex = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
    const candidates: Array<{ word: string; index: number; suggestionDist: number }> = [];
    if (currentLineText) {
      let m: RegExpExecArray | null;
      while ((m = wordRegex.exec(currentLineText)) !== null) {
        const w = m[0];
        const idx = m.index;
        const upper = w.toUpperCase();
        if (keywordSet.has(upper)) continue; // skip valid keywords entirely
        let bestDist = Number.POSITIVE_INFINITY;
        for (const kw of keywords) {
          const d = this.levenshteinDistance(upper, kw);
          if (d < bestDist) bestDist = d;
          if (bestDist === 0) break;
        }
        candidates.push({ word: w, index: idx, suggestionDist: bestDist });
      }
      candidates.sort((a, b) => (a.suggestionDist - b.suggestionDist) || (a.index - b.index));
    }
    
    // If parser gave a token that is a keyword or unclear (single char), prefer the best non-keyword candidate
    const parserTokenIsWeak = !nearToken || nearToken.length < 2 || keywordSet.has(nearToken.toUpperCase());
    if (parserTokenIsWeak) {
      let chosenWord: string | null = null;
      let chosenIndex = -1;
      let chosenLine = mappedLineNumber;
      
      const localBest = candidates.length > 0 ? (candidates.find(c => c.suggestionDist <= 2) || candidates[0]) : null;
      if (localBest) {
        chosenWord = localBest.word;
        chosenIndex = localBest.index;
      } else {
        // Fallback: scan entire query for best non-keyword typo near a keyword (dynamic, not hardcoded)
        let globalBest: { word: string; line: number; index: number; dist: number } | null = null;
        for (let li = 0; li < originalLines.length; li++) {
          const lineText = originalLines[li];
          if (!lineText) continue;
          let gm: RegExpExecArray | null;
          wordRegex.lastIndex = 0;
          while ((gm = wordRegex.exec(lineText)) !== null) {
            const w = gm[0];
            const idx = gm.index;
            const upper = w.toUpperCase();
            if (keywordSet.has(upper)) continue;
            // compute closest keyword distance
            let bestDist = Number.POSITIVE_INFINITY;
            for (const kw of keywords) {
              const d = this.levenshteinDistance(upper, kw);
              if (d < bestDist) bestDist = d;
              if (bestDist === 0) break;
            }
            if (!globalBest || bestDist < globalBest.dist || (bestDist === globalBest.dist && (li + 1) < globalBest.line)) {
              globalBest = { word: w, line: li + 1, index: idx, dist: bestDist };
            }
          }
        }
        if (globalBest) {
          chosenWord = globalBest.word;
          chosenIndex = globalBest.index;
          chosenLine = globalBest.line;
        }
      }
      
      if (chosenWord !== null && chosenIndex >= 0) {
        nearToken = chosenWord;
        columnNumber = chosenIndex + 1;
        mappedLineNumber = chosenLine;
      }
    }
    
    // If nearToken still empty, try word at reported column
    if (!nearToken) {
      const inferred = this.getWordAtPosition(currentLineText, Math.max(1, columnNumber));
      if (inferred) {
        nearToken = inferred.word;
        columnNumber = inferred.startColumn;
      }
    } else {
      // Align column to nearToken position in the line
      const idx = currentLineText.toUpperCase().indexOf(nearToken.toUpperCase());
      if (idx !== -1) {
        columnNumber = idx + 1;
      }
    }
    
    // Always show a precise, non-suggestive message and underline the exact token
    if (nearToken) {
      errorMessage = `Incorrect syntax near '${nearToken}'.`;
    }

    // Use the improved error message
    this.validationErrors.push({
      message: errorMessage,
      line: mappedLineNumber,
      column: columnNumber > 0 ? columnNumber : undefined,
      severity: 'error'
    });
  }

  /**
   * Get line number from character index in query
   */
  private getLineNumber(query: string, index: number): number {
    const lines = query.substring(0, index).split('\n');
    return lines.length;
  }

  /**
   * Get column number from character index in query
   * Returns the column position within the line (1-based)
   */
  private getColumnNumber(query: string, index: number, lineNumber: number): number {
    const lines = query.split('\n');
    if (lineNumber <= 0 || lineNumber > lines.length) {
      return 1;
    }
    
    // Calculate total characters before this line
    let charCount = 0;
    for (let i = 0; i < lineNumber - 1; i++) {
      charCount += lines[i].length + 1; // +1 for newline character
    }
    
    // Column is the position within the line (1-based in Monaco)
    const column = index - charCount + 1;
    
    // Ensure column is at least 1 and doesn't exceed line length
    return Math.max(1, Math.min(column, lines[lineNumber - 1].length + 1));
  }

  /**
   * Find the index of a word in the query
   */
  private findWordIndex(query: string, word: string): number {
    // Find word with word boundaries
    const regex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'i');
    const match = query.match(regex);
    return match && match.index !== undefined ? match.index : -1;
  }
  
  /**
   * Dynamically get SQL keywords (canonical, UPPERCASE)
   */
  private getSqlKeywords(): Set<string> {
    return new Set([
      'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET',
      'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'ON',
      'DISTINCT', 'TOP', 'AS', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'BETWEEN', 'IS', 'NULL',
      'UNION', 'ALL', 'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'ASC', 'DESC',
      'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
      'WITH', 'NOLOCK', 'EXCEPT', 'INTERSECT', 'MINUS', 'WINDOW', 'OVER', 'PARTITION'
    ]);
  }
  
  /**
   * Get the word at/near a 1-based column in a line and its start column
   */
  private getWordAtPosition(line: string, column1Based: number): { word: string; startColumn: number } | null {
    if (!line) return null;
    const idx = Math.max(0, Math.min(line.length, column1Based - 1));
    const isWordChar = (c: string) => /[A-Za-z0-9_]/.test(c);
    let start = idx;
    let end = idx;
    while (start > 0 && isWordChar(line[start - 1])) start--;
    while (end < line.length && isWordChar(line[end])) end++;
    if (start === end) {
      // Look left for the nearest word if we're on whitespace
      let i = start - 1;
      while (i >= 0 && !isWordChar(line[i])) i--;
      if (i >= 0) {
        let s = i;
        while (s >= 0 && isWordChar(line[s])) s--;
        start = s + 1;
        end = i + 1;
      }
    }
    const token = line.substring(start, end);
    if (!token) return null;
    return { word: token, startColumn: start + 1 };
  }
  
  /**
   * Compute Levenshtein distance between two strings
   */
  private levenshteinDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,      // deletion
          dp[i][j - 1] + 1,      // insertion
          dp[i - 1][j - 1] + cost // substitution
        );
      }
    }
    return dp[m][n];
  }


  /**
   * Escape special regex characters in a string
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Update Monaco editor markers to show validation errors with red wavy underlines
   * Uses node-sql-parser error information to accurately position markers
   */
  private updateValidationMarkers(): void {
    if (!this.editor || this.validationErrors.length === 0) {
      return;
    }

    const model = this.editor.getModel();
    if (!model) {
      return;
    }

    // Create markers for each validation error
    const markers: monaco.editor.IMarkerData[] = this.validationErrors.map(error => {
      const lineNumber = error.line || 1;
      let startColumn = error.column || 1;
      let endColumn = startColumn;
      
      // Get the line content to determine token boundaries
      const lineContent = model.getLineContent(lineNumber);
      
      // Try to extract the error token from the error message
      // Pattern: "near 'TOKEN'" or "near 'TOKEN'."
      const tokenMatch = error.message.match(/near\s+['"]([^'"]+)['"]/i);
      if (tokenMatch && tokenMatch[1]) {
        const token = tokenMatch[1].trim();
        
        // Find the token in the line (case-insensitive)
        const lineUpper = lineContent.toUpperCase();
        const tokenUpper = token.toUpperCase();
        
        // Try to find the token in the line
        // First try around the error column position
        let tokenIndex = -1;
        if (startColumn > 0 && startColumn <= lineContent.length) {
          // Search near the error position
          const searchStart = Math.max(0, startColumn - 15);
          const searchEnd = Math.min(lineContent.length, startColumn + 15);
          const searchArea = lineUpper.substring(searchStart, searchEnd);
          const relativeIndex = searchArea.indexOf(tokenUpper);
          
          if (relativeIndex !== -1) {
            tokenIndex = searchStart + relativeIndex;
          }
        }
        
        // If not found near error position, search entire line
        if (tokenIndex === -1) {
          tokenIndex = lineUpper.indexOf(tokenUpper);
        }
        
        if (tokenIndex !== -1) {
          startColumn = tokenIndex + 1; // Monaco uses 1-based columns
          endColumn = tokenIndex + token.length + 1;
        } else {
          // Token not found in line, use column position and highlight word there
          startColumn = Math.max(1, Math.min(startColumn, lineContent.length + 1));
          // Try to find word boundaries at this position
          const beforePos = Math.max(0, startColumn - 2);
          const afterPos = Math.min(lineContent.length, startColumn + token.length + 5);
          const wordContext = lineContent.substring(beforePos, afterPos);
          
          // Find word at or near the error position
          const wordMatch = wordContext.match(/(\S+)/);
          if (wordMatch && wordMatch.index !== undefined) {
            const wordStartInContext = beforePos + wordMatch.index;
            startColumn = wordStartInContext + 1;
            endColumn = wordStartInContext + wordMatch[1].length + 1;
          } else {
            endColumn = startColumn + 1;
          }
        }
      } else {
        // No token found in error message, highlight word/character at error position
        if (startColumn > 0 && startColumn <= lineContent.length) {
          // Find word boundaries around the error column
          const beforeColumn = Math.max(0, startColumn - 1);
          const afterColumn = Math.min(lineContent.length, startColumn);
          
          // Extract context around error position
          const beforeText = lineContent.substring(0, beforeColumn);
          const atText = lineContent.substring(beforeColumn, Math.min(lineContent.length, afterColumn + 20));
          
          // Try to find word boundaries
          const wordStartMatch = beforeText.match(/(\S*)$/);
          const wordMatch = atText.match(/^(\S+)/);
          
          if (wordMatch && wordMatch[1]) {
            // Calculate word start position
            const wordStart = wordStartMatch 
              ? beforeColumn - (wordStartMatch[1]?.length || 0) 
              : beforeColumn;
            startColumn = wordStart + 1; // Monaco uses 1-based columns
            endColumn = wordStart + (wordStartMatch ? (wordStartMatch[1]?.length || 0) : 0) + wordMatch[1].length + 1;
          } else if (lineContent.length > 0) {
            // Highlight single character or small token at error position
            const charAtPos = lineContent[startColumn - 1];
            if (charAtPos && !charAtPos.trim()) {
              // If it's whitespace, highlight next non-whitespace character
              const nextNonSpace = lineContent.substring(startColumn - 1).search(/\S/);
              if (nextNonSpace !== -1) {
                startColumn = startColumn + nextNonSpace;
                endColumn = startColumn + 1;
              } else {
                endColumn = startColumn + 1;
              }
            } else {
              // Highlight character at error position
              startColumn = Math.max(1, Math.min(startColumn, lineContent.length));
              endColumn = Math.min(startColumn + 1, lineContent.length + 1);
            }
          }
        }
      }
      
      // Ensure columns are within valid range
      if (lineContent.length > 0) {
        startColumn = Math.max(1, Math.min(startColumn, lineContent.length + 1));
        endColumn = Math.max(startColumn, Math.min(endColumn, lineContent.length + 1));
      } else {
        startColumn = Math.max(1, startColumn);
        endColumn = Math.max(startColumn + 1, endColumn);
      }

      return {
        severity: error.severity === 'error' 
          ? monaco.MarkerSeverity.Error 
          : monaco.MarkerSeverity.Warning,
        startLineNumber: lineNumber,
        startColumn: startColumn,
        endLineNumber: lineNumber,
        endColumn: endColumn,
        message: error.message,
        source: 'SQL Validation',
        code: 'SQL_SYNTAX_ERROR'
      };
    });

    // Set markers on the model - this will show red wavy underlines in Monaco editor
    monaco.editor.setModelMarkers(model, 'sql-validation', markers);
  }

  /**
   * Clear validation markers from Monaco editor
   */
  private clearValidationMarkers(): void {
    if (!this.editor) {
      return;
    }

    const model = this.editor.getModel();
    if (!model) {
      return;
    }

    // Clear all markers
    monaco.editor.setModelMarkers(model, 'sql-validation', []);
  }

  formatQuery(): void {
    try {
      if (!this.sqlQuery || !this.sqlQuery.trim()) {
        this.toastService.error('No SQL query to format', 'Empty Query');
        return;
      }

      let formatted: string;
      
      // Use sql-formatter library for formatting
      try {
        // Preprocess query to handle SQL Server specific syntax
        let queryToFormat = this.sqlQuery;
        
        // Temporarily replace NOLOCK hints to avoid parsing issues
        const nolockPlaceholder = '___NOLOCK___';
        const nolockMatches: string[] = [];
        let nolockIndex = 0;
        queryToFormat = queryToFormat.replace(/\(NOLOCK\)/gi, (match) => {
          nolockMatches.push(match);
          return `(${nolockPlaceholder}${nolockIndex++})`;
        });

        // Format with sql-formatter using SQL Server compatible settings
        // sql-formatter supports these core options
        formatted = format(queryToFormat, {
          language: 'sql', // Use standard SQL dialect (supports SQL Server syntax)
          tabWidth: 4, // 4 spaces for indentation
          keywordCase: 'upper', // Uppercase SQL keywords (SELECT, FROM, WHERE, etc.)
          linesBetweenQueries: 1 // Single line between queries
        });

        // Restore NOLOCK hints
        nolockMatches.forEach((match, index) => {
          formatted = formatted.replace(
            new RegExp(`\\(${nolockPlaceholder}${index}\\)`, 'gi'),
            match
          );
        });
        
        // Post-process to keep SELECT *, FROM table, WHERE condition on same lines
        formatted = this.postProcessFormattedQuery(formatted);
        
        this.sqlQuery = formatted;
        // Update Monaco editor
        if (this.editor) {
          this.editor.setValue(formatted);
        }
        this.onQueryChange();
        this.toastService.success('SQL query formatted successfully', 'Format Success');
      } catch (formatError: any) {
        // If sql-formatter fails, use our enhanced formatter as fallback
        console.warn('sql-formatter failed, using enhanced formatter:', formatError);
        formatted = this.enhancedFormatQuery(this.sqlQuery);

        this.sqlQuery = formatted;
        // Update Monaco editor
        if (this.editor) {
          this.editor.setValue(formatted);
        }
        this.onQueryChange();
        this.toastService.success('SQL query formatted with enhanced formatter', 'Format Success');
      }
    } catch (error: any) {
      console.error('Error formatting SQL query:', error);
      this.toastService.error(
        `Failed to format SQL query: ${error.message || 'Unknown error'}`,
        'Format Error'
      );
    }
  }

  /**
   * Enhanced SQL formatter that handles complex SQL Server queries
   * with EXISTS subqueries, NOLOCK hints, and nested structures
   */
  private enhancedFormatQuery(query: string): string {
    let formatted = query.trim();
    
    // Preserve NOLOCK hints and other SQL Server specific syntax
    // Normalize whitespace but be careful with brackets and parentheses
    formatted = formatted.replace(/\s+/g, ' ');
    
    // Add line breaks before major SQL keywords (but not inside strings or brackets)
    const addLineBreak = (text: string, keyword: string, indent: number = 0): string => {
      const indentStr = '    '.repeat(indent);
      const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
      return text.replace(regex, `\n${indentStr}${keyword}`);
    };
    
    // Format major clauses
    formatted = addLineBreak(formatted, 'SELECT', 0);
    formatted = addLineBreak(formatted, 'FROM', 0);
    formatted = addLineBreak(formatted, 'WHERE', 0);
    formatted = addLineBreak(formatted, 'LEFT JOIN', 0);
    formatted = addLineBreak(formatted, 'RIGHT JOIN', 0);
    formatted = addLineBreak(formatted, 'INNER JOIN', 0);
    formatted = addLineBreak(formatted, 'FULL JOIN', 0);
    formatted = formatted.replace(/\bJOIN\b/gi, (match, offset, str) => {
      // Only replace if not already part of LEFT/RIGHT/INNER/FULL JOIN
      const before = str.substring(Math.max(0, offset - 10), offset);
      if (!before.match(/(LEFT|RIGHT|INNER|FULL)\s+$/i)) {
        return '\nJOIN';
      }
      return match;
    });
    formatted = addLineBreak(formatted, 'ON', 1);
    formatted = addLineBreak(formatted, 'GROUP BY', 0);
    formatted = addLineBreak(formatted, 'ORDER BY', 0);
    formatted = addLineBreak(formatted, 'HAVING', 0);
    formatted = addLineBreak(formatted, 'UNION ALL', 0);
    formatted = addLineBreak(formatted, 'UNION', 0);
    
    // Handle EXISTS with proper indentation
    formatted = formatted.replace(/\b(AND|OR)\s+(EXISTS)\s*\(/gi, '\n    $1 EXISTS (');
    formatted = formatted.replace(/\bEXISTS\s*\(/gi, '\n    EXISTS (');
    
    // Handle AND/OR in WHERE clauses with proper indentation
    formatted = formatted.replace(/\b(AND|OR)\s+(?![EXISTS])/gi, '\n    $1 ');
    
    // Format SELECT field list - put each field on new line
    formatted = formatted.replace(/SELECT\s+(.+?)\s+FROM/gi, (match, selectClause) => {
      // Split by comma, but be careful with nested parentheses
      const fields = this.splitSelectFields(selectClause);
      const formattedFields = fields.map((field: string, index: number) => {
        const indent = index === 0 ? '' : '    ';
        return indent + field.trim();
      }).join(',\n');
      return `SELECT ${formattedFields}\nFROM`;
    });
    
    // Process lines with proper indentation
    const lines = formatted.split('\n');
    const result: string[] = [];
    let indentLevel = 0;
    let inSubquery = false;
    let parenStack: number[] = [];
    
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i].trim();
      if (!line) continue;
      
      const upperLine = line.toUpperCase();
      
      // Count parentheses to track subquery depth
      const openParens = (line.match(/\(/g) || []).length;
      const closeParens = (line.match(/\)/g) || []).length;
      
      for (let j = 0; j < openParens; j++) {
        parenStack.push(indentLevel);
        inSubquery = true;
      }
      for (let j = 0; j < closeParens; j++) {
        if (parenStack.length > 0) {
          indentLevel = parenStack.pop() || 0;
        }
        if (parenStack.length === 0) {
          inSubquery = false;
        }
      }
      
      // Adjust indent based on SQL structure
      if (upperLine.startsWith('FROM ')) {
        indentLevel = 0;
      } else if (upperLine.startsWith('WHERE ')) {
        indentLevel = 0;
      } else if (upperLine.startsWith('GROUP BY ') || upperLine.startsWith('ORDER BY ') || upperLine.startsWith('HAVING ')) {
        indentLevel = 0;
      } else if (upperLine.startsWith('SELECT ')) {
        indentLevel = 0;
      } else if (upperLine.match(/^(LEFT|RIGHT|INNER|FULL)\s+JOIN/)) {
        indentLevel = 0;
      } else if (upperLine.startsWith('ON ')) {
        indentLevel = 1;
      } else if (upperLine.startsWith('EXISTS (')) {
        // Keep current indent for EXISTS
      } else if (upperLine.startsWith('AND ') || upperLine.startsWith('OR ')) {
        if (!inSubquery) {
          indentLevel = 1;
        }
      }
      
      // Apply indentation
      const indent = '    '.repeat(Math.max(0, indentLevel));
      result.push(indent + line);
      
      // Increase indent for subqueries
      if (upperLine.includes('EXISTS (') || (upperLine.includes('SELECT ') && inSubquery)) {
        indentLevel++;
      }
    }
    
    formatted = result.join('\n');
    
    // Clean up: ensure commas in SELECT are on the same line or properly formatted
    formatted = formatted.replace(/,\s*\n\s*([A-Z])/g, ',\n    $1');
    
    // Clean up multiple blank lines
    formatted = formatted.replace(/\n{3,}/g, '\n\n');
    
    // Ensure proper spacing around operators
    formatted = formatted.replace(/\s*=\s*/g, ' = ');
    formatted = formatted.replace(/\s*<>\s*/g, ' <> ');
    formatted = formatted.replace(/\s*>\s*/g, ' > ');
    formatted = formatted.replace(/\s*<\s*/g, ' < ');
    formatted = formatted.replace(/\s*>=\s*/g, ' >= ');
    formatted = formatted.replace(/\s*<=\s*/g, ' <= ');
    
    return formatted.trim();
  }

  /**
   * Post-process formatted query to match desired formatting style:
   * - For simple queries: SELECT *, FROM table, WHERE condition on same lines
   * - For complex queries: Keep sql-formatter's formatting but adjust SELECT field list
   * - Ensure proper indentation for nested structures
   */
  private postProcessFormattedQuery(formatted: string): string {
    const lines = formatted.split('\n');
    const result: string[] = [];
    let i = 0;
    
    // Check if this is a simple query (SELECT * or single field)
    const isSimpleQuery = /SELECT\s+\*\s+FROM/i.test(formatted) || 
                         /SELECT\s+[^,\n]+\s+FROM/i.test(formatted.replace(/\s+/g, ' '));
    
    while (i < lines.length) {
      const line = lines[i].trim();
      
      // Handle SELECT clause
      if (line.toUpperCase().startsWith('SELECT')) {
        // For simple queries, keep SELECT * on one line
        if (isSimpleQuery) {
          let selectLine = line;
          i++;
          
          // Collect all content until we hit FROM
          while (i < lines.length) {
            const nextLine = lines[i].trim();
            const upperNext = nextLine.toUpperCase();
            
            if (upperNext.startsWith('FROM')) {
              break;
            }
            
            if (!nextLine) {
              i++;
              continue;
            }
            
            selectLine += ' ' + nextLine;
            i++;
          }
          
          result.push(selectLine);
          continue;
        } else {
          // For complex queries, format to match desired style:
          // SELECT [field1] AS [alias1]
          // ,[field2] AS [alias2] 
          // ,[field3] AS [alias3]
          // FROM ...
          
          // Check if SELECT line already has content
          const trimmedLine = line.trim();
          if (trimmedLine.toUpperCase().startsWith('SELECT') && trimmedLine.length > 6) {
            // SELECT already has first field on same line
            result.push(line);
            i++;
          } else {
            // SELECT is alone, we'll get first field from next line
            result.push('SELECT');
            i++;
          }
          
          let isFirstField = true;
          
          // Process SELECT field list
          while (i < lines.length) {
            const nextLine = lines[i];
            const trimmed = nextLine.trim();
            const upperNext = trimmed.toUpperCase();
            
            if (upperNext.startsWith('FROM')) {
              break;
            }
            
            if (!trimmed) {
              i++;
              continue;
            }
            
            // Handle first field - check if last line is just "SELECT"
            const lastResultLine = result[result.length - 1].trim();
            if (isFirstField && lastResultLine.toUpperCase() === 'SELECT') {
              // First field goes on same line as SELECT
              result[result.length - 1] = 'SELECT ' + trimmed;
              isFirstField = false;
            } else if (trimmed.startsWith(',')) {
              // Subsequent fields with comma at start - format with tab (matching image style)
              result.push('\t' + trimmed);
              isFirstField = false;
            } else if (!isFirstField) {
              // Field without comma prefix - add comma with tab
              result.push('\t, ' + trimmed);
            } else {
              // First field without comma - add to SELECT line
              if (lastResultLine.toUpperCase() === 'SELECT') {
                result[result.length - 1] = 'SELECT ' + trimmed;
              } else {
                // SELECT already has content, this shouldn't happen but handle it
                result.push(nextLine);
              }
              isFirstField = false;
            }
            i++;
          }
          continue;
        }
      }
      
      // Handle FROM clause
      if (line.toUpperCase().startsWith('FROM')) {
        // For simple queries, keep FROM and table on same line
        if (isSimpleQuery) {
          let fromLine = line;
          i++;
          
          while (i < lines.length) {
            const nextLine = lines[i].trim();
            const upperNext = nextLine.toUpperCase();
            
            if (upperNext.startsWith('WHERE') || 
                upperNext.startsWith('GROUP BY') || 
                upperNext.startsWith('ORDER BY') || 
                upperNext.startsWith('HAVING') || 
                upperNext.startsWith('UNION')) {
              break;
            }
            
            if (!nextLine) {
              i++;
              continue;
            }
            
            // Skip JOIN clauses for simple queries (they shouldn't exist)
            if (upperNext.match(/^(LEFT|RIGHT|INNER|FULL|CROSS)\s+JOIN|^JOIN/)) {
              break;
            }
            
            fromLine += ' ' + nextLine;
            i++;
          }
          
          result.push(fromLine);
          continue;
        } else {
          // For complex queries, preserve sql-formatter's formatting
          result.push(line);
          i++;
          
          // Process FROM clause content (table names, JOINs, ON clauses)
          while (i < lines.length) {
            const nextLine = lines[i];
            const trimmed = nextLine.trim();
            const upperNext = trimmed.toUpperCase();
            
            if (upperNext.startsWith('WHERE') || 
                upperNext.startsWith('GROUP BY') || 
                upperNext.startsWith('ORDER BY') || 
                upperNext.startsWith('HAVING') || 
                upperNext.startsWith('UNION')) {
              break;
            }
            
            if (!trimmed) {
              i++;
              continue;
            }
            
            // Preserve original formatting (sql-formatter handles JOINs and ON clauses well)
            result.push(nextLine);
            i++;
          }
          continue;
        }
      }
      
      // Handle WHERE clause
      if (line.toUpperCase().startsWith('WHERE')) {
        // For simple queries, keep WHERE and condition on same line
        if (isSimpleQuery) {
          let whereLine = line;
          i++;
          
          while (i < lines.length) {
            const nextLine = lines[i].trim();
            const upperNext = nextLine.toUpperCase();
            
            if (upperNext.startsWith('GROUP BY') || 
                upperNext.startsWith('ORDER BY') || 
                upperNext.startsWith('HAVING') || 
                upperNext.startsWith('UNION')) {
              break;
            }
            
            if (!nextLine) {
              i++;
              continue;
            }
            
            whereLine += ' ' + nextLine;
            i++;
          }
          
          result.push(whereLine);
          continue;
        } else {
          // For complex queries, preserve sql-formatter's formatting
          // It already handles indentation for AND/OR, EXISTS, subqueries correctly
          result.push(line);
          i++;
          
          while (i < lines.length) {
            const nextLine = lines[i];
            const trimmed = nextLine.trim();
            const upperNext = trimmed.toUpperCase();
            
            if (upperNext.startsWith('GROUP BY') || 
                upperNext.startsWith('ORDER BY') || 
                upperNext.startsWith('HAVING') || 
                upperNext.startsWith('UNION')) {
              break;
            }
            
            if (!trimmed) {
              i++;
              continue;
            }
            
            // Preserve original formatting (sql-formatter handles complex WHERE clauses well)
            result.push(nextLine);
            i++;
          }
          continue;
        }
      }
      
      // Handle GROUP BY, ORDER BY, HAVING - keep keyword and content together
      if (line.toUpperCase().match(/^(GROUP BY|ORDER BY|HAVING)/)) {
        let clauseLine = line;
        i++;
        
        while (i < lines.length) {
          const nextLine = lines[i].trim();
          const upperNext = nextLine.toUpperCase();
          
          // Stop if we hit another major clause
          if (upperNext.startsWith('ORDER BY') || 
              upperNext.startsWith('HAVING') || 
              upperNext.startsWith('UNION') ||
              upperNext.startsWith('EXCEPT') ||
              upperNext.startsWith('INTERSECT')) {
            break;
          }
          
          if (!nextLine) {
            i++;
            continue;
          }
          
          clauseLine += ' ' + nextLine;
          i++;
        }
        
        result.push(clauseLine);
        continue;
      }
      
      // Handle JOIN clauses - keep them as is but ensure proper formatting
      if (line.toUpperCase().match(/^(LEFT|RIGHT|INNER|FULL|CROSS)\s+JOIN|^JOIN/)) {
        result.push(line);
        i++;
        continue;
      }
      
      // Handle ON clauses - keep with proper indentation
      if (line.toUpperCase().startsWith('ON ')) {
        result.push('    ' + line);
        i++;
        continue;
      }
      
      // Default: keep the line as is
      result.push(line);
      i++;
    }
    
    return result.join('\n');
  }

  /**
   * Split SELECT fields by comma, respecting parentheses and brackets
   */
  private splitSelectFields(selectClause: string): string[] {
    const fields: string[] = [];
    let current = '';
    let depth = 0;
    let inBrackets = false;
    let inQuotes = false;
    let quoteChar = '';
    
    for (let i = 0; i < selectClause.length; i++) {
      const char = selectClause[i];
      const prevChar = i > 0 ? selectClause[i - 1] : '';
      
      if ((char === '"' || char === "'") && prevChar !== '\\') {
        if (!inQuotes) {
          inQuotes = true;
          quoteChar = char;
        } else if (char === quoteChar) {
          inQuotes = false;
        }
        current += char;
      } else if (!inQuotes) {
        if (char === '[') {
          inBrackets = true;
          current += char;
        } else if (char === ']') {
          inBrackets = false;
          current += char;
        } else if (char === '(') {
          depth++;
          current += char;
        } else if (char === ')') {
          depth--;
          current += char;
        } else if (char === ',' && depth === 0 && !inBrackets) {
          if (current.trim()) {
            fields.push(current.trim());
          }
          current = '';
        } else {
          current += char;
        }
      } else {
        current += char;
      }
    }
    
    if (current.trim()) {
      fields.push(current.trim());
    }
    
    return fields;
  }


  executeQuery(): void {
    // Immediate validation check - run validation synchronously first
    if (!this.sqlQuery.trim()) {
      this.toastService.error('Please enter a SQL query to execute', 'Empty Query');
      return;
    }

    const executionStartTime = Date.now();
    
    // Run validation immediately (synchronously) before execution
    this.validateQuery(this.sqlQuery);
    
    // Check for validation errors immediately
    if (this.hasValidationErrors && this.validationErrors.length > 0) {
      // Show validation errors panel
      this.showValidationErrors = true;
      
      // Format errors in SQL Server style with execution info
      const executionEndTime = Date.now();
      const executionTimeMs = executionEndTime - executionStartTime;
      const executionTimeSeconds = (executionTimeMs / 1000).toFixed(3);
      
      // Get first error line number for the "Started executing query" message
      const firstErrorLine = this.validationErrors.length > 0 && this.validationErrors[0].line 
        ? this.validationErrors[0].line 
        : 1;
      
      // Get current time for display
      const now = new Date();
      const timeString = now.toLocaleTimeString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit',
        hour12: true 
      });
      
      // Format error messages in SQL Server style
      const formattedErrors: string[] = [];
      
      // Add execution start message
      formattedErrors.push(`${timeString}\nStarted executing query at  Line ${firstErrorLine}`);
      
      // Add formatted error messages (already in SQL Server style from validateSqlSyntaxWithParser)
      this.validationErrors
        .filter(e => e.severity === 'error')
        .forEach(e => {
          formattedErrors.push(e.message);
        });
      
      // Add execution time in format: 00:00:00.046
      const hours = Math.floor(executionTimeMs / 3600000);
      const minutes = Math.floor((executionTimeMs % 3600000) / 60000);
      const seconds = Math.floor((executionTimeMs % 60000) / 1000);
      const milliseconds = executionTimeMs % 1000;
      // Format as HH:mm:ss.SSS (e.g., 00:00:00.046)
      const timeFormatted = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${Math.floor(milliseconds).toString().padStart(3, '0')}`;
      formattedErrors.push(`Total execution time: ${timeFormatted}`);
      
      const fullErrorMessage = formattedErrors.join('\n\n');
      
      // Display error in the results grid area (where query results are shown)
      this.queryResults = {
        success: false,
        data: [],
        metadata: {
          rowCount: 0,
          executionTime: executionTimeMs / 1000,
          hasMore: false
        },
        error: fullErrorMessage,
        statusCode: 'SYNTAX_ERROR',
        totalExecutionTime: executionTimeMs
      };
      this.showResults = true;
      
      // Also show toast notification
      this.toastService.error('SQL Syntax Error: Please check the error details below.', 'Validation Failed');
      
      return;
    }

    // Validate SQL can be parsed to QueryJson (required for execution)
    let queryJson: any = null;
    try {
      queryJson = this.sqlParserService.sqlToJson(this.sqlQuery, this.schemaData);
      if (!queryJson) {
        this.toastService.error('Failed to parse SQL query. Please check your SQL syntax.', 'Parse Error');
        return;
      }
    } catch (parseError: any) {
      this.toastService.error(
        `SQL Parse Error: ${parseError.message || 'Failed to parse query. Please check your SQL syntax.'}`,
        'Parse Error'
      );
      return;
    }

    if (!this.validateParameters()) {
      this.toastService.error('Please fill in all required parameters', 'Parameter Error');
      return;
    }

    // Clear all grid filters, sorts, and groups when executing a new query
    // This ensures that previous grid modifications don't persist when executing a new query
    this.currentGridFilters = [];
    this.currentGridSorts = [];
    this.currentGridGroups = [];
    
    // Update original query when executing (to capture user's base query)
    // Only update if originalQuery is empty or if current query has no grid modifications
    // This prevents overwriting the original query when executing a query that already has grid filters
    if (!this.originalQuery || this.originalQuery === '' || 
        (this.currentGridFilters.length === 0 && this.currentGridSorts.length === 0 && this.currentGridGroups.length === 0)) {
      this.originalQuery = this.sqlQuery;
    }
    
    this.isExecuting = true;
    this.isExecutingQuery = true; // Set flag to prevent grid updates during execution
    this.queryResults = null;
    this.showResults = false;
    
    // Prepare parameters object
    const paramsObj: { [key: string]: any } = {};
    this.parameters.forEach(param => {
      if (param.value !== null && param.value !== undefined && param.value !== '') {
        paramsObj[param.name] = param.value;
      }
    });

    const startTime = Date.now();

    // Call query execution service with SQL parser for QueryJson conversion
    // FOR PRODUCTION: The API call code is in QueryExecutionService
    // Currently using mock data for development
    // Pass schemaData to ensure correct Field IDs are used
    this.queryExecutionService.executeQuery(this.sqlQuery, paramsObj, this.sqlParserService, this.schemaData).subscribe({
      next: (response: QueryExecutionResponse) => {
        this.isExecuting = false;
        this.queryResults = response;
        this.showResults = true;
        
        // Clear grid filters, sorts, and groups by emitting empty arrays
        // This ensures the grid component resets its filter/sort/group state
        // Use setTimeout to ensure the grid component is ready to receive the clear signals
        // IMPORTANT: Only clear if there are existing grid modifications to avoid reformatting the query
        setTimeout(() => {
          this.isExecutingQuery = false; // Allow grid updates after query execution completes
          
          // Only clear grid filters/sorts/groups if they exist
          // This prevents unnecessary query reformatting
          if (this.currentGridFilters.length > 0 || 
              this.currentGridSorts.length > 0 || 
              this.currentGridGroups.length > 0) {
            this.onGridFilterChange([]);
            this.onGridSortChange([]);
            this.onGridGroupChange([]);
          }
        }, 100);
        
        const executionTime = (Date.now() - startTime) / 1000;
        
        // Record in query history
        this.queryManagementService.addToHistory({
          sqlText: this.sqlQuery,
          queryJson: queryJson,
          parameterValues: Object.keys(paramsObj).length > 0 ? paramsObj : undefined,
          status: response.success ? 'success' : 'error',
          executionTime: response.metadata.executionTime || executionTime,
          rowCount: response.metadata.rowCount || 0,
          errorMessage: response.error,
          savedQueryId: this.currentQueryId || undefined
        }).subscribe();

        // Update saved query stats if this was from a saved query
        if (this.currentQueryId && response.success) {
          this.queryManagementService.recordQueryExecution(
            this.currentQueryId,
            response.metadata.executionTime || executionTime,
            true
          );
        }
        
        // CRITICAL: After query execution, ensure completion provider and syntax highlighting are active
        if (this.editor) {
          setTimeout(() => {
            // Ensure model language is SQL (for syntax highlighting)
            const model = this.editor?.getModel();
            if (model) {
              const currentLanguage = model.getLanguageId();
              if (currentLanguage !== 'sql') {
                monaco.editor.setModelLanguage(model, 'sql');
              }
              
              // Syntax highlighting will refresh automatically when language is set
              // No need to force refresh - Monaco handles it
            }
            
            // Update completion provider with latest schema
            if (this.completionProvider && this.schemaData) {
              const tableNames = this.schemaData.appObjects.map(obj => obj.name);
              const schemaMap = new Map<string, string[]>();
              this.schemaData.appObjects.forEach(appObject => {
                const fieldNames = appObject.fields.map(field => field.name);
                schemaMap.set(appObject.name.toLowerCase(), fieldNames);
              });
              this.completionProvider.updateTables(tableNames);
              this.completionProvider.updateSchema(schemaMap);
            }
          }, 100);
        }
        
        if (response.success) {
          this.toastService.success(
            `Query executed successfully: ${response.metadata.rowCount} rows in ${response.metadata.executionTime}s`,
            'Success'
          );
        } else {
          this.toastService.error(
            response.error || 'Query execution failed',
            'Execution Error'
          );
        }
      },
      error: (error) => {
        this.isExecuting = false;
        this.isExecutingQuery = false; // Clear flag on error
        const errorMessage = error.message || 'Unknown error occurred';
        const executionTime = (Date.now() - startTime) / 1000;
        
        // Record failed execution in history
        this.queryManagementService.addToHistory({
          sqlText: this.sqlQuery,
          queryJson: queryJson,
          parameterValues: Object.keys(paramsObj).length > 0 ? paramsObj : undefined,
          status: 'error',
          executionTime: executionTime,
          rowCount: 0,
          errorMessage: errorMessage,
          savedQueryId: this.currentQueryId || undefined
        }).subscribe();
        
        this.toastService.error(
          `Error executing query: ${errorMessage}`,
          'Network Error'
        );
        this.queryResults = {
          success: false,
          data: [],
          metadata: {
            rowCount: 0,
            executionTime: 0,
            hasMore: false
          },
          error: errorMessage
        };
        this.showResults = true;
      }
    });
  }

  validateQueryOnly(): void {
    // Run strict rule-based validation and show JSON result in JSON tab
    const result: SqlValidationResult = this.sqlValidationService.validate(this.sqlQuery, this.schemaData);
    const output = {
      valid: result.valid,
      errors: result.errors,
      summary: result.summary,
      suggestion: result.suggestion
    };

    // Populate JSON tab
    this.jsonInput = JSON.stringify(output, null, 2);
    this.activeTab = 'json';

    // Also reflect errors in the Monaco markers panel for quick navigation
    this.validationErrors = (result.errors || []).map(err => ({
      message: err,
      severity: 'error' as const
    }));
    this.hasValidationErrors = this.validationErrors.length > 0;
    this.validationSuccess = !this.hasValidationErrors;
    this.updateValidationMarkers();
  }

  dismissValidationErrors(): void {
    this.showValidationErrors = false;
    this.validationSuccess = false;
  }

  dismissResults(): void {
    this.showResults = false;
  }

  getResultColumns(): string[] {
    if (!this.queryResults || !this.queryResults.data || this.queryResults.data.length === 0) {
      return [];
    }
    return Object.keys(this.queryResults.data[0]);
  }

  // Grid-to-SQL Synchronization
  private currentGridFilters: GridFilter[] = [];
  private currentGridSorts: GridSort[] = [];
  private currentGridGroups: GridGroup[] = [];
  private isUpdatingFromGrid: boolean = false; // Prevent circular updates
  private isExecutingQuery: boolean = false; // Prevent grid updates during query execution
  private originalQuery: string = ''; // Store original query without grid modifications
  private parsedOriginalQuery: any = null; // Cache parsed original query structure
  private parsedOriginalQueryBase: string = ''; // Track base query string used for cache

  onGridFilterChange(filters: GridFilter[]): void {
    this.currentGridFilters = filters;
    this.updateSQLFromGrid();
  }

  onGridSortChange(sorts: GridSort[]): void {
    this.currentGridSorts = sorts;
    this.updateSQLFromGrid();
  }

  onGridGroupChange(groups: GridGroup[]): void {
    this.currentGridGroups = groups;
    this.updateSQLFromGrid();
  }

  onSQLUpdateRequested(): void {
    this.updateSQLFromGrid();
  }

  private updateSQLFromGrid(): void {
    if (this.isUpdatingFromGrid || !this.sqlQuery.trim() || this.isExecutingQuery) {
      return;
    }

    // Check if there are any grid modifications to apply
    // If no filters, sorts, or groups, keep the original query exactly as is
    const hasGridModifications = 
      (this.currentGridFilters.length > 0) || 
      (this.currentGridSorts.length > 0) || 
      (this.currentGridGroups.length > 0);

    // If no grid modifications, don't rebuild the query - keep it exactly as the user wrote it
    if (!hasGridModifications) {
      // Ensure originalQuery is set (needed the first time grid modifies the query)
      if (!this.originalQuery || this.originalQuery === '') {
        this.originalQuery = this.sqlQuery;
        return;
      }

      // If query currently contains grid modifications, restore the original SQL
      if (this.sqlQuery !== this.originalQuery) {
        this.isUpdatingFromGrid = true;
        try {
          this.sqlQuery = this.originalQuery;

          if (this.editor) {
            const model = this.editor.getModel();
            if (model && model.getLanguageId() !== 'sql') {
              monaco.editor.setModelLanguage(model, 'sql');
            }
            this.editor.setValue(this.sqlQuery);
          }

          this.detectParameters();
          this.queryChangeSubject.next(this.sqlQuery);
        } finally {
          this.isUpdatingFromGrid = false;
        }
      }

      return; // Don't rebuild query if there are no grid modifications
    }

    // Execute immediately for instant updates
    this.isUpdatingFromGrid = true;
    
    try {
      // Store original query if not already stored
      // This should be the base query without any grid modifications
      if (!this.originalQuery || this.originalQuery === '') {
        this.originalQuery = this.sqlQuery;
      }
      
      // If originalQuery is still empty, use current query
      const baseQuery = this.originalQuery || this.sqlQuery;
      if (!baseQuery.trim()) {
        return;
      }
      
      // Parse original SQL (without grid modifications) with caching to avoid repeated parsing
      let parsedQuery: any;
      if (this.parsedOriginalQuery && this.parsedOriginalQueryBase === baseQuery) {
        parsedQuery = this.parsedOriginalQuery;
      } else {
        parsedQuery = this.sqlParserService.parseQuery(baseQuery);
        this.parsedOriginalQuery = parsedQuery;
        this.parsedOriginalQueryBase = baseQuery;
      }
      
      // Build new SQL query with grid filters/sorts/groups
      let newQuery = this.buildSQLFromParsedQuery(parsedQuery, baseQuery);
      
      // Update the query if it changed
      if (newQuery !== this.sqlQuery) {
        this.sqlQuery = newQuery;
        
        // Update Monaco editor immediately
        if (this.editor) {
          // CRITICAL: Ensure language mode is maintained
          const model = this.editor.getModel();
          if (model && model.getLanguageId() !== 'sql') {
            monaco.editor.setModelLanguage(model, 'sql');
          }
          this.editor.setValue(newQuery);
        }
        
        // Trigger change detection (but don't update originalQuery here)
        // Skip the onQueryChange logic that might update originalQuery
        this.detectParameters();
        this.queryChangeSubject.next(this.sqlQuery);
      }
    } catch (error) {
      console.error('Error updating SQL from grid:', error);
    } finally {
      this.isUpdatingFromGrid = false;
    }
  }

  private buildSQLFromParsedQuery(parsedQuery: any, baseQuery: string): string {
    let sql = '';
    
    // Query name comment
    if (parsedQuery.QueryName) {
      sql += `-- ${parsedQuery.QueryName}\n`;
    }
    
    // SELECT clause
    sql += 'SELECT ';
    if (parsedQuery.SelectedFields && parsedQuery.SelectedFields.length > 0) {
      sql += ' ' + parsedQuery.SelectedFields.join(', ') + '';
    } else {
      sql += '*  ';
    }
    
    // FROM clause (extract from base query)
    // Improved extraction to handle:
    // - Schema-qualified table names (e.g., dbo.TableName, schema.table)
    // - Quoted identifiers (e.g., [TableName], "TableName")
    // - Table aliases (e.g., FROM Table AS Alias, FROM Table Alias)
    let fromClause = '';
    
    // Find the FROM keyword position
    const fromIndex = baseQuery.search(/\bFROM\s+/i);
    if (fromIndex !== -1) {
      // Extract everything after FROM
      let afterFrom = baseQuery.substring(fromIndex + 4).trim();
      
      // Find where the FROM clause ends (before WHERE, JOIN, GROUP BY, ORDER BY, HAVING, LIMIT)
      // Use a more flexible approach that handles multi-word keywords
      const stopKeywords = ['WHERE', 'JOIN', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT'];
      let stopPosition = afterFrom.length;
      
      for (const keyword of stopKeywords) {
        const keywordPattern = new RegExp(`\\s+${keyword.replace(/\s+/g, '\\s+')}\\b`, 'i');
        const match = afterFrom.match(keywordPattern);
        if (match && match.index !== undefined && match.index < stopPosition) {
          stopPosition = match.index;
        }
      }
      
      // Extract the FROM clause content
      fromClause = afterFrom.substring(0, stopPosition).trim();
      
      // Clean up any trailing whitespace or commas
      fromClause = fromClause.replace(/[,\s]+$/, '').trim();
    }
    
    // If we successfully extracted a FROM clause, use it
    if (fromClause) {
      sql += ' FROM ' + fromClause;
    } else {
      // Fallback: Try simple regex pattern as last resort
      const fallbackMatch = baseQuery.match(/\bFROM\s+([^\s]+(?:\s+(?:AS\s+)?\w+)?)/i);
      if (fallbackMatch) {
        sql += ' FROM ' + fallbackMatch[1].trim();
      } else {
        // Last resort: Log warning if we couldn't extract FROM clause
        console.warn('Warning: Could not extract FROM clause from base query:', baseQuery.substring(0, 200));
        // Try to preserve any existing FROM clause from the current query
        const currentFromMatch = this.sqlQuery.match(/\bFROM\s+(.+?)(?=\s+(?:WHERE|JOIN|GROUP|ORDER|HAVING|LIMIT)|$)/i);
        if (currentFromMatch) {
          sql += ' FROM ' + currentFromMatch[1].trim();
        }
      }
    }
    
    // JOIN clauses (preserve from base query)
    const joinMatches = baseQuery.match(/((?:INNER|LEFT|RIGHT|FULL)?\s+JOIN\s+[^\s]+(?:\s+(?:AS\s+)?\w+)?\s+ON\s+[^\s]+\s*=\s*[^\s]+)/gi);
    if (joinMatches) {
      joinMatches.forEach(join => {
        sql += join + ' ';
      });
    }
    
    // Detect aggregate fields from SELECT clause for HAVING clause support
    const aggregateFields = new Set<string>();
    const aggregateAliases = new Map<string, string>(); // alias -> original expression
    
    if (parsedQuery.SelectedFields && parsedQuery.SelectedFields.length > 0) {
      parsedQuery.SelectedFields.forEach((field: string) => {
        const fieldUpper = field.toUpperCase().trim();
        // Check if field is an aggregate function (COUNT, SUM, AVG, MAX, MIN)
        const aggregatePattern = /\b(COUNT|SUM|AVG|MAX|MIN)\s*\(/i;
        if (aggregatePattern.test(field)) {
          // Extract alias if present: COUNT(*) AS TotalWorkItems
          const aliasMatch = field.match(/\bAS\s+(\w+)/i);
          if (aliasMatch) {
            const alias = aliasMatch[1].toLowerCase().trim();
            aggregateFields.add(alias);
            aggregateAliases.set(alias, field.trim());
          } else {
            // No alias, use the full expression
            aggregateFields.add(field.toLowerCase().trim());
          }
        }
      });
    }
    
    // WHERE clause - combine original filters with grid filters (avoid duplicates)
    // Separate WHERE and HAVING filters (aggregate fields use HAVING)
    const whereConditions: string[] = [];
    const havingConditions: string[] = [];
    const addedFields = new Map<string, string>(); // Track fields and their conditions to avoid duplicates
    const addedHavingFields = new Map<string, string>(); // Track HAVING fields
    
    // First, add original WHERE filters (from base query, not grid-applied)
    // Only add fields that are NOT in grid filters (grid filters will override)
    if (parsedQuery.WhereClause && parsedQuery.WhereClause.Filters) {
      parsedQuery.WhereClause.Filters.forEach((filter: any) => {
        const fieldName = filter.FieldName?.toLowerCase().trim();
        if (fieldName) {
          // Check if this field has a grid filter - if yes, skip original filter
          const hasGridFilter = this.currentGridFilters.some(gf => 
            gf.field?.toLowerCase().trim() === fieldName
          );
          
          if (!hasGridFilter) {
            const condition = this.buildFilterCondition(filter);
            if (condition) {
              // Check if this is an aggregate field - use HAVING instead of WHERE
              if (aggregateFields.has(fieldName)) {
                const normalizedField = fieldName;
                if (!addedHavingFields.has(normalizedField)) {
                  havingConditions.push(condition);
                  addedHavingFields.set(normalizedField, condition);
                }
              } else {
                // Normalize field name for comparison
                const normalizedField = fieldName;
                if (!addedFields.has(normalizedField)) {
                  whereConditions.push(condition);
                  addedFields.set(normalizedField, condition);
                }
              }
            }
          }
        }
      });
    }
    
    // Then add grid filters (one per field, latest value wins)
    // Use a Map to ensure only one filter per field
    const gridFiltersByField = new Map<string, GridFilter>();
    this.currentGridFilters.forEach(filter => {
      if (filter.field) {
        const normalizedField = filter.field.toLowerCase().trim();
        gridFiltersByField.set(normalizedField, filter);
      }
    });
    
    // Add grid filter conditions - separate WHERE and HAVING
    gridFiltersByField.forEach(filter => {
      const condition = this.buildGridFilterCondition(filter);
      if (condition) {
        const normalizedField = filter.field.toLowerCase().trim();
        
        // Check if this is an aggregate field - use HAVING instead of WHERE
        if (aggregateFields.has(normalizedField)) {
          // Remove any existing HAVING condition for this field
          const existingIndex = havingConditions.findIndex(cond => 
            cond.toLowerCase().startsWith(normalizedField + ' ') ||
            cond.toLowerCase().includes(aggregateAliases.get(normalizedField)?.toLowerCase() || '')
          );
          if (existingIndex >= 0) {
            havingConditions.splice(existingIndex, 1);
          }
          havingConditions.push(condition);
          addedHavingFields.set(normalizedField, condition);
        } else {
          // Regular field - use WHERE
          // Remove any existing condition for this field
          const existingIndex = whereConditions.findIndex(cond => 
            cond.toLowerCase().startsWith(normalizedField + ' ')
          );
          if (existingIndex >= 0) {
            whereConditions.splice(existingIndex, 1);
          }
          whereConditions.push(condition);
          addedFields.set(normalizedField, condition);
        }
      }
    });
    
    // Only add WHERE clause if there are conditions
    // Ensure we don't already have WHERE in the SQL string (safety check)
    if (whereConditions.length > 0) {
      // Remove any trailing WHERE keyword that might have been accidentally included
      // Also check if WHERE already exists in the SQL (shouldn't happen, but safety check)
      if (sql.toUpperCase().includes('WHERE')) {
        console.warn('Warning: WHERE clause already exists in SQL, removing duplicate');
        // Remove any existing WHERE clause from the SQL string
        sql = sql.replace(/\s+WHERE\s+.*$/i, '').trim();
      }
      // Add newline before WHERE (creates blank line), but no newline after
      sql = sql.trim() + '\nWHERE ' + whereConditions.join(' AND ');
    }
    
    // GROUP BY clause - use only grid groups (grid grouping overrides original query GROUP BY)
    const groupByFields: string[] = [];
    const addedGroupFields = new Set<string>();
    
    // Only add GROUP BY if there are grid groups
    // Grid groups override any original GROUP BY from the query
    if (this.currentGridGroups && this.currentGridGroups.length > 0) {
      // Add grid groups only
      this.currentGridGroups.forEach(group => {
        if (group && group.field) {
          const normalized = group.field.trim().toLowerCase();
          if (!addedGroupFields.has(normalized)) {
            groupByFields.push(group.field.trim());
            addedGroupFields.add(normalized);
          }
        }
      });
    } else {
      // No grid groups - preserve original query GROUP BY if it exists
      if (parsedQuery.GroupBy && parsedQuery.GroupBy.length > 0) {
        parsedQuery.GroupBy.forEach((groupField: string) => {
          if (groupField) {
            const normalized = groupField.trim().toLowerCase();
            if (!addedGroupFields.has(normalized)) {
              groupByFields.push(groupField.trim());
              addedGroupFields.add(normalized);
            }
          }
        });
      }
    }
    
    // Only add GROUP BY clause if there are fields to group by
    if (groupByFields.length > 0) {
      // Add newline before GROUP BY (creates blank line), but no newline after
      sql = sql.trim() + '\nGROUP BY ' + groupByFields.join(', ');
    }
    
    // HAVING clause - for filters on aggregate fields
    if (havingConditions.length > 0) {
      // Add newline before HAVING (creates blank line), but no newline after
      sql = sql.trim() + '\nHAVING ' + havingConditions.join(' AND ');
    }
    
    // ORDER BY clause - use grid sorts if available, otherwise use existing
    const orderByFields: string[] = [];
    const addedSortFields = new Set<string>();
    
    if (this.currentGridSorts.length > 0) {
      this.currentGridSorts.forEach(sort => {
        const normalized = sort.field.trim().toLowerCase();
        if (!addedSortFields.has(normalized)) {
          orderByFields.push(sort.field + ' ' + (sort.direction === 'desc' ? 'DESC' : 'ASC'));
          addedSortFields.add(normalized);
        }
      });
    } else if (parsedQuery.Sort && parsedQuery.Sort.length > 0) {
      parsedQuery.Sort.forEach((sort: any) => {
        const normalized = sort.FieldName.trim().toLowerCase();
        if (!addedSortFields.has(normalized)) {
          orderByFields.push(sort.FieldName + ' ' + sort.Direction);
          addedSortFields.add(normalized);
        }
      });
    }
    
    if (orderByFields.length > 0) {
      // Add newline before ORDER BY (creates blank line), but no newline after
      sql = sql.trim() + '\nORDER BY ' + orderByFields.join(', ');
    }
    
    // LIMIT clause (preserve from base query)
    const limitMatch = baseQuery.match(/LIMIT\s+(\d+)/i);
    if (limitMatch) {
      sql += 'LIMIT ' + limitMatch[1] + '\n';
    }
    
    return sql.trim();
  }

  private buildFilterCondition(filter: any): string {
    if (!filter || !filter.FieldName) return '';
    
    const gridCompatibleFilter: GridFilter = {
      field: filter.FieldName,
      operator: filter.Operator !== undefined && filter.Operator !== null ? String(filter.Operator) : '',
      value: filter.Value
    };
    
    return this.buildGridFilterCondition(gridCompatibleFilter);
  }

  private buildGridFilterCondition(filter: GridFilter): string {
    // Check for field and value - allow 0 as a valid value
    // For NULL checks, value can be empty
    const operator = filter.operator || '11'; // Default to Contains (11)
    const isNullCheck = operator === '6' || operator === '7' || 
                       operator === 'IsNULL' || operator === 'IsNotNULL' ||
                       operator.toLowerCase() === 'isnull' || operator.toLowerCase() === 'isnotnull';
    
    if (!filter.field) return '';
    if (!isNullCheck && (filter.value === null || filter.value === undefined || filter.value === '')) return '';
    
    const fieldName = filter.field;
    let value = filter.value;
    
    // Helper function to format numeric/string values
    const formatValue = (val: any): string => {
      if (typeof val === 'number') {
        return String(val);
      } else if (typeof val === 'string') {
        const trimmedValue = val.trim();
        // Preserve SQL parameters without quotes (e.g., @ParamName)
        if (trimmedValue.startsWith('@')) {
          return trimmedValue;
        }
        const isNumeric = /^-?\d+(\.\d+)?$/.test(trimmedValue);
        if (isNumeric) {
          return trimmedValue;
        }
        // Preserve existing quotes
        if (trimmedValue.startsWith("'") || trimmedValue.startsWith('"')) {
          return trimmedValue;
        }
        // Escape single quotes inside the value
        const escapedValue = trimmedValue.replace(/'/g, "''");
        return `'${escapedValue}'`;
      }
      return `'${String(val)}'`;
    };
    
    // Map RelationalOperator enum values to SQL operators
    // Supports both numeric enum values (1-20) and string operator names for backward compatibility
    let sqlOperator = '=';
    const operatorStr = String(operator).toLowerCase().trim();
    const operatorNum = isNaN(parseInt(operatorStr, 10)) ? null : parseInt(operatorStr, 10);
    
    // Determine operator type - check numeric first, then string
    if (operatorNum !== null && operatorNum >= 1 && operatorNum <= 20) {
      // Handle numeric enum values (1-20)
      switch (operatorNum) {
        case 1: // GreaterThan
          sqlOperator = '>';
          value = formatValue(value);
          break;
        case 2: // LessThan
          sqlOperator = '<';
          value = formatValue(value);
          break;
        case 3: // EqualTo
          sqlOperator = '=';
          value = formatValue(value);
          break;
        case 4: // IN
          sqlOperator = 'IN';
          if (Array.isArray(value)) {
            value = '(' + value.map(v => formatValue(v)).join(', ') + ')';
          } else if (typeof value === 'string') {
            const values = value.split(',').map(v => formatValue(v.trim())).join(', ');
            value = `(${values})`;
          } else {
            value = `(${formatValue(value)})`;
          }
          break;
        case 5: // NOTIN
          sqlOperator = 'NOT IN';
          if (Array.isArray(value)) {
            value = '(' + value.map(v => formatValue(v)).join(', ') + ')';
          } else if (typeof value === 'string') {
            const values = value.split(',').map(v => formatValue(v.trim())).join(', ');
            value = `(${values})`;
          } else {
            value = `(${formatValue(value)})`;
          }
          break;
        case 6: // IsNULL
          return `${fieldName} IS NULL`;
        case 7: // IsNotNULL
          return `${fieldName} IS NOT NULL`;
        case 8: // NotEqualTo
          sqlOperator = '!=';
          value = formatValue(value);
          break;
        case 9: // GreaterThanOREqualTo
          sqlOperator = '>=';
          value = formatValue(value);
          break;
        case 10: // LessThanOREqualTo
          sqlOperator = '<=';
          value = formatValue(value);
          break;
        case 11: // Contains
          sqlOperator = 'LIKE';
          value = `'%${value}%'`;
          break;
        case 12: // NotContains
          sqlOperator = 'NOT LIKE';
          value = `'%${value}%'`;
          break;
        case 13: // StartsWith
          sqlOperator = 'LIKE';
          value = `'${value}%'`;
          break;
        case 14: // NotStartsWith
          sqlOperator = 'NOT LIKE';
          value = `'${value}%'`;
          break;
        case 15: // EndsWith
          sqlOperator = 'LIKE';
          value = `'%${value}'`;
          break;
        case 16: // NotEndsWith
          sqlOperator = 'NOT LIKE';
          value = `'%${value}'`;
          break;
        case 17: // Between
          sqlOperator = 'BETWEEN';
          if (Array.isArray(value) && value.length >= 2) {
            value = `${formatValue(value[0])} AND ${formatValue(value[1])}`;
          } else if (typeof value === 'string') {
            const parts = value.split(',').map(v => v.trim());
            if (parts.length >= 2) {
              value = `${formatValue(parts[0])} AND ${formatValue(parts[1])}`;
            } else {
              value = formatValue(value);
            }
          } else {
            value = formatValue(value);
          }
          break;
        case 18: // NotBetween
          sqlOperator = 'NOT BETWEEN';
          if (Array.isArray(value) && value.length >= 2) {
            value = `${formatValue(value[0])} AND ${formatValue(value[1])}`;
          } else if (typeof value === 'string') {
            const parts = value.split(',').map(v => v.trim());
            if (parts.length >= 2) {
              value = `${formatValue(parts[0])} AND ${formatValue(parts[1])}`;
            } else {
              value = formatValue(value);
            }
          } else {
            value = formatValue(value);
          }
          break;
        case 19: // SplitContains
          sqlOperator = 'LIKE';
          value = `'%${value}%'`;
          break;
        case 20: // NotSplitContains
          sqlOperator = 'NOT LIKE';
          value = `'%${value}%'`;
          break;
        default:
          sqlOperator = 'LIKE';
          value = `'%${value}%'`;
      }
    } else {
      // Handle string operator names for backward compatibility
      switch (operatorStr) {
        case 'greaterthan':
        case '>':
          sqlOperator = '>';
          value = formatValue(value);
          break;
        case 'lessthan':
        case '<':
          sqlOperator = '<';
          value = formatValue(value);
          break;
        case 'equal':
        case 'equalto':
        case '=':
          sqlOperator = '=';
          value = formatValue(value);
          break;
        case 'in':
          sqlOperator = 'IN';
          if (Array.isArray(value)) {
            value = '(' + value.map(v => formatValue(v)).join(', ') + ')';
          } else if (typeof value === 'string') {
            const values = value.split(',').map(v => formatValue(v.trim())).join(', ');
            value = `(${values})`;
          } else {
            value = `(${formatValue(value)})`;
          }
          break;
        case 'notin':
        case 'not in':
          sqlOperator = 'NOT IN';
          if (Array.isArray(value)) {
            value = '(' + value.map(v => formatValue(v)).join(', ') + ')';
          } else if (typeof value === 'string') {
            const values = value.split(',').map(v => formatValue(v.trim())).join(', ');
            value = `(${values})`;
          } else {
            value = `(${formatValue(value)})`;
          }
          break;
        case 'isnull':
        case 'is null':
          return `${fieldName} IS NULL`;
        case 'isnotnull':
        case 'is not null':
          return `${fieldName} IS NOT NULL`;
        case 'notequal':
        case 'notequalto':
        case '!=':
        case '<>':
          sqlOperator = '!=';
          value = formatValue(value);
          break;
        case 'greaterthanorequal':
        case 'greaterthanorequalto':
        case '>=':
          sqlOperator = '>=';
          value = formatValue(value);
          break;
        case 'lessthanorequal':
        case 'lessthanorequalto':
        case '<=':
          sqlOperator = '<=';
          value = formatValue(value);
          break;
        case 'contains':
          sqlOperator = 'LIKE';
          value = `'%${value}%'`;
          break;
        case 'notcontains':
          sqlOperator = 'NOT LIKE';
          value = `'%${value}%'`;
          break;
        case 'startswith':
          sqlOperator = 'LIKE';
          value = `'${value}%'`;
          break;
        case 'notstartswith':
          sqlOperator = 'NOT LIKE';
          value = `'${value}%'`;
          break;
        case 'endswith':
          sqlOperator = 'LIKE';
          value = `'%${value}'`;
          break;
        case 'notendswith':
          sqlOperator = 'NOT LIKE';
          value = `'%${value}'`;
          break;
        case 'between':
          sqlOperator = 'BETWEEN';
          if (Array.isArray(value) && value.length >= 2) {
            value = `${formatValue(value[0])} AND ${formatValue(value[1])}`;
          } else if (typeof value === 'string') {
            const parts = value.split(',').map(v => v.trim());
            if (parts.length >= 2) {
              value = `${formatValue(parts[0])} AND ${formatValue(parts[1])}`;
            } else {
              value = formatValue(value);
            }
          } else {
            value = formatValue(value);
          }
          break;
        case 'notbetween':
          sqlOperator = 'NOT BETWEEN';
          if (Array.isArray(value) && value.length >= 2) {
            value = `${formatValue(value[0])} AND ${formatValue(value[1])}`;
          } else if (typeof value === 'string') {
            const parts = value.split(',').map(v => v.trim());
            if (parts.length >= 2) {
              value = `${formatValue(parts[0])} AND ${formatValue(parts[1])}`;
            } else {
              value = formatValue(value);
            }
          } else {
            value = formatValue(value);
          }
          break;
        case 'splitcontains':
          sqlOperator = 'LIKE';
          value = `'%${value}%'`;
          break;
        case 'notsplitcontains':
          sqlOperator = 'NOT LIKE';
          value = `'%${value}%'`;
          break;
        default:
          sqlOperator = 'LIKE';
          value = `'%${value}%'`;
      }
    }
    
    return `${fieldName} ${sqlOperator} ${value}`;
  }

  validateParameters(): boolean {
    return this.parameters.every(p => {
      if (!p.required) return true;
      return p.value !== null && p.value !== undefined && p.value !== '';
    });
  }

  clearEditor(): void {
    if (confirm('Are you sure you want to clear the editor?')) {
      this.sqlQuery = '';
      this.parameters = [];
      this.hasValidationErrors = false;
      if (this.editor) {
        this.editor.setValue('');
      }
    }
  }

  onTabChange(tab: 'sql' | 'visual' | 'json'): void {
    this.activeTab = tab;
    
    if (tab === 'sql') {
      // When switching back to SQL tab, ensure Monaco Editor is initialized and shows current SQL
      setTimeout(() => {
        if (!this.editorInitialized || !this.editor) {
          this.initializeMonacoEditor();
        } else {
          // Editor exists - update with current SQL and layout
          if (this.editor) {
            const currentValue = this.editor.getValue();
            // Only update if SQL query has changed (to avoid losing cursor position unnecessarily)
            if (currentValue !== this.sqlQuery) {
              this.editor.setValue(this.sqlQuery);
              // Move cursor to end of query for better UX
              const lineCount = this.editor.getModel()?.getLineCount() || 1;
              this.editor.setPosition({ lineNumber: lineCount, column: 1 });
            }
            // Always refresh layout when switching tabs
            setTimeout(() => {
              this.editor?.layout();
            }, 0);
          }
        }
      }, 50);
    }
    
    if (tab === 'visual') {
      // When switching to Visual Builder, trigger parsing
      // Toggle forceParse to trigger ngOnChanges in the visual builder
      this.forceVisualParse = !this.forceVisualParse;
    }
    
    if (tab === 'json') {
      // Generate JSON representation in the format: QueryObjectID, ResultField_AppfieldIds, WhereClause, etc.
      try {
        const jsonQuery = this.sqlParserService.sqlToJson(this.sqlQuery, this.schemaData);
        this.jsonInput = JSON.stringify(jsonQuery, null, 2);
        this.formattedQuery = '';
      } catch (error: any) {
        this.jsonInput = '';
        this.formattedQuery = `Error converting SQL to JSON: ${error.message}`;
      }
    }
  }

  onVisualBuilderSQLChange(newSQL: string): void {
    // Update SQL query from visual builder (debounced by 300ms in the component)
    if (newSQL !== this.sqlQuery) {
      this.sqlQuery = newSQL;
      
      // Update Monaco editor if it exists
      if (this.editor) {
        // Only update if value is different to avoid cursor position loss
        const currentValue = this.editor.getValue();
        if (currentValue !== newSQL) {
          // Save cursor position
          const position = this.editor.getPosition();
          this.editor.setValue(newSQL);
          // Restore cursor position if possible, otherwise move to end
          if (position) {
            const lineCount = this.editor.getModel()?.getLineCount() || 1;
            if (position.lineNumber <= lineCount) {
              this.editor.setPosition(position);
            } else {
              this.editor.setPosition({ lineNumber: lineCount, column: 1 });
            }
          }
          // Refresh layout
          setTimeout(() => {
            this.editor?.layout();
          }, 0);
        }
      }
      
      // Trigger change detection (but don't update editor again to avoid loop)
      this.detectParameters();
      // Don't call onQueryChange() here as it might trigger editor update again
      // Just update the query change subject for validation
      this.queryChangeSubject.next(this.sqlQuery);
    }
  }

  onVisualBuilderWarning(warning: string): void {
    // Show warning toast when visual builder encounters parsing issues
    if (warning) {
      this.toastService.warning(warning, 'Visual Builder Warning');
    }
  }

  // Drag and Drop handlers
  onDragEnter(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    
    const data = event.dataTransfer?.getData('text/plain');
    if (data && this.editor) {
      const position = this.editor.getPosition();
      if (position) {
        // Handle table drops (TABLE: prefix) and field drops
        const insertText = data.startsWith('TABLE:') 
          ? data.substring(6) // Remove TABLE: prefix
          : data;
        
        // Insert text at cursor position
        const range = new monaco.Range(
          position.lineNumber,
          position.column,
          position.lineNumber,
          position.column
        );
        
        const op = { range, text: insertText + ' ' };
        this.editor.executeEdits('drop-insert', [op]);
        
        // Move cursor after inserted text
        const newPosition = new monaco.Position(
          position.lineNumber,
          position.column + insertText.length + 1
        );
        this.editor.setPosition(newPosition);
        this.editor.focus();
      }
    }
  }

  onParameterChange(param: QueryParameter): void {
    // Handle parameter value changes
  }

  getLineAndColumn(): string {
    if (!this.editor) return '';
    
    const position = this.editor.getPosition();
    if (!position) return '';
    
    return `Ln ${position.lineNumber}, Col ${position.column}`;
  }

  /**
   * Convert JSON query object to SQL and update the SQL editor
   */
  convertJsonToSql(): void {
    if (!this.jsonInput || this.jsonInput.trim() === '') {
      this.toastService.warning('Please paste a JSON query object', 'No JSON Input');
      return;
    }

    try {
      const jsonQuery = JSON.parse(this.jsonInput);
      const sqlQuery = this.sqlParserService.jsonToSql(jsonQuery);
      
      // Update SQL query
      this.sqlQuery = sqlQuery;
      
      // Update Monaco editor
      if (this.editor) {
        // CRITICAL: Ensure language mode is maintained
        const model = this.editor.getModel();
        if (model && model.getLanguageId() !== 'sql') {
          monaco.editor.setModelLanguage(model, 'sql');
        }
        this.editor.setValue(sqlQuery);
      }
      
      // Update formatted query display
      this.formattedQuery = sqlQuery;
      
      // Trigger change detection
      this.onQueryChange();
      
      // Switch to SQL tab to show the converted query
      this.activeTab = 'sql';
      
      this.toastService.success('JSON converted to SQL successfully', 'Conversion Success');
    } catch (error: any) {
      this.toastService.error(`Error converting JSON to SQL: ${error.message}`, 'Conversion Error');
      this.formattedQuery = `Error: ${error.message}`;
    }
  }

  /**
   * Load JSON representation from current SQL query
   */
  loadJsonFromSql(): void {
    try {
      const jsonQuery = this.sqlParserService.sqlToJson(this.sqlQuery, this.schemaData);
      this.jsonInput = JSON.stringify(jsonQuery, null, 2);
      this.formattedQuery = '';
      this.toastService.success('JSON loaded from SQL successfully', 'Load Success');
    } catch (error: any) {
      this.toastService.error(`Error loading JSON from SQL: ${error.message}`, 'Load Error');
      this.jsonInput = '';
      this.formattedQuery = `Error: ${error.message}`;
    }
  }

  // ==================== QUERY MANAGEMENT METHODS ====================

  openSaveQueryModal(): void {
    // Check if we're editing an existing query
    if (this.currentQueryId) {
      this.queryManagementService.getSavedQuery(this.currentQueryId).subscribe(query => {
        if (query) {
          this.editingQuery = query;
        }
        this.showSaveQueryModal = true;
      });
    } else {
      this.editingQuery = null;
      this.showSaveQueryModal = true;
    }
  }

  closeSaveQueryModal(): void {
    this.showSaveQueryModal = false;
    this.editingQuery = null;
  }

  onSaveQuery(queryData: Omit<SavedQuery, 'id' | 'createdTimestamp' | 'updatedTimestamp' | 'executionCount' | 'isFavorite'>): void {
    if (this.editingQuery) {
      // Update existing query
      this.queryManagementService.updateQuery(this.editingQuery.id, queryData).subscribe({
        next: (updatedQuery) => {
          this.toastService.success(`Query "${updatedQuery.name}" updated successfully`, 'Success');
          this.currentQueryId = updatedQuery.id;
          this.closeSaveQueryModal();
        },
        error: (error) => {
          this.toastService.error('Failed to update query', 'Error');
          console.error('Error updating query:', error);
        }
      });
    } else {
      // Save new query
      this.queryManagementService.saveQuery(queryData).subscribe({
        next: (savedQuery) => {
          this.toastService.success(`Query "${savedQuery.name}" saved successfully`, 'Success');
          this.currentQueryId = savedQuery.id;
          this.closeSaveQueryModal();
        },
        error: (error) => {
          this.toastService.error('Failed to save query', 'Error');
          console.error('Error saving query:', error);
        }
      });
    }
  }

  openSavedQueriesSidebar(): void {
    this.showSavedQueriesSidebar = true;
  }

  closeSavedQueriesSidebar(): void {
    this.showSavedQueriesSidebar = false;
  }

  onLoadSavedQuery(query: SavedQuery): void {
    // Load SQL
    this.sqlQuery = query.sqlText;
    if (this.editor) {
      // CRITICAL: Ensure language mode is maintained
      const model = this.editor.getModel();
      if (model && model.getLanguageId() !== 'sql') {
        monaco.editor.setModelLanguage(model, 'sql');
      }
      this.editor.setValue(query.sqlText);
    }

    // Update original query
    this.originalQuery = query.sqlText;

    // Trigger change detection (this will detect parameters)
    this.onQueryChange();

    // Load parameters if available (after detection)
    if (query.parameterValues) {
      setTimeout(() => {
        this.parameters.forEach(param => {
          if (query.parameterValues && query.parameterValues[param.name] !== undefined) {
            param.value = query.parameterValues[param.name];
          }
        });
      }, 0);
    }

    // Set current query ID
    this.currentQueryId = query.id;

    // Close sidebar
    this.closeSavedQueriesSidebar();

    // Show toast
    this.toastService.success(`Query loaded: ${query.name}`, 'Query Loaded');
  }

  onEditSavedQuery(query: SavedQuery): void {
    // Load the query first
    this.onLoadSavedQuery(query);
    // Then open the save modal in edit mode
    this.editingQuery = query;
    this.showSaveQueryModal = true;
  }

  openQueryHistorySidebar(): void {
    this.showQueryHistorySidebar = true;
  }

  closeQueryHistorySidebar(): void {
    this.showQueryHistorySidebar = false;
  }

  onLoadQueryFromHistory(historyItem: QueryHistory): void {
    // Load SQL
    this.sqlQuery = historyItem.sqlText;
    if (this.editor) {
      // CRITICAL: Ensure language mode is maintained
      const model = this.editor.getModel();
      if (model && model.getLanguageId() !== 'sql') {
        monaco.editor.setModelLanguage(model, 'sql');
      }
      this.editor.setValue(historyItem.sqlText);
    }

    // Update original query
    this.originalQuery = historyItem.sqlText;

    // Trigger change detection (this will detect parameters)
    this.onQueryChange();

    // Load parameters if available (after detection)
    if (historyItem.parameterValues) {
      setTimeout(() => {
        this.parameters.forEach(param => {
          if (historyItem.parameterValues && historyItem.parameterValues[param.name] !== undefined) {
            param.value = historyItem.parameterValues[param.name];
          }
        });
      }, 0);
    }

    // Set current query ID if it was from a saved query
    this.currentQueryId = historyItem.savedQueryId || null;

    // Close sidebar
    this.closeQueryHistorySidebar();

    // Show toast
    this.toastService.success('Query loaded from history', 'Query Loaded');
  }

  getQueryJson(): any {
    try {
      return this.sqlParserService.sqlToJson(this.sqlQuery, this.schemaData);
    } catch (error) {
      return null;
    }
  }

  getParameterValues(): { [key: string]: any } {
    const paramsObj: { [key: string]: any } = {};
    this.parameters.forEach(param => {
      if (param.value !== null && param.value !== undefined && param.value !== '') {
        paramsObj[param.name] = param.value;
      }
    });
    return paramsObj;
  }
}
