import { Injectable } from '@angular/core';
import { AppObject, Field } from './metadata.service';

export interface SqlValidationResult {
  valid: boolean;
  errors: string[];
  summary: string;
  suggestion: string;
}

@Injectable({
  providedIn: 'root'
})
export class SqlValidationService {
  validate(sql: string, schema: { appObjects: AppObject[] } | null): SqlValidationResult {
    const errors: string[] = [];
    const originalSql = sql || '';
    const trimmed = originalSql.trim();

    if (!trimmed) {
      return {
        valid: false,
        errors: ['No SQL query provided to validate.'],
        summary: '',
        suggestion: 'Type a SQL query to validate.'
      };
    }

    // Normalize spacing for keyword scans
    const normalized = this.normalizeWhitespace(this.stripComments(originalSql));
    const upper = normalized.toUpperCase();

    // Injection / multi-statement checks
    if (this.hasMultiStatement(originalSql)) {
      errors.push('Multiple SQL statements detected or statement terminators present. Multi-statements are not allowed.');
    }
    if (this.hasDangerousPatterns(originalSql)) {
      errors.push('Potential SQL injection pattern detected (DROP/TRUNCATE/--; blocked).');
    }

    // Parentheses balance
    if (!this.parenthesesBalanced(originalSql)) {
      errors.push('Unbalanced parentheses.');
    }

    // Clause order validation
    this.validateClauseOrder(upper, errors);

    // JOIN validation
    this.validateJoinSyntax(upper, errors);

    // WHERE vs HAVING aggregate rules
    this.validateWhereHaving(upper, errors);

    // GROUP BY rules
    this.validateGroupBy(upper, errors);

    // ORDER BY / LIMIT rules
    this.validateOrderByLimit(upper, errors);

    // Schema-based checks (tables/columns)
    if (!schema || !schema.appObjects || schema.appObjects.length === 0) {
      errors.push('No database schema provided. Table and column existence cannot be checked.');
    } else {
      this.validateAgainstSchema(upper, schema.appObjects, errors);
    }

    const valid = errors.length === 0;
    const summary = valid ? this.summarizeQuery(upper) : '';
    const suggestion = this.suggestImprovement(upper, valid);

    return { valid, errors, summary, suggestion };
  }

  // Helpers
  private stripComments(sql: string): string {
    return sql
      .replace(/--.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
  }

  private normalizeWhitespace(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim();
  }

  private hasMultiStatement(sql: string): boolean {
    // Disallow semicolons that separate multiple statements (allow trailing single semicolon)
    const cleaned = this.stripComments(sql);
    const parts = cleaned.split(';').filter(p => p.trim().length > 0);
    return parts.length > 1;
  }

  private hasDangerousPatterns(sql: string): boolean {
    const s = sql.toUpperCase();
    if (s.includes('-- ')) return true;
    if (/\bDROP\b|\bTRUNCATE\b/.test(s)) return true;
    return false;
  }

  private parenthesesBalanced(sql: string): boolean {
    let depth = 0;
    for (const ch of sql) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (depth < 0) return false;
    }
    return depth === 0;
  }

