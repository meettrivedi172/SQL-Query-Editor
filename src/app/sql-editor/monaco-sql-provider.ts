import * as monaco from 'monaco-editor';

/**
 * SQL Completion Provider for Monaco Editor
 * Provides IntelliSense-style autocomplete for SQL table names and fields
 */
export class SqlCompletionProvider implements monaco.languages.CompletionItemProvider {
  private tableNames: string[] = [];
  private schemaData: Map<string, string[]> = new Map(); // tableName -> fieldNames[]
  private aliasToTableMap: Map<string, string> = new Map(); // alias -> tableName

  constructor(
    tableNames: string[],
    schemaData?: Map<string, string[]>
  ) {
    this.tableNames = tableNames.map(name => name.toLowerCase());
    if (schemaData) {
      this.schemaData = schemaData;
    }
  }

  /**
   * Update the table names for autocomplete
   */
  updateTables(tableNames: string[]): void {
    this.tableNames = tableNames.map(name => name.toLowerCase());
  }

  /**
   * Update schema data (table -> fields mapping)
   */
  updateSchema(schemaData: Map<string, string[]>): void {
    this.schemaData = schemaData;
  }

  /**
   * Trigger characters for autocomplete - SSMS-like behavior
   * CRITICAL: Include space, newline, and common SQL characters to trigger suggestions
   */
  triggerCharacters = ['.', ' ', '\n', '\t', ',', '(', ')', '=', '<', '>', '!', ';'];
  
  // Note: triggerKind is not a valid property, removed

