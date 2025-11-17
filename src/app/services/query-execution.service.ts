import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, of, delay, map, catchError } from 'rxjs';

export interface QueryExecutionResponse {
  success: boolean;
  data: any[];
  metadata: {
    rowCount: number;
    executionTime: number;
    hasMore: boolean;
  };
  error?: string;
  statusCode?: string;
  recordAffected?: number;
  totalRecords?: number;
  totalExecutionTime?: number;
}

export interface ApiResponse {
  RequestId?: string;
  IsSuccess: boolean;
  Result: any[];
  StatusCode: string;
  RecordAffectted: number;
  TotalRecords: number;
  TotalExecutionTime: number;
  Log?: string[];
  Errors?: any[];
  IsFromCache?: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class QueryExecutionService {
  private apiUrl = 'https://api.techappforce.xyz/api/v1/CRUD/Select';

  constructor(private http: HttpClient) {}

  /**
   * Execute SQL query
   * @param sqlQuery The SQL query string
   * @param parameters Query parameters (key-value pairs)
   * @param sqlParserService Service to convert SQL to QueryJson
   * @param schemaData Optional schema data to look up Field IDs
   * @returns Observable with query execution results
   */
  executeQuery(
    sqlQuery: string, 
    parameters: { [key: string]: any } = {},
    sqlParserService?: any,
    schemaData?: any
  ): Observable<QueryExecutionResponse> {
    // Convert SQL to QueryJson in the format expected by the API
    let queryJson: any = null;
    if (sqlParserService) {
      try {
        queryJson = sqlParserService.sqlToJson(sqlQuery, schemaData);
      } catch (error) {
        console.error('Failed to parse SQL to QueryJson:', error);
        return this.handleError('Failed to parse SQL to QueryJson');
      }
    }

    if (!queryJson) {
      return this.handleError('Failed to convert SQL to JSON format');
    }

    // Prepare headers
    const headers = new HttpHeaders({
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9',
      'appid': 'bf4391ae-5e34-4fdd-8ce5-93a5cd4429a2',
      'applicationcode': 'PMS',
      'authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJzeXN0ZW0udXNlckB0ZWNoZXh0ZW5zb3IuY29tIiwianRpIjoiODc5ZjI1NjUtYTFjYi00MzUxLWI2ZmItZWU1ODc0NzExMGMwIiwiZW1haWwiOiJzeXN0ZW0udXNlckB0ZWNoZXh0ZW5zb3IuY29tIiwiaWQiOiJhOTZmYTc0ZS03MDE3LTQwYWUtOWRjNy05NmZhYzU2NzY2MDYiLCJsb2NhbGVTZXR0aW5nIjoie1wiVGltZVpvbmVJZFwiOlwiXCIsXCJMb2NhbGVcIjpudWxsLFwiTGFuZ3VhZ2VcIjpcIjFcIixcIkRhdGVGb3JtYXRcIjpcIlwiLFwiVGltZUZvcm1hdFwiOlwiXCIsXCJOdW1iZXJGb3JtYXRcIjpcIlwiLFwiQ3VycmVuY3lcIjpcIlwifSIsInJvbGUiOlsiQWRtaW4iLCJUQUIgQWRtaW5pc3RyYXRvciIsIlRlbmFudCBBZG1pbmlzdHJhdG9yIl0sIlJvbGVJZHMiOiJmOTFkYTU5MC1lMzExLTRhMzQtYWQyMC0yY2Q5OTI3ZGU3NjQsMDFjZGE2NWItZDMxYi00MzNhLWEwZmItODhlMDgxNmM5ZjNkLGEzNjcyMGJlLTIwOWItNDllOS1hZTgwLWIxOGQyZGUxZTBiZCIsIm5iZiI6MTczNjU5MzkyMiwiZXhwIjoxNzY4MTI5OTIyLCJpYXQiOjE3MzY1OTM5MjJ9.amxr6V964Dul6DP2UuHk2ockcoqsoBBQVJ-4c_elD10',
      'content-type': 'application/json',
      'environment': '8096c35c-e673-4ad6-800f-bddb1779787e',
      'origin': 'https://techextensor.techappforce.xyz',
      'referer': 'https://techextensor.techappforce.xyz/',
      'tenantid': 'a5e7d0d1-0e92-422f-a85c-9dac28375172'
    });

    // POST QueryJson to API
    return this.http.post<ApiResponse>(this.apiUrl, queryJson, { headers }).pipe(
      map((response: ApiResponse) => {
        // Extract error messages from Errors array
        let errorMessage: string | undefined = undefined;
        if (response.Errors && Array.isArray(response.Errors) && response.Errors.length > 0) {
          // Extract error messages from the Errors array
          // Handle both string errors and object errors
          const errorMessages = response.Errors.map((err: any) => {
            if (typeof err === 'string') {
              return err;
            } else if (err && typeof err === 'object') {
              // If error is an object, try to extract message property or stringify it
              return err.message || err.Message || err.error || err.Error || JSON.stringify(err);
            }
            return String(err);
          }).filter((msg: string) => msg && msg.trim().length > 0);
          
          // Join multiple errors with newlines
          if (errorMessages.length > 0) {
            errorMessage = errorMessages.join('\n');
          }
        }
        
        // Also check if IsSuccess is false, even if no Errors array
        if (!response.IsSuccess && !errorMessage) {
          errorMessage = `Query execution failed with status code: ${response.StatusCode || 'Unknown'}`;
        }
        
        // Transform API response to QueryExecutionResponse format
        return {
          success: response.IsSuccess,
          data: response.Result || [],
          metadata: {
            rowCount: response.TotalRecords || 0,
            executionTime: response.TotalExecutionTime ? response.TotalExecutionTime / 1000 : 0, // Convert ms to seconds
            hasMore: false // API doesn't provide pagination info in this format
          },
          statusCode: response.StatusCode,
          recordAffected: response.RecordAffectted,
          totalRecords: response.TotalRecords,
          totalExecutionTime: response.TotalExecutionTime,
          error: errorMessage
        };
      }),
      catchError((error) => {
        console.error('API Error:', error);
        // Check if error response has Errors array
        if (error.error && error.error.Errors && Array.isArray(error.error.Errors) && error.error.Errors.length > 0) {
          const errorMessages = error.error.Errors.map((err: any) => {
            if (typeof err === 'string') {
              return err;
            } else if (err && typeof err === 'object') {
              return err.message || err.Message || err.error || err.Error || JSON.stringify(err);
            }
            return String(err);
          }).filter((msg: string) => msg && msg.trim().length > 0);
          
          if (errorMessages.length > 0) {
            return this.handleError(errorMessages.join('\n'));
          }
        }
        return this.handleError(error.message || 'Failed to execute query');
      })
    );
  }

  /**
   * Handle errors
   */
  private handleError(message: string): Observable<QueryExecutionResponse> {
    return of({
      success: false,
      data: [],
      metadata: {
        rowCount: 0,
        executionTime: 0,
        hasMore: false
      },
      error: message
    });
  }

  /**
   * Generate mock data based on the query
   * This simulates a real API response
   */
  private getMockData(sqlQuery: string, parameters: { [key: string]: any }): Observable<QueryExecutionResponse> {
    // Simulate API delay
    const delayMs = 200 + Math.random() * 300; // 200-500ms

    // Extract column names from SELECT clause for mock data generation
    const columnNames = this.extractColumnNames(sqlQuery);

    // Generate mock data rows
    const rowCount = 150;
    const data: any[] = [];

    for (let i = 0; i < rowCount; i++) {
      const row: any = {};
      columnNames.forEach(column => {
        row[column] = this.generateMockValue(column);
      });
      data.push(row);
    }

    const mockResponse: QueryExecutionResponse = {
      success: true,
      data: data,
      metadata: {
        rowCount: rowCount,
        executionTime: parseFloat((delayMs / 1000).toFixed(2)),
        hasMore: false
      }
    };

    return of(mockResponse).pipe(delay(delayMs));
  }

  /**
   * Extract column names from SELECT clause
   */
  private extractColumnNames(sqlQuery: string): string[] {
    const columns: string[] = [];
    const selectMatch = sqlQuery.match(/SELECT\s+(.*?)\s+FROM/is);
    
    if (!selectMatch) {
      // Default columns if parsing fails
      return ['Title', 'Description', 'ProjectName', 'Priority', 'Progress', 'TimeLogCount'];
    }

    const selectClause = selectMatch[1];
    
    // Remove comments
    const cleaned = selectClause.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    
    // Split by comma, respecting quotes and parentheses
    const parts = this.splitSelectFields(cleaned);
    
    parts.forEach(part => {
      part = part.trim();
      if (!part) return;
      
      // Handle AS alias: ... AS AliasName
      const asMatch = part.match(/.+\s+AS\s+(\w+)/i);
      if (asMatch) {
        columns.push(asMatch[1]);
        return;
      }
      
      // Handle functions with AS: COUNT(t.ID) AS TimeLogCount
      const functionAsMatch = part.match(/\w+\s*\([^)]*\)\s+AS\s+(\w+)/i);
      if (functionAsMatch) {
        columns.push(functionAsMatch[1]);
        return;
      }
      
      // Handle table.column pattern: table.ColumnName or just ColumnName
      const dotMatch = part.match(/(\w+)\.(\w+)/);
      if (dotMatch) {
        // If there's an AS, use that; otherwise use the column name after dot
        const asInPart = part.match(/AS\s+(\w+)/i);
        if (asInPart) {
          columns.push(asInPart[1]);
        } else {
          columns.push(dotMatch[2]);
        }
        return;
      }
      
      // Handle functions: COUNT(t.ID) - extract the field name inside
      const functionMatch = part.match(/\w+\s*\(\s*(?:\w+\.)?(\w+)\s*\)/i);
      if (functionMatch) {
        columns.push(functionMatch[1] + 'Count'); // Default naming for aggregates
        return;
      }
      
      // Just a column name without table prefix
      const simpleMatch = part.match(/^(\w+)/);
      if (simpleMatch) {
        columns.push(simpleMatch[1]);
      }
    });

    // Remove duplicates and empty strings
    const uniqueColumns = [...new Set(columns)].filter(c => c && c.length > 0);
    
    // If no columns extracted, return defaults
    return uniqueColumns.length > 0 ? uniqueColumns : ['Title', 'Description', 'ProjectName', 'Priority', 'Progress'];
  }