  private validateClauseOrder(upper: string, errors: string[]): void {
    const find = (kw: string) => {
      const idx = upper.indexOf(` ${kw} `);
      if (idx === -1) {
        const startIdx = upper.startsWith(`${kw} `) ? 0 : -1;
        return startIdx;
      }
      return idx;
    };

    const idxSelect = find('SELECT');
    const idxFrom = find('FROM');
    const idxWhere = find('WHERE');
    const idxGroupBy = upper.indexOf(' GROUP BY ');
    const idxHaving = find('HAVING');
    const idxOrderBy = upper.indexOf(' ORDER BY ');
    const idxLimit = find('LIMIT');

    if (idxSelect === -1) errors.push('Missing SELECT clause.');
    if (idxFrom !== -1 && idxSelect !== -1 && idxFrom < idxSelect) errors.push('FROM appears before SELECT.');
    if (idxWhere !== -1 && idxFrom !== -1 && idxWhere < idxFrom) errors.push('WHERE appears before FROM.');
    if (idxGroupBy !== -1 && idxWhere !== -1 && idxGroupBy < idxWhere) errors.push('GROUP BY appears before WHERE.');
    if (idxHaving !== -1) {
      if (idxGroupBy === -1) errors.push('HAVING used without GROUP BY.');
      if (idxGroupBy !== -1 && idxHaving < idxGroupBy) errors.push('HAVING appears before GROUP BY.');
    }
    if (idxOrderBy !== -1) {
      if (idxHaving !== -1 && idxOrderBy < idxHaving) errors.push('ORDER BY appears before HAVING.');
      if (idxGroupBy !== -1 && idxHaving === -1 && idxOrderBy < idxGroupBy) errors.push('ORDER BY appears before GROUP BY.');
      if (idxWhere !== -1 && idxOrderBy < idxWhere) errors.push('ORDER BY appears before WHERE.');
    }
    if (idxLimit !== -1) {
      if (idxOrderBy !== -1 && idxLimit < idxOrderBy) errors.push('LIMIT appears before ORDER BY.');
      if (idxHaving !== -1 && idxLimit < idxHaving) errors.push('LIMIT appears before HAVING.');
      if (idxGroupBy !== -1 && idxLimit < idxGroupBy) errors.push('LIMIT appears before GROUP BY.');
      if (idxWhere !== -1 && idxLimit < idxWhere) errors.push('LIMIT appears before WHERE.');
    }
  }

  private validateJoinSyntax(upper: string, errors: string[]): void {
    const joinMatches = upper.match(/\b(INNER|LEFT|RIGHT|FULL|CROSS)?\s*JOIN\b/g);
    if (!joinMatches) return;

    // Require ON for non-CROSS joins
    const joinSegments = upper.split(/\bJOIN\b/);
    for (let i = 1; i < joinSegments.length; i++) {
      const beforeJoin = joinSegments[i - 1];
      const isCross = /\bCROSS\s*$/i.test(beforeJoin);
      const segmentAfterJoin = joinSegments[i];
      if (!isCross && !/\bON\b/.test(segmentAfterJoin)) {
        errors.push('JOIN without ON condition detected.');
      }
    }
  }