  /**
   * Main completion provider method
   * SIMPLIFIED: Always provides suggestions based on simple pattern matching
   */
  provideCompletionItems(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    context: monaco.languages.CompletionContext
  ): monaco.languages.ProviderResult<monaco.languages.CompletionList> {
    // DEBUG: Log when completion provider is called
    console.log('[CompletionProvider] Called - Line:', position.lineNumber, 'Col:', position.column, 'Trigger:', context.triggerKind);
    
    // CRITICAL FIX: Always extract word from current line manually
    // Monaco's getWordAtPosition doesn't work reliably for partial words
    const currentLine = model.getLineContent(position.lineNumber);
    const lineBeforeCursor = currentLine.substring(0, position.column - 1);
    
    // Extract the word being typed (word characters at the end of line before cursor)
    const wordMatch = lineBeforeCursor.match(/(\w+)$/);
    let word: { word: string; startColumn: number; endColumn: number };
    
    if (wordMatch && wordMatch[1]) {
      const wordText = wordMatch[1];
      const matchStart = position.column - wordText.length;
      word = {
        word: wordText,
        startColumn: matchStart,
        endColumn: position.column
      };
      console.log('[CompletionProvider] Extracted word from line:', word.word, 'at col', matchStart, '-', position.column);
    } else {
      // No word found, use empty word
      word = {
        word: '',
        startColumn: position.column,
        endColumn: position.column
      };
      console.log('[CompletionProvider] No word found at cursor');
    }
    
    const range = {
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn: word.startColumn,
      endColumn: word.endColumn
    };

    // Get recent text (last 300 chars) for context - SIMPLE and FAST
    // CRITICAL: Get text from current line and previous lines for better context
    const fullTextBeforeCursor = model.getValueInRange({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: position.lineNumber,
      endColumn: position.column
    });
    
    // Get current line and previous lines (up to 5 lines back) for better context
    const linesToCheck = Math.max(1, position.lineNumber - 5);
    const contextText = model.getValueInRange({
      startLineNumber: linesToCheck,
      startColumn: 1,
      endLineNumber: position.lineNumber,
      endColumn: position.column
    });
    
    const recentText = contextText.substring(Math.max(0, contextText.length - 300));
    const recentTextTrimmed = recentText.trim();
    const recentTextUpper = recentText.toUpperCase();

    // Always extract aliases (simple and reliable - no complex caching)
    this.extractTableAliases(fullTextBeforeCursor);

    const suggestions: monaco.languages.CompletionItem[] = [];
    const wordLower = word.word.toLowerCase();
    
    // SIMPLE PATTERN MATCHING: Check what user is typing and what comes before
    
    // 1. Check if after a dot (table.field) - highest priority
    const lastDotIndex = recentText.lastIndexOf('.');
    if (lastDotIndex > 0 && lastDotIndex >= recentText.length - 20) {
      const textAfterDot = recentText.substring(lastDotIndex + 1).trim();
      if (textAfterDot.length <= 5) {
        const textBeforeDot = recentText.substring(Math.max(0, lastDotIndex - 50), lastDotIndex).trim();
        const tableMatch = textBeforeDot.match(/(\w+)\s*$/);
        if (tableMatch) {
          const aliasOrTable = tableMatch[1].toLowerCase();
          const tableName = this.getTableNameForAlias(aliasOrTable) || aliasOrTable;
          const fields = this.schemaData.get(tableName) || [];
          
          fields.forEach(fieldName => {
            const fieldNameLower = fieldName.toLowerCase();
            if (word.word === '' || fieldNameLower.startsWith(wordLower) || fieldNameLower.includes(wordLower)) {
              suggestions.push({
                label: fieldName,
                kind: monaco.languages.CompletionItemKind.Field,
                documentation: `Field from ${aliasOrTable}`,
                insertText: fieldName,
                range: range,
                sortText: '1' + fieldName.toLowerCase()
              });
            }
          });
          
          if (suggestions.length > 0) {
            return { suggestions, incomplete: false };
          }
        }
      }
    }
    
    // 2. Check if after FROM, JOIN, or AS - show table names
    // BUT: Don't block keywords - show both tables AND keywords
    const isAfterFrom = /\bFROM\s+\w*\s*$/i.test(recentTextTrimmed) || /\bFROM\s+AS\s*$/i.test(recentTextTrimmed);
    const isAfterJoin = /\b(INNER|LEFT|RIGHT|FULL|OUTER|CROSS)?\s*JOIN\s+\w*\s*$/i.test(recentTextTrimmed) || 
                       /\b(INNER|LEFT|RIGHT|FULL|OUTER|CROSS)?\s*JOIN\s*$/i.test(recentTextTrimmed);
    const isAfterAs = /\bAS\s+\w*\s*$/i.test(recentTextTrimmed) || /\bAS\s*$/i.test(recentTextTrimmed);
    
    // CRITICAL: Only show tables if user hasn't typed a keyword-like pattern
    // If user typed "inn", "inne", "whe", etc., they want keywords, not tables
    const isTypingKeyword = wordLower.length >= 2 && (
      wordLower.startsWith('inn') || wordLower.startsWith('whe') || 
      wordLower.startsWith('se') || wordLower.startsWith('fr') ||
      wordLower.startsWith('gro') || wordLower.startsWith('order') ||
      wordLower.startsWith('left') || wordLower.startsWith('right')
    );
    
    if ((isAfterFrom || isAfterJoin || isAfterAs) && !isTypingKeyword) {
      const filterWord = wordLower === 'as' ? '' : wordLower;
      this.tableNames.forEach(tableName => {
        const tableNameLower = tableName.toLowerCase();
        if (filterWord === '' || tableNameLower.startsWith(filterWord) || tableNameLower.includes(filterWord)) {
          suggestions.push({
            label: tableName,
            kind: monaco.languages.CompletionItemKind.Class,
            documentation: `Table: ${this.getTableDisplayName(tableName)}`,
            insertText: tableName,
            range: range,
            sortText: '1' + tableNameLower
          });
        }
      });
    }
    
    // 3. Check if in WHERE, ORDER BY, GROUP BY - show fields and aliases
    const isInWhere = recentTextUpper.includes('WHERE') && !recentTextUpper.endsWith('WHERE');
    const isInOrderBy = recentTextUpper.includes('ORDER BY') && !recentTextUpper.endsWith('ORDER BY');
    const isInGroupBy = recentTextUpper.includes('GROUP BY') && !recentTextUpper.endsWith('GROUP BY');
    
    if (isInWhere || isInOrderBy || isInGroupBy) {
      // Check if user has typed a table prefix (like "table." or "alias.")
      // If they typed a dot, the logic above (section 1) already handles showing fields
      // So here we only show suggestions when NOT after a dot
      const hasTablePrefix = lastDotIndex > 0 && lastDotIndex >= recentText.length - 20;
      
      if (!hasTablePrefix) {
        // Show table aliases (for users who want to specify table.field)
        this.aliasToTableMap.forEach((tableName, alias) => {
          if (word.word === '' || alias.includes(wordLower) || alias.startsWith(wordLower)) {
            suggestions.push({
              label: alias,
              kind: monaco.languages.CompletionItemKind.Variable,
              documentation: `Table alias for ${tableName}`,
              insertText: alias,
              range: range,
              sortText: '0' + alias
            });
          }
        });
        
        // Show fields directly without table prefix (default behavior)
        // Collect all fields from all tables and show them directly
        const allFields = new Set<string>(); // Use Set to avoid duplicates
        
        this.aliasToTableMap.forEach((tableName, alias) => {
          const fields = this.schemaData.get(tableName) || [];
          fields.forEach(fieldName => {
            // Only add if field name doesn't already exist (avoid duplicates)
            if (!allFields.has(fieldName.toLowerCase())) {
              allFields.add(fieldName.toLowerCase());
              
              const fieldNameLower = fieldName.toLowerCase();
              if (word.word === '' || fieldNameLower.startsWith(wordLower) || fieldNameLower.includes(wordLower)) {
                suggestions.push({
                  label: fieldName,
                  kind: monaco.languages.CompletionItemKind.Field,
                  documentation: `Field ${fieldName}`,
                  insertText: fieldName,
                  range: range,
                  sortText: '1' + fieldNameLower
                });
              }
            }
          });
        });
      } else {
        // User has typed a table prefix, show fields with prefix (handled by section 1 above)
        // But also show table aliases for completion
        this.aliasToTableMap.forEach((tableName, alias) => {
          if (word.word === '' || alias.includes(wordLower) || alias.startsWith(wordLower)) {
            suggestions.push({
              label: alias,
              kind: monaco.languages.CompletionItemKind.Variable,
              documentation: `Table alias for ${tableName}`,
              insertText: alias,
              range: range,
              sortText: '0' + alias
            });
          }
        });
      }
    }
    
    // 4. ALWAYS show SQL keywords with partial matching (simple pattern matching)
    // CRITICAL: This must work even on new lines after pressing Enter
    // CRITICAL: Show keywords ALWAYS when user types 2+ characters that match
    const sqlKeywords = this.getSqlKeywords();
    
    // Check if user is typing something - ALWAYS show matching keywords
    // Show suggestions for 1+ chars to appear immediately
    if (word.word.length >= 1) {
      sqlKeywords.forEach(keyword => {
        const keywordLower = keyword.toLowerCase();
        
        // Simple pattern matching - be more aggressive:
        // - "s" → "SELECT" (starts with)
        // - "se" → "SELECT"
        // - "fr" → "FROM"
        // - "whe" → "WHERE"
        // - "inn" → "INNER"
        // - "inne" → "INNER"
        // - "gro" → "GROUP"
        // - "order" → "ORDER"
        // For 1 char, only show if keyword starts with that char (to avoid too many suggestions)
        // For 2+ chars, show if keyword starts with or contains the typed text
        const matches = word.word.length === 1
          ? keywordLower.startsWith(wordLower)  // For 1 char, only show keywords that start with it
          : (keywordLower.startsWith(wordLower) || keywordLower.includes(wordLower));  // For 2+ chars, be more flexible
        
        if (matches) {
          // Special handling for multi-word keywords
          let insertText = keyword;
          let sortPriority = '9'; // Lower priority for keywords
          
          // Handle "ORDER BY" and "GROUP BY"
          if (wordLower === 'order' || wordLower.startsWith('order')) {
            if (keyword === 'ORDER') {
              insertText = 'ORDER BY';
              sortPriority = '0'; // Higher priority
            }
          } else if (wordLower === 'gro' || wordLower === 'group' || wordLower.startsWith('gro')) {
            if (keyword === 'GROUP') {
              insertText = 'GROUP BY';
              sortPriority = '0'; // Higher priority
            }
          } else if (wordLower === 'whe' || wordLower === 'wher' || wordLower === 'where' || wordLower.startsWith('whe')) {
            if (keyword === 'WHERE') {
              sortPriority = '0'; // Higher priority for WHERE
            }
          } else if (wordLower === 'se' || wordLower === 'sel' || wordLower.startsWith('se')) {
            if (keyword === 'SELECT') {
              sortPriority = '0'; // Higher priority for SELECT
            }
          } else if (wordLower === 'fr' || wordLower === 'fro' || wordLower.startsWith('fr')) {
            if (keyword === 'FROM') {
              sortPriority = '0'; // Higher priority for FROM
            }
          } else if (wordLower === 'inn' || wordLower === 'inne' || wordLower.startsWith('inn')) {
            if (keyword === 'INNER') {
              sortPriority = '0'; // Higher priority for INNER
            }
          }
          
          suggestions.push({
            label: keyword,
            kind: monaco.languages.CompletionItemKind.Keyword,
            documentation: `SQL keyword: ${keyword}`,
            insertText: insertText,
            range: range,
            sortText: sortPriority + keywordLower,
            preselect: keywordLower === wordLower || keywordLower.startsWith(wordLower)
          });
        }
      });
    } else if (word.word.length === 0 && context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter) {
      // Show all keywords on trigger characters (space, newline, etc.)
      sqlKeywords.forEach(keyword => {
        const keywordLower = keyword.toLowerCase();
        suggestions.push({
          label: keyword,
          kind: monaco.languages.CompletionItemKind.Keyword,
          documentation: `SQL keyword: ${keyword}`,
          insertText: keyword,
          range: range,
          sortText: '9' + keywordLower
        });
      });
    }
    
    // CRITICAL FALLBACK: If user typed something but got no suggestions, show keywords anyway
    // This ensures suggestions ALWAYS appear when typing (even for 1 char)
    if (suggestions.length === 0 && word.word.length >= 1) {
      console.log('[CompletionProvider] No suggestions found, showing keywords for:', word.word);
      const sqlKeywords = this.getSqlKeywords();
      sqlKeywords.forEach(keyword => {
        const keywordLower = keyword.toLowerCase();
        if (keywordLower.startsWith(wordLower) || keywordLower.includes(wordLower)) {
          let insertText = keyword;
          let sortPriority = '0';
          
          if (wordLower.startsWith('gro') && keyword === 'GROUP') {
            insertText = 'GROUP BY';
          } else if (wordLower.startsWith('order') && keyword === 'ORDER') {
            insertText = 'ORDER BY';
          }
          
          suggestions.push({
            label: keyword,
            kind: monaco.languages.CompletionItemKind.Keyword,
            documentation: `SQL keyword: ${keyword}`,
            insertText: insertText,
            range: range,
            sortText: sortPriority + keywordLower,
            preselect: keywordLower.startsWith(wordLower)
          });
        }
      });
    }
    
    console.log('[CompletionProvider] Returning', suggestions.length, 'suggestions');
    
    // Return all suggestions
    return {
      suggestions: suggestions,
      incomplete: false
    };
  }