  /**
   * Split SELECT fields by comma, respecting quotes and parentheses
   */
  private splitSelectFields(fields: string): string[] {
    const result: string[] = [];
    let current = '';
    let depth = 0;
    let inQuotes = false;
    let quoteChar = '';

    for (let i = 0; i < fields.length; i++) {
      const char = fields[i];
      
      if ((char === '"' || char === "'") && (i === 0 || fields[i - 1] !== '\\')) {
        if (!inQuotes) {
          inQuotes = true;
          quoteChar = char;
        } else if (char === quoteChar) {
          inQuotes = false;
        }
      } else if (!inQuotes) {
        if (char === '(') depth++;
        else if (char === ')') depth--;
        else if (char === ',' && depth === 0) {
          result.push(current.trim());
          current = '';
          continue;
        }
      }
      
      current += char;
    }
    
    if (current.trim()) {
      result.push(current.trim());
    }
    
    return result;
  }

  /**
   * Generate mock value based on column name
   */
  private generateMockValue(columnName: string): any {
    const lowerColumn = columnName.toLowerCase();
    
    // Type detection based on column name
    if (lowerColumn.includes('id')) {
      return Math.floor(Math.random() * 1000) + 1;
    }
    if (lowerColumn.includes('date') || lowerColumn.includes('time')) {
      const date = new Date();
      date.setDate(date.getDate() - Math.floor(Math.random() * 365));
      return date.toISOString().split('T')[0];
    }
    if (lowerColumn.includes('count') || lowerColumn.includes('total') || lowerColumn.includes('amount')) {
      return Math.floor(Math.random() * 1000);
    }
    if (lowerColumn.includes('priority')) {
      return Math.floor(Math.random() * 5) + 1;
    }
    if (lowerColumn.includes('progress') || lowerColumn.includes('percentage')) {
      return Math.floor(Math.random() * 100);
    }
    if (lowerColumn.includes('boolean') || lowerColumn.includes('is') || lowerColumn.includes('has')) {
      return Math.random() > 0.5;
    }
    
    // Default: string value
    const prefixes = ['Sample', 'Test', 'Demo', 'Example', 'Item'];
    const suffixes = ['Data', 'Value', 'Record', 'Entry'];
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
    const suffix = suffixes[Math.floor(Math.random() * suffixes.length)];
    return `${prefix} ${suffix} ${Math.floor(Math.random() * 100)}`;
  }
}