  private validateWhereHaving(upper: string, errors: string[]): void {
    const hasWhere = /\bWHERE\b/.test(upper);
    const hasHaving = /\bHAVING\b/.test(upper);
    if (hasWhere) {
      const wherePart = upper.split(/\bWHERE\b/)[1].split(/\bGROUP BY\b|\bORDER BY\b|\bLIMIT\b/)[0];
      if (/\b(SUM|COUNT|AVG|MIN|MAX)\s*\(/.test(wherePart)) {
        errors.push('WHERE cannot reference aggregate functions; move conditions to HAVING.');
      }
    }
    if (hasHaving) {
      const havingPart = upper.split(/\bHAVING\b/)[1].split(/\bORDER BY\b|\bLIMIT\b/)[0];
      const hasAgg = /\b(SUM|COUNT|AVG|MIN|MAX)\s*\(/.test(havingPart);
      if (!hasAgg) {
        errors.push('HAVING must reference aggregated values.');
      }
    }
  }

  private validateGroupBy(upper: string, errors: string[]): void {
    const selectMatch = upper.match(/\bSELECT\b(.*?)\bFROM\b/);
    if (!selectMatch) return;
    const selectList = selectMatch[1];
    const groupByMatch = upper.match(/\bGROUP BY\b(.*?)(\bHAVING\b|\bORDER BY\b|\bLIMIT\b|$)/);
    const groupList = groupByMatch ? groupByMatch[1] : '';

    // Identify non-aggregated columns (heuristic)
    const items = selectList.split(',').map(s => s.trim()).filter(Boolean);
    const nonAggregated: string[] = [];
    for (const item of items) {
      const isAgg = /\b(SUM|COUNT|AVG|MIN|MAX)\s*\(/.test(item);
      const isLiteral = /^'.*'$|^\d+(\.\d+)?$/.test(item);
      if (!isAgg && !isLiteral && !/\bAS\b/.test(item) && !/\*/.test(item)) {
        // Use token up to first space or end
        const col = item.replace(/\s+ASC$|\s+DESC$/,'').split(/\s+/)[0];
        nonAggregated.push(col);
      }
    }

    if (groupByMatch) {
      for (const col of nonAggregated) {
        if (!new RegExp(`\\b${this.escapeRegex(col)}\\b`).test(groupList)) {
          errors.push(`Non-aggregated column '${col}' in SELECT must appear in GROUP BY.`);
        }
      }
    } else {
      if (/\b(SUM|COUNT|AVG|MIN|MAX)\s*\(/.test(selectList)) {
        // Aggregates present; either group by or aggregate only
        // If there exists any non-aggregated column, error
        if (nonAggregated.length > 0) {
          errors.push('GROUP BY is required when SELECT includes non-aggregated columns with aggregates.');
        }
      }
    }
  }

  private validateOrderByLimit(upper: string, errors: string[]): void {
    const limitMatch = upper.match(/\bLIMIT\s+([\-]?\d+)\b/);
    if (limitMatch) {
      const value = parseInt(limitMatch[1], 10);
      if (isNaN(value)) errors.push('LIMIT must be an integer.');
      else if (value < 0) errors.push('LIMIT cannot be negative.');
    }
  }

  private validateAgainstSchema(upper: string, appObjects: AppObject[], errors: string[]): void {
    const tables = this.extractTables(upper);
    const knownTableNames = new Set(appObjects.map(t => t.name.toUpperCase()));

    // Tables must exist
    for (const t of tables) {
      if (!knownTableNames.has(t.toUpperCase())) {
        errors.push(`Referenced table '${t}' does not exist in schema.`);
      }
    }

    // Column references basic check: table.column patterns
    const tableAliasMap = this.extractTableAliases(upper);
    const tableLookup: Record<string, Set<string>> = {};
    for (const obj of appObjects) {
      tableLookup[obj.name.toUpperCase()] = new Set((obj.fields || []).map((f: Field) => f.name.toUpperCase()));
    }

    const colRefs = this.extractColumnReferences(upper);
    for (const ref of colRefs) {
      if (ref.table) {
        const tableName = (tableAliasMap[ref.table.toUpperCase()] || ref.table).toUpperCase();
        const tableCols = tableLookup[tableName];
        if (!tableCols) {
          errors.push(`Referenced table '${ref.table}' does not exist for column '${ref.column}'.`);
        } else if (!tableCols.has(ref.column.toUpperCase())) {
          errors.push(`Column '${ref.column}' does not exist in table '${tableName}'.`);
        }
      } else {
        // Ambiguous column without table qualifier — ensure it exists unambiguously across all referenced tables
        const possibleTables = tables
          .map(t => t.toUpperCase())
          .filter(tn => tableLookup[tn]?.has(ref.column.toUpperCase()));
        if (possibleTables.length === 0) {
          errors.push(`Column '${ref.column}' does not exist in referenced tables.`);
        } else if (possibleTables.length > 1) {
          errors.push(`Ambiguous column reference '${ref.column}'. Qualify with table alias.`);
        }
      }
    }
  }

  private extractTables(upper: string): string[] {
    const tables: string[] = [];
    const fromMatch = upper.match(/\bFROM\b(.*?)(\bWHERE\b|\bGROUP BY\b|\bHAVING\b|\bORDER BY\b|\bLIMIT\b|$)/);
    if (fromMatch) {
      const segment = fromMatch[1];
      const tokens = segment.split(/\bJOIN\b/);
      for (const tok of tokens) {
        const m = tok.match(/([A-Z0-9_\.]+)\s*(AS\s+)?([A-Z0-9_]+)?/);
        if (m && m[1]) {
          tables.push(m[1]);
        }
      }
    }
    return Array.from(new Set(tables));
  }

  private extractTableAliases(upper: string): Record<string, string> {
    const map: Record<string, string> = {};
    // FROM <table> [AS] <alias>, JOIN <table> [AS] <alias>
    const aliasRegex = /\b(FROM|JOIN)\s+([A-Z0-9_\.]+)\s+(?:AS\s+)?([A-Z0-9_]+)/g;
    let m: RegExpExecArray | null;
    while ((m = aliasRegex.exec(upper)) !== null) {
      const table = m[2].toUpperCase();
      const alias = m[3].toUpperCase();
      if (alias && alias !== 'ON' && alias !== 'USING') {
        map[alias] = table;
      }
    }
    return map;
  }

  private extractColumnReferences(upper: string): Array<{ table?: string; column: string }> {
    const refs: Array<{ table?: string; column: string }> = [];
    // Simplistic tokenization for table.column references across SELECT/WHERE/GROUP/HAVING/ORDER
    const segments = upper.split(/\bFROM\b/)[0] + ' ' + (upper.split(/\bFROM\b/)[1] || '');
    const regex = /\b([A-Z0-9_]+)\.([A-Z0-9_]+)\b|\b([A-Z0-9_]+)\b/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(segments)) !== null) {
      if (m[1] && m[2]) {
        refs.push({ table: m[1], column: m[2] });
      } else if (m[3]) {
        // Standalone identifier — skip SQL keywords and functions
        const ident = m[3];
        if (!this.isKeyword(ident) && !this.isFunctionName(ident)) {
          refs.push({ column: ident });
        }
      }
    }
    return refs;
  }

  private isKeyword(token: string): boolean {
    const keywords = new Set([
      'SELECT','FROM','WHERE','GROUP','BY','HAVING','ORDER','LIMIT','JOIN','LEFT','RIGHT','FULL','INNER','OUTER','CROSS','ON','AS','ASC','DESC','AND','OR','NOT','IN','IS','NULL','LIKE','BETWEEN','CASE','WHEN','THEN','ELSE','END','DISTINCT'
    ]);
    return keywords.has(token.toUpperCase());
  }

  private isFunctionName(token: string): boolean {
    const fns = new Set(['SUM','COUNT','AVG','MIN','MAX','COALESCE','NVL','UPPER','LOWER','DATE','DATEDIFF']);
    return fns.has(token.toUpperCase());
  }

  private summarizeQuery(upper: string): string {
    const tables = this.extractTables(upper);
    const hasJoins = /\bJOIN\b/.test(upper);
    const hasGroup = /\bGROUP BY\b/.test(upper);
    const hasWhere = /\bWHERE\b/.test(upper);
    const hasOrder = /\bORDER BY\b/.test(upper);
    const hasLimit = /\bLIMIT\b/.test(upper);
    const parts: string[] = [];
    if (tables.length > 0) parts.push(`Selects from ${tables.join(', ')}`);
    if (hasJoins) parts.push('joins related tables');
    if (hasWhere) parts.push('filters rows');
    if (hasGroup) parts.push('aggregates by groups');
    if (hasOrder) parts.push('orders results');
    if (hasLimit) parts.push('limits rows');
    return parts.length ? parts.join(', ') + '.' : 'Selects data.';
  }

  private suggestImprovement(upper: string, valid: boolean): string {
    const suggestions: string[] = [];
    if (!/\bWHERE\b/.test(upper)) suggestions.push('Add WHERE to restrict rows when appropriate.');
    if (!/\bLIMIT\b/.test(upper)) suggestions.push('Add LIMIT to control result size if supported.');
    if (/\bSELECT\s+\*\b/.test(upper)) suggestions.push('Avoid SELECT *; specify only needed columns.');
    if (!/\bAS\b/.test(upper) && /\bORDER BY\b/.test(upper)) suggestions.push('Use aliases for expressions used in ORDER BY.');
    if (valid && suggestions.length === 0) return 'Looks good. Ensure indexes exist on join and filter columns.';
    return suggestions.join(' ');
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}