  /**
   * Extract table aliases from the query text
   * Improved to handle long queries with multiple JOINs
   */
  private extractTableAliases(text: string): void {
    this.aliasToTableMap.clear();
    
    // SQL keywords that shouldn't be treated as aliases
    const sqlKeywords = new Set(['as', 'on', 'inner', 'left', 'right', 'full', 'outer', 'join', 'where', 'group', 'order', 'having', 'limit', 'offset', 'union', 'select', 'from', 'insert', 'update', 'delete', 'by', 'and', 'or', 'not', 'in', 'like', 'between', 'is', 'null']);
    
    // Extract FROM table and alias
    // Patterns: FROM table, FROM table alias, FROM table AS alias
    // Match table names with underscores: \w+ matches [a-zA-Z0-9_]
    const fromPattern = /FROM\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?/gi;
    let fromMatch;
    while ((fromMatch = fromPattern.exec(text)) !== null) {
      const tableName = fromMatch[1].toLowerCase();
      let alias = fromMatch[2]?.toLowerCase();
      
      // Get the full match text and what comes after
      const matchEnd = fromMatch.index + fromMatch[0].length;
      const afterMatch = text.substring(matchEnd).trim();
      
      // If no alias was captured by regex, check if next word is an alias
      if (!alias && afterMatch) {
        const nextWordMatch = afterMatch.match(/^(\w+)/);
        if (nextWordMatch) {
          const nextWord = nextWordMatch[1].toLowerCase();
          // If next word is not a SQL keyword, treat it as alias
          if (!sqlKeywords.has(nextWord)) {
            alias = nextWord;
          }
        }
      }
      
      // Map alias to table if alias exists and is not a keyword
      if (alias && !sqlKeywords.has(alias)) {
        this.aliasToTableMap.set(alias, tableName);
      }
      // Always map table name to itself (can use table name as alias)
      this.aliasToTableMap.set(tableName, tableName);
    }
    
    // Extract JOIN tables and aliases
    // Patterns: JOIN table, JOIN table alias, JOIN table AS alias
    // Handle: INNER JOIN, LEFT JOIN, RIGHT JOIN, FULL JOIN, CROSS JOIN
    const joinPattern = /(?:INNER|LEFT|RIGHT|FULL|CROSS)?\s+JOIN\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?/gi;
    let joinMatch;
    while ((joinMatch = joinPattern.exec(text)) !== null) {
      const tableName = joinMatch[1].toLowerCase();
      let alias = joinMatch[2]?.toLowerCase();
      
      // If no alias was captured, check next word
      if (!alias) {
        const afterMatch = text.substring(joinMatch.index + joinMatch[0].length).trim();
        const nextWordMatch = afterMatch.match(/^(\w+)/);
        if (nextWordMatch) {
          const nextWord = nextWordMatch[1].toLowerCase();
          // Next word should not be 'ON' or any SQL keyword
          if (nextWord !== 'on' && !sqlKeywords.has(nextWord)) {
            alias = nextWord;
          }
        }
      }
      
      // Map alias to table if alias exists and is not a keyword
      if (alias && !sqlKeywords.has(alias)) {
        this.aliasToTableMap.set(alias, tableName);
      }
      // Always map table name to itself
      this.aliasToTableMap.set(tableName, tableName);
    }
  }

  /**
   * Get table name for a given alias
   */
  private getTableNameForAlias(aliasOrTable: string): string | null {
    return this.aliasToTableMap.get(aliasOrTable.toLowerCase()) || null;
  }

  /**
   * Detect the SQL context to determine what to suggest
   * Improved for long queries - analyzes full query context
   * OPTIMIZED: Uses smaller text chunks for faster processing
   */
  private detectSqlContext(text: string, position: monaco.Position): {
    needsTableNames: boolean;
    needsFieldNames: boolean;
    needsTableAliases: boolean;
    currentTable: string | null;
    aliasOrTable: string | null;
    isAfterDot: boolean;
  } {
    // OPTIMIZATION: Use smaller text chunk for faster processing
    // 300 chars is sufficient for context detection
    const recentText = text.substring(Math.max(0, text.length - 300));
    const textUpper = recentText.toUpperCase();
    
    let needsTableNames = false;
    let needsFieldNames = false;
    let needsTableAliases = false;
    let currentTable: string | null = null;
    let aliasOrTable: string | null = null;
    let isAfterDot = false;

    const recentTextUpper = recentText.toUpperCase().trim();
    
    // OPTIMIZATION: Check for dot in recent text only (faster)
    // Check if cursor is immediately after a dot (table.field context)
    // CRITICAL: This must work in WHERE clause too!
    // CRITICAL: Only detect dot if it's VERY close to cursor (within last 20 chars)
    // This prevents false positives from dots in JOIN clauses
    const lastDotIndex = recentText.lastIndexOf('.');
    // Check if dot is VERY close to the cursor (within last 20 characters)
    // This ensures we only detect dots that are actually relevant to current typing
    if (lastDotIndex > 0 && lastDotIndex >= recentText.length - 20) {
      // Get text after the dot to see if cursor is right after it
      const textAfterDot = recentText.substring(lastDotIndex + 1).trim();
      // Only set isAfterDot if there's very little text after the dot (cursor is right after dot)
      // This prevents false detection from dots in JOIN clauses like "a.Id = u.Id"
      if (textAfterDot.length <= 5) {
        // Extract table name/alias before the dot
        // Get more context before the dot to find the alias
        const textBeforeDot = recentText.substring(Math.max(0, lastDotIndex - 50), lastDotIndex).trim();
        // Match word characters (alias/table name) right before the dot
        // This handles "WHERE r." - should find "r" as the alias
        const tableMatch = textBeforeDot.match(/(\w+)\s*$/);
        if (tableMatch) {
          aliasOrTable = tableMatch[1];
          isAfterDot = true;
          needsFieldNames = true;
          needsTableNames = false;
          needsTableAliases = false;
          // CRITICAL: Return early - dot detection takes priority over everything
          // This ensures "r." in WHERE clause shows fields from table "r"
          return {
            needsTableNames: false,
            needsFieldNames: true,
            needsTableAliases: false,
            currentTable: null,
            aliasOrTable: aliasOrTable,
            isAfterDot: true
          };
        }
      }
    }
    
    // OPTIMIZATION: Find clause positions in recent text only (faster)
    // Find all clause positions in the recent query text
    const lastSelectIndex = textUpper.lastIndexOf('SELECT');
    const lastFromIndex = textUpper.lastIndexOf('FROM');
    const lastWhereIndex = textUpper.lastIndexOf('WHERE');
    const lastGroupByIndex = textUpper.lastIndexOf('GROUP BY');
    const lastOrderByIndex = textUpper.lastIndexOf('ORDER BY');
    const lastHavingIndex = textUpper.lastIndexOf('HAVING');
    const lastOnIndex = textUpper.lastIndexOf('ON');
    const lastJoinIndex = Math.max(
      textUpper.lastIndexOf('INNER JOIN'),
      textUpper.lastIndexOf('LEFT JOIN'),
      textUpper.lastIndexOf('RIGHT JOIN'),
      textUpper.lastIndexOf('FULL JOIN'),
      textUpper.lastIndexOf('JOIN')
    );
    
    // Determine which clause we're currently in
    const clausePositions = [
      { name: 'SELECT', pos: lastSelectIndex },
      { name: 'FROM', pos: lastFromIndex },
      { name: 'WHERE', pos: lastWhereIndex },
      { name: 'GROUP BY', pos: lastGroupByIndex },
      { name: 'ORDER BY', pos: lastOrderByIndex },
      { name: 'HAVING', pos: lastHavingIndex },
      { name: 'ON', pos: lastOnIndex }
    ].filter(c => c.pos > -1).sort((a, b) => b.pos - a.pos);
    
    // Get the current clause (the one we're in based on position)
    const currentClause = clausePositions.length > 0 ? clausePositions[0].name : null;
    
    // OPTIMIZATION: Use already computed recentText (no need to recompute)
    // SSMS-like detection: Check if we're after FROM, JOIN keywords (needs table names)
    // Improved pattern to detect JOIN contexts better - more aggressive like SSMS
    const recentTextTrimmed = recentText.trim();
    
    // SIMPLIFIED and RELIABLE detection - check if we're after JOIN keywords
    // This simple approach works for ALL cases including second JOIN
    // Simple, reliable pattern: Match "INNER JOIN" (or any JOIN) followed by optional word at end
    // This catches: "INNER JOIN", "INNER JOIN ", "INNER JOIN tabd_e"
    const needsTableAfterKeyword = 
      // After FROM keyword
      /FROM\s+\w*\s*$/i.test(recentTextTrimmed) ||
      // After any JOIN keyword - SIMPLE and RELIABLE pattern
      // Matches: "JOIN", "JOIN ", "JOIN tabd_e", "INNER JOIN", "INNER JOIN ", "INNER JOIN tabd_e"
      /\b(INNER|LEFT|RIGHT|FULL|OUTER|CROSS)?\s*JOIN\s*\w*\s*$/i.test(recentTextTrimmed) ||
      // Match "JOIN AS" cases
      /\bJOIN\s+AS\s*$/i.test(recentTextTrimmed) ||
      /FROM\s+AS\s*$/i.test(recentTextTrimmed);
    
    if (needsTableAfterKeyword) {
      needsTableNames = true;
      // Clear other flags when we need table names
      needsFieldNames = false;
      needsTableAliases = false;
    }
    
    // CRITICAL FIX: Check ALL JOINs in the query, not just the last one
    // This handles multiple JOINs - find the JOIN we're currently typing after
    // Only check if recent text detection didn't already find it
    if (!needsTableNames) {
      // OPTIMIZATION: Search in recent text only (faster)
      // Find all JOIN positions and check if cursor is right after any of them
      // Use a more comprehensive pattern to find all JOIN types
      const allJoinPatterns = [
        /(INNER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|FULL\s+JOIN|CROSS\s+JOIN|OUTER\s+JOIN|JOIN)/gi
      ];
      
      // Find all JOIN keywords in the recent query text
      const joinMatches: Array<{ index: number; match: string; length: number }> = [];
      for (const pattern of allJoinPatterns) {
        // Reset regex lastIndex to ensure we search from the beginning
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(textUpper)) !== null) {
          joinMatches.push({ 
            index: match.index, 
            match: match[0],
            length: match[0].length
          });
        }
      }
      
      // Sort by position (most recent/closest to cursor first)
      joinMatches.sort((a, b) => b.index - a.index);
      
      // Check if we're right after any JOIN keyword
      // For each JOIN, check if cursor is right after it (within reasonable distance)
      for (const joinMatch of joinMatches) {
        const joinIndex = joinMatch.index;
        const joinEndIndex = joinIndex + joinMatch.length;
        // OPTIMIZATION: Use recent text for distance calculation
        // Get text after JOIN without trimming first (to check for whitespace)
        const textAfterJoinRaw = recentText.substring(joinEndIndex);
        const textAfterJoinTrimmed = textAfterJoinRaw.trim();
        const cursorDistance = recentText.length - joinEndIndex;
        
        // Only check JOINs that are close to the cursor (within 500 chars)
        // CRITICAL: Check if cursor is RIGHT AFTER the JOIN keyword
        if (cursorDistance <= 500 && cursorDistance >= 0) {
          // Check if we're typing right after this JOIN (with or without table name)
          // More precise patterns to match exactly what we need
          // We need to detect: "INNER JOIN " (with space), "INNER JOIN" (no space), "INNER JOIN AS"
          // Also allow partial table names (user might be typing)
          
          const needsTable = 
            // "INNER JOIN" (no text after JOIN at all - cursor is right after JOIN)
            textAfterJoinRaw.length === 0 ||
            // "INNER JOIN " (just whitespace, no table name yet) - CRITICAL for immediate suggestions
            (textAfterJoinTrimmed === '' && textAfterJoinRaw.length > 0) ||
            // "INNER JOIN " (trailing space(s), cursor right after space)
            /^\s+$/i.test(textAfterJoinRaw) ||
            // "INNER JOIN AS" (needs table before AS)
            /^\s+AS\s*$/i.test(textAfterJoinRaw) ||
            // CRITICAL: Allow partial table names - if user is typing a table name, still show suggestions
            // This helps with autocomplete even when partial text is typed (like "tabd_e")
            // Match any word characters after JOIN (partial or complete table name)
            // This is KEY - if user is typing "tabd_e" after JOIN, we still need suggestions
            (textAfterJoinTrimmed.length > 0 && textAfterJoinTrimmed.length < 50 && /^\w+$/i.test(textAfterJoinTrimmed)) ||
            // Also match if there's whitespace followed by word characters (for cases like "INNER JOIN tabd_e")
            /^\s+\w+$/i.test(textAfterJoinRaw) ||
            // CRITICAL FIX: If cursor is within 50 chars after JOIN and there's any word being typed, show suggestions
            // This handles "INNER JOIN tabd_e" where user is actively typing
            (cursorDistance <= 50 && textAfterJoinTrimmed.length > 0 && /^\w+$/i.test(textAfterJoinTrimmed));
          
          if (needsTable) {
            needsTableNames = true;
            needsFieldNames = false;
            needsTableAliases = false;
            break; // Found the JOIN we're typing after, no need to check others
          }
        }
      }
    }
    
    // If we're in SELECT clause (after FROM) - SSMS-like: show all fields from all tables
    if (currentClause === 'SELECT' && lastFromIndex > lastSelectIndex && !isAfterDot && !needsTableNames) {
      // After FROM, suggest table aliases and field names from ALL tables
      if (this.aliasToTableMap.size > 0) {
        needsTableAliases = true;
      }
      // Always show field names in SELECT clause (from all tables)
      needsFieldNames = true;
      
      // Try to detect which table we're working with (for context)
      const fromMatch = textUpper.match(/FROM\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?/);
      if (fromMatch) {
        currentTable = (fromMatch[2] || fromMatch[1]).toLowerCase();
      }
    }
    
    // If we're in WHERE clause - SSMS-like: show all table aliases and fields
    // CRITICAL: This must work even after multiple JOINs
    // Check both currentClause and position relative to WHERE keyword
    if ((currentClause === 'WHERE' || lastWhereIndex > -1) && !isAfterDot) {
      // CRITICAL: If WHERE comes after any JOIN, we're definitely in WHERE clause
      // Also check if cursor is after WHERE keyword
      // OPTIMIZATION: Use recentText.length instead of text.length
      const cursorAfterWhere = lastWhereIndex > -1 && 
                              (recentText.length - lastWhereIndex) <= 300;
      
      if (cursorAfterWhere || currentClause === 'WHERE') {
        // In WHERE clause, we should NOT need table names (we need fields and aliases)
        // CRITICAL: Always override needsTableNames for WHERE clause
        needsTableNames = false;
        
        // In WHERE clause, suggest table aliases and their fields
        if (this.aliasToTableMap.size > 0) {
          needsTableAliases = true;
        }
        
        // Always show field names in WHERE clause (from all tables)
        needsFieldNames = true;
        
        // Check if there's a table alias before the dot or current word
        const lastWord = recentText.match(/(\w+)\s*$/);
        if (lastWord && this.aliasToTableMap.has(lastWord[1].toLowerCase())) {
          currentTable = lastWord[1].toLowerCase();
        }
      }
    }
    
    // If we're in ON clause (for JOINs) - show fields and aliases
    if (currentClause === 'ON' && lastOnIndex > -1 && !isAfterDot && !needsTableNames) {
      // In ON clause, we need fields and aliases, not table names
      needsTableNames = false;
      
      if (this.aliasToTableMap.size > 0) {
        needsTableAliases = true;
      }
      
      // Always show field names in ON clause (from all tables)
      needsFieldNames = true;
    }
    
    // If we're in GROUP BY clause
    if (currentClause === 'GROUP BY' && lastGroupByIndex > -1 && !isAfterDot && !needsTableNames) {
      if (this.aliasToTableMap.size > 0) {
        needsTableAliases = true;
      }
      needsFieldNames = true;
    }
    
    // If we're in ORDER BY clause
    if (currentClause === 'ORDER BY' && lastOrderByIndex > -1 && !isAfterDot && !needsTableNames) {
      if (this.aliasToTableMap.size > 0) {
        needsTableAliases = true;
      }
      needsFieldNames = true;
    }
    
    // If we're in ON clause (for JOINs)
    if (currentClause === 'ON' && lastOnIndex > -1 && !isAfterDot && !needsTableNames) {
      if (this.aliasToTableMap.size > 0) {
        needsTableAliases = true;
      }
      needsFieldNames = true;
    }
    
    // If we're in HAVING clause
    if (currentClause === 'HAVING' && lastHavingIndex > -1 && !isAfterDot && !needsTableNames) {
      if (this.aliasToTableMap.size > 0) {
        needsTableAliases = true;
      }
      needsFieldNames = true;
    }

    return {
      needsTableNames,
      needsFieldNames,
      needsTableAliases,
      currentTable,
      aliasOrTable,
      isAfterDot
    };
  }

  /**
   * Get SQL keywords for autocomplete
   */
  private getSqlKeywords(): string[] {
    return [
      'SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER',
      'ON', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET',
      'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
      'AS', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'BETWEEN', 'IS', 'NULL',
      'COUNT', 'SUM', 'AVG', 'MAX', 'MIN', 'DISTINCT',
      'ASC', 'DESC', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
      'UNION', 'ALL', 'EXISTS', 'ANY', 'SOME'
    ];
  }

  /**
   * Get display name for table (can be enhanced to show friendly names)
   */
  private getTableDisplayName(tableName: string): string {
    // Remove common prefixes like 't_', 'tbl_', 'tab_'
    return tableName
      .replace(/^t_/i, '')
      .replace(/^tbl_/i, '')
      .replace(/^tab_/i, '')
      .replace(/^TABD_/i, '')
      .replace(/^TABMD_/i, '');
  }
}

