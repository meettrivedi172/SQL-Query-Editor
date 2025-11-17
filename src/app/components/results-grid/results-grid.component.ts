import { Component, Input, Output, EventEmitter, OnInit, OnChanges, SimpleChanges, ChangeDetectorRef, ViewChild, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { GridModule, GridComponent, PageService, SortService, FilterService, GroupService, ToolbarService, ExcelExportService, PdfExportService, ReorderService, ResizeService } from '@syncfusion/ej2-angular-grids';
import { ExportService } from '../../services/export.service';
import { ToastService } from '../../services/toast.service';

export interface GridColumn {
  field: string;
  header: string;
  type: 'string' | 'number' | 'date' | 'boolean';
  sortable: boolean;
  filterable: boolean;
  groupable: boolean;
  width?: number;
}

export interface GridFilter {
  field: string;
  operator: string;
  value: any;
}

export interface GridSort {
  field: string;
  direction: 'asc' | 'desc';
}

export interface GridGroup {
  field: string;
}

@Component({
  selector: 'app-results-grid',
  standalone: true,
  imports: [CommonModule, FormsModule, GridModule],
  providers: [PageService, SortService, FilterService, GroupService, ToolbarService, ExcelExportService, PdfExportService, ReorderService, ResizeService],
  templateUrl: './results-grid.component.html',
  styleUrl: './results-grid.component.css'
})
export class ResultsGridComponent implements OnInit, OnChanges, AfterViewInit {
  @Input() data: any[] = [];
  @Input() columns: string[] = [];
  @Input() metadata?: { rowCount: number; executionTime: number; hasMore: boolean };
  @Input() enableFiltering: boolean = true;
  @Input() enableSorting: boolean = true;
  @Input() enableGrouping: boolean = true;
  @Input() pageSize: number = 50;
  
  @Output() filterChange = new EventEmitter<GridFilter[]>();
  @Output() sortChange = new EventEmitter<GridSort[]>();
  @Output() groupChange = new EventEmitter<GridGroup[]>();
  @Output() sqlUpdate = new EventEmitter<string>();

  gridColumns: GridColumn[] = [];
  filteredData: any[] = [];
  displayedData: any[] = [];
  currentPage: number = 1;
  totalPages: number = 1;
  
  // Filter state
  filters: Map<string, string> = new Map();
  showFilterMenu: Map<string, boolean> = new Map();
  
  // Sort state
  sorts: GridSort[] = [];
  
  // Group state
  groups: GridGroup[] = [];
  groupedData: Map<string, any[]> = new Map();
  currentGroupedColumns: Set<string> = new Set(); // Track currently grouped columns
  
  // Selection
  selectedRows: Set<number> = new Set();
  selectAll: boolean = false;

  // Syncfusion Grid Data - Will be populated from @Input() data
  syncfusionGridData: any[] = [];
  syncfusionGridColumns: any[] = [];
  
  // Syncfusion Grid Settings
  gridPageSettings: any = {
    pageSize: 10,
    pageSizes: [10, 20, 50, 100]
  };
  
  gridSortSettings: any = {
    columns: []
  };
  
  gridFilterSettings: any = {
    type: 'Menu'
  };
  
  gridGroupSettings: any = {
    columns: [],
    showGroupedColumn: true, // Show grouped columns in the grouping bar
    allowReordering: true, // Allow reordering of grouped columns in the grouping bar
    sortByGroupedColumn: false // Prevent automatic sorting when grouping (user must manually sort if needed)
  };
  
  gridResizeSettings: any = {
    mode: 'Normal' // 'Normal' or 'Auto' - Normal allows manual resizing
  };
  
  gridToolbar: string[] = ['Search'];

  @ViewChild('syncfusionGrid') syncfusionGrid!: GridComponent;
  private gridInitialized: boolean = false;
  private isUpdatingGrid: boolean = false; // Prevent infinite loops
  private lastDataLength: number = 0; // Track last processed data length
  private lastDataReference: any = null; // Track last data reference for performance
  private lastColumnsString: string = ''; // Track last processed columns

  constructor(
    private exportService: ExportService,
    private toastService: ToastService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.initializeColumns();
    this.processData();
  }

  ngAfterViewInit(): void {
    this.gridInitialized = true;
    // Use requestAnimationFrame for immediate initialization - more efficient than setTimeout
    requestAnimationFrame(() => {
      if (this.data && this.data.length > 0) {
        this.initializeSyncfusionGrid();
      }
      
      // Set up global observer to watch for filter dialogs
      this.setupFilterDialogObserver();
    });
  }

  private setupFilterDialogObserver(): void {
    // Use MutationObserver to watch for filter dialogs appearing in the DOM
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === 1) { // Element node
            const element = node as Element;
            // Check if the added node is a filter popup or contains one
            if (element.classList.contains('e-filter-popup') || 
                element.classList.contains('e-filterdialog') ||
                element.querySelector('.e-filter-popup') ||
                element.querySelector('.e-filterdialog')) {
              // Filter dialog appeared, set up validation
              setTimeout(() => {
                this.setupFilterButtonValidation();
              }, 100);
            }
          }
        });
      });
    });

    // Start observing the document body for filter dialogs
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  /**
   * Initialize Syncfusion Grid with dynamic columns and data
   * Optimized for performance - no unnecessary delays
   */
  initializeSyncfusionGrid(): void {
    if (!this.data || this.data.length === 0) {
      return;
    }
    
    // Update columns first, then data
    this.updateSyncfusionGridColumns();
    
    // Update data immediately - Syncfusion Grid handles the binding efficiently
    // Use requestAnimationFrame for smooth rendering
    requestAnimationFrame(() => {
      this.updateSyncfusionGridData();
      this.cdr.detectChanges();
    });
  }

         /**
    * Update Syncfusion Grid data from input data
    * Optimized for performance - uses efficient shallow copy for better binding speed
    */
      updateSyncfusionGridData(): void {
      // Use actual query results data, or empty array if no data
      if (this.data && this.data.length > 0) {
        // Quick check: if data reference is the same and length matches, skip update
        if (this.data === this.lastDataReference && this.data.length === this.lastDataLength && this.syncfusionGridData.length > 0) {
          return; // Same data reference, skip update
        }

        // Update tracking references
        this.lastDataLength = this.data.length;
        this.lastDataReference = this.data;

        // Use efficient shallow copy - much faster than deep copy
        // For most SQL query results, shallow copy is sufficient
        // This creates new array references which triggers Angular change detection
        this.syncfusionGridData = this.data.map(row => ({ ...row }));
        
        // Verify data structure matches columns (only log errors)
        if (this.syncfusionGridData.length > 0 && this.syncfusionGridColumns.length > 0) {
          const dataKeys = Object.keys(this.syncfusionGridData[0]);
          const columnFields = this.syncfusionGridColumns.map(col => col.field);
          
          const missingInColumns = dataKeys.filter(key => !columnFields.includes(key));
          if (missingInColumns.length > 0) {
            console.error('❌ Data keys not in columns:', missingInColumns);
          }
        }
             } else {
        // Only clear if we actually have data to clear
        if (this.syncfusionGridData.length > 0) {
          this.syncfusionGridData = [];
          this.lastDataLength = 0;
          this.lastDataReference = null;
        }
      }
   }

  /**
   * Dynamically create Syncfusion Grid columns from data structure
   */
  updateSyncfusionGridColumns(): void {
    if (!this.data || this.data.length === 0) {
      if (this.syncfusionGridColumns.length > 0) {
        this.syncfusionGridColumns = [];
        this.lastColumnsString = '';
      }
      return;
    }

    // Always use ALL keys from the first data row to ensure we capture all columns
    const dataKeys = Object.keys(this.data[0]);
    
    // Use input columns if provided, otherwise use all data keys
    // But ensure we include ALL data keys even if input columns are provided
    let columnFields: string[] = [];
    if (this.columns && this.columns.length > 0) {
      // Merge: use input columns, but add any missing keys from data
      columnFields = [...new Set([...this.columns, ...dataKeys])];
    } else {
      // Use all keys from data
      columnFields = [...dataKeys];
    }

    // Check if columns actually changed using tracked string
    const newColumnFieldsString = columnFields.sort().join(',');
    
    if (newColumnFieldsString === this.lastColumnsString && this.syncfusionGridColumns.length > 0) {
      return; // Columns haven't changed, skip update
    }

    // Update tracked columns string
    this.lastColumnsString = newColumnFieldsString;

    if (columnFields.length === 0) {
      if (this.syncfusionGridColumns.length > 0) {
        this.syncfusionGridColumns = [];
        this.lastColumnsString = '';
      }
      return;
    }

    // Create Syncfusion grid columns dynamically - use ALL fields from data
    this.syncfusionGridColumns = columnFields.map(field => {
      // Get sample value from first row
      const sampleValue = this.data[0] && this.data[0].hasOwnProperty(field) 
        ? this.data[0][field] 
        : null;
      
      const columnConfig: any = {
        field: field, // Ensure field name matches exactly with data property
        headerText: this.formatHeaderText(field),
        width: this.calculateColumnWidth(field, sampleValue),
        allowFiltering: true,
        allowSorting: true,
        allowGrouping: true,
        allowReordering: true, // Enable column reordering for each column
        allowResizing: true // Enable column resizing for each column
      };

      // Determine column type and format
      const columnType = this.detectSyncfusionColumnType(field, sampleValue);
      
      if (columnType === 'number') {
        columnConfig.type = 'number';
        columnConfig.textAlign = 'Right';
        // Format currency if field name suggests it
        if (field.toLowerCase().includes('salary') || field.toLowerCase().includes('amount') || field.toLowerCase().includes('price') || field.toLowerCase().includes('cost')) {
          columnConfig.format = 'C2';
        }
      } else if (columnType === 'date') {
        // Keep dates as string type to display as-is from API (e.g., "2025-09-29")
        // This preserves the original format and allows proper filtering
        columnConfig.type = 'string';
      } else if (columnType === 'boolean') {
        columnConfig.type = 'boolean';
        columnConfig.textAlign = 'Center';
        columnConfig.displayAsCheckBox = true;
      } else {
        columnConfig.type = 'string';
      }

      return columnConfig;
    });

    // Create new array reference to trigger change detection
    this.syncfusionGridColumns = [...this.syncfusionGridColumns];
    
    // Verify all data keys have corresponding columns
    const missingColumns = dataKeys.filter(key => !this.syncfusionGridColumns.some(col => col.field === key));
    if (missingColumns.length > 0) {
      console.error('ERROR: Data keys without columns:', missingColumns);
      // Add missing columns
      missingColumns.forEach(key => {
        const sampleValue = this.data[0][key];
        this.syncfusionGridColumns.push({
          field: key,
          headerText: this.formatHeaderText(key),
          width: this.calculateColumnWidth(key, sampleValue),
          type: this.detectSyncfusionColumnType(key, sampleValue) === 'number' ? 'number' : 
                this.detectSyncfusionColumnType(key, sampleValue) === 'date' ? 'string' : // Display dates as-is from API
                this.detectSyncfusionColumnType(key, sampleValue) === 'boolean' ? 'boolean' : 'string',
          allowFiltering: true,
          allowSorting: true,
          allowGrouping: true
        });
      });
    }
    
                   // Note: Don't call refresh() manually - Syncfusion Grid automatically updates
      // when dataSource and columns properties change. Manual refresh() can cause DOM errors.
      // Don't call markForCheck() here to avoid triggering unnecessary change detection cycles
  }

  /**
   * Format header text from field name
   */
  formatHeaderText(field: string): string {
    // Convert camelCase or snake_case to Title Case
    return field
      .replace(/([A-Z])/g, ' $1') // Add space before capital letters
      .replace(/_/g, ' ') // Replace underscores with spaces
      .replace(/^./, str => str.toUpperCase()) // Capitalize first letter
      .trim();
  }

  /**
   * Calculate column width based on field name and sample value
   */
  calculateColumnWidth(field: string, sampleValue: any): number {
    const fieldLower = field.toLowerCase();
    
    // Special cases for common field types
    if (fieldLower.includes('id') || fieldLower.includes('count')) {
      return 80;
    }
    if (fieldLower.includes('email')) {
      return 220;
    }
    if (fieldLower.includes('name') || fieldLower.includes('title')) {
      return 180;
    }
    if (fieldLower.includes('date') || fieldLower.includes('time')) {
      return 130;
    }
    if (fieldLower.includes('salary') || fieldLower.includes('amount') || fieldLower.includes('price')) {
      return 120;
    }
    if (fieldLower.includes('description') || fieldLower.includes('comment') || fieldLower.includes('notes')) {
      return 300;
    }
    if (typeof sampleValue === 'boolean') {
      return 100;
    }
    if (typeof sampleValue === 'number') {
      return 120;
    }
    
    // Default width based on sample value length
    if (sampleValue !== null && sampleValue !== undefined) {
      const stringLength = String(sampleValue).length;
      return Math.max(120, Math.min(250, stringLength * 8));
    }
    
    return 150; // Default width
  }

  /**
   * Detect Syncfusion column type from field name and sample value
   */
  detectSyncfusionColumnType(field: string, sampleValue: any): 'string' | 'number' | 'date' | 'boolean' {
    // Check sample value type first
    if (sampleValue === null || sampleValue === undefined) {
      // Infer from field name
      const fieldLower = field.toLowerCase();
      if (fieldLower.includes('date') || fieldLower.includes('time')) {
        return 'date';
      }
      if (fieldLower.includes('id') || fieldLower.includes('count') || fieldLower.includes('amount') || fieldLower.includes('price') || fieldLower.includes('salary')) {
        return 'number';
      }
      if (fieldLower.includes('is') || fieldLower.includes('has') || fieldLower.includes('active')) {
        return 'boolean';
      }
      return 'string';
    }

    // Check actual value type
    if (typeof sampleValue === 'boolean') {
      return 'boolean';
    }
    if (typeof sampleValue === 'number') {
      return 'number';
    }
    if (sampleValue instanceof Date) {
      return 'date';
    }
    if (typeof sampleValue === 'string') {
      // Check if it's a date string
      if (/^\d{4}-\d{2}-\d{2}/.test(sampleValue) || /^\d{2}\/\d{2}\/\d{4}/.test(sampleValue)) {
        return 'date';
      }
      // Check if it's a number string
      if (!isNaN(Number(sampleValue)) && sampleValue.trim() !== '') {
        return 'number';
      }
      return 'string';
    }

    return 'string';
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['data'] || changes['columns']) {
      // Prevent infinite loops - don't update if we're already updating
      if (this.isUpdatingGrid) {
        return;
      }

      const previousDataLength = changes['data']?.previousValue?.length ?? 0;
      const currentDataLength = this.data?.length ?? 0;
      
      // Only update if data actually changed
      // Check if this is the first change (previousValue is undefined) or if values actually differ
      const dataChanged = changes['data'] && (
        changes['data'].previousValue === undefined || 
        changes['data'].previousValue !== changes['data'].currentValue ||
        (changes['data'].previousValue?.length !== changes['data'].currentValue?.length)
      );
      const columnsChanged = changes['columns'] && (
        changes['columns'].previousValue === undefined ||
        changes['columns'].previousValue !== changes['columns'].currentValue ||
        (JSON.stringify(changes['columns'].previousValue) !== JSON.stringify(changes['columns'].currentValue))
      );
      
      // Always process on first load, but skip if we're already updating
      if (!dataChanged && !columnsChanged && this.syncfusionGridData.length > 0) {
        return; // No actual change and data already exists, skip update
      }
      
      this.initializeColumns();
      this.processData();
      
      // Update Syncfusion Grid when data or columns change
      // Only proceed if view is initialized and we have data
      if (this.gridInitialized && this.data && this.data.length > 0) {
        // Use requestAnimationFrame for better performance - runs before next repaint
        requestAnimationFrame(() => {
          this.isUpdatingGrid = true;
          
          // Update columns first (needed for proper data binding)
          this.updateSyncfusionGridColumns();
          
          // Update data immediately after columns (no delay needed)
          // Syncfusion Grid handles updates efficiently
          this.updateSyncfusionGridData();
          
          // Trigger change detection manually for immediate update
          this.cdr.detectChanges();
          
          // Reset flag after update completes
          requestAnimationFrame(() => {
            this.isUpdatingGrid = false;
          });
        });
      } else if (!this.gridInitialized) {
        // Grid not initialized yet, will update after view init
      }
    }
  }

  initializeColumns(): void {
    if (!this.columns || this.columns.length === 0) {
      if (this.data && this.data.length > 0) {
        this.columns = Object.keys(this.data[0]);
      } else {
        this.columns = [];
      }
    }

    this.gridColumns = this.columns.map(col => ({
      field: col,
      header: col,
      type: this.detectColumnType(col),
      sortable: true,
      filterable: true,
      groupable: true
    }));
  }

  detectColumnType(field: string): 'string' | 'number' | 'date' | 'boolean' {
    if (!this.data || this.data.length === 0) {
      return 'string';
    }

    const sampleValue = this.data[0][field];
    
    if (sampleValue === null || sampleValue === undefined) {
      // Try to infer from field name
      const lowerField = field.toLowerCase();
      if (lowerField.includes('date') || lowerField.includes('time')) {
        return 'date';
      }
      if (lowerField.includes('id') || lowerField.includes('count') || lowerField.includes('total')) {
        return 'number';
      }
      if (lowerField.includes('is') || lowerField.includes('has')) {
        return 'boolean';
      }
      return 'string';
    }

    if (typeof sampleValue === 'boolean') {
      return 'boolean';
    }
    if (typeof sampleValue === 'number') {
      return 'number';
    }
    if (sampleValue instanceof Date) {
      return 'date';
    }
    if (typeof sampleValue === 'string' && /^\d{4}-\d{2}-\d{2}/.test(sampleValue)) {
      return 'date';
    }

    return 'string';
  }

  processData(): void {
    let processed = [...this.data];

    // Apply filters
    if (this.filters.size > 0) {
      processed = processed.filter(row => {
        return Array.from(this.filters.entries()).every(([field, filterValue]) => {
          if (!filterValue) return true;
          const cellValue = String(row[field] || '').toLowerCase();
          return cellValue.includes(filterValue.toLowerCase());
        });
      });
    }

    // Apply sorting
    if (this.sorts.length > 0) {
      processed.sort((a, b) => {
        for (const sort of this.sorts) {
          const aVal = a[sort.field];
          const bVal = b[sort.field];
          let comparison = 0;

          if (aVal === null || aVal === undefined) comparison = 1;
          else if (bVal === null || bVal === undefined) comparison = -1;
          else if (typeof aVal === 'string') {
            comparison = aVal.localeCompare(bVal);
          } else {
            comparison = aVal > bVal ? 1 : aVal < bVal ? -1 : 0;
          }

          if (comparison !== 0) {
            return sort.direction === 'asc' ? comparison : -comparison;
          }
        }
        return 0;
      });
    }

    this.filteredData = processed;
    this.totalPages = Math.ceil(this.filteredData.length / this.pageSize);
    this.updateDisplayedData();
  }

  updateDisplayedData(): void {
    const start = (this.currentPage - 1) * this.pageSize;
    const end = start + this.pageSize;
    this.displayedData = this.filteredData.slice(start, end);
  }

  // Filtering
  onFilterChange(field: string, value: string): void {
    if (value) {
      this.filters.set(field, value);
    } else {
      this.filters.delete(field);
    }
    this.currentPage = 1;
    this.processData();
    this.emitFilterChange();
  }

  clearFilter(field: string): void {
    this.filters.delete(field);
    this.processData();
    this.emitFilterChange();
  }

  toggleFilterMenu(field: string): void {
    const current = this.showFilterMenu.get(field) || false;
    this.showFilterMenu.forEach((_, key) => this.showFilterMenu.set(key, false));
    this.showFilterMenu.set(field, !current);
  }

  emitFilterChange(): void {
    const filterArray: GridFilter[] = Array.from(this.filters.entries()).map(([field, value]) => ({
      field,
      operator: 'contains',
      value
    }));
    this.filterChange.emit(filterArray);
    this.updateSQL();
  }

  // Sorting
  onSort(field: string): void {
    const existingSort = this.sorts.find(s => s.field === field);
    
    if (!existingSort) {
      this.sorts = [{ field, direction: 'asc' }];
    } else if (existingSort.direction === 'asc') {
      existingSort.direction = 'desc';
    } else {
      this.sorts = this.sorts.filter(s => s.field !== field);
    }

    this.processData();
    this.emitSortChange();
  }

  getSortIcon(field: string): string {
    const sort = this.sorts.find(s => s.field === field);
    if (!sort) return '';
    return sort.direction === 'asc' ? '↑' : '↓';
  }

  emitSortChange(): void {
    this.sortChange.emit(this.sorts);
    this.updateSQL();
  }

  // Grouping
  onGroup(field: string): void {
    const existingGroup = this.groups.find(g => g.field === field);
    if (existingGroup) {
      this.groups = this.groups.filter(g => g.field !== field);
    } else {
      this.groups.push({ field });
    }
    this.processData();
    this.emitGroupChange();
  }

  isGrouped(field: string): boolean {
    return this.groups.some(g => g.field === field);
  }

  emitGroupChange(): void {
    this.groupChange.emit(this.groups);
    this.updateSQL();
  }

  // Pagination
  goToPage(page: number): void {
    if (page >= 1 && page <= this.totalPages) {
      this.currentPage = page;
      this.updateDisplayedData();
    }
  }

  nextPage(): void {
    if (this.currentPage < this.totalPages) {
      this.currentPage++;
      this.updateDisplayedData();
    }
  }

  previousPage(): void {
    if (this.currentPage > 1) {
      this.currentPage--;
      this.updateDisplayedData();
    }
  }

  // Export
  exportCSV(): void {
    const dataToExport = this.selectedRows.size > 0
      ? this.filteredData.filter((_, index) => this.selectedRows.has(index))
      : this.filteredData;

    if (dataToExport.length === 0) {
      this.toastService.warning('No data to export');
      return;
    }

    this.exportService.exportToCSV(dataToExport, this.columns);
    this.toastService.success(`Exported ${dataToExport.length} rows to CSV`);
  }

  exportExcel(): void {
    const dataToExport = this.selectedRows.size > 0
      ? this.filteredData.filter((_, index) => this.selectedRows.has(index))
      : this.filteredData;

    if (dataToExport.length === 0) {
      this.toastService.warning('No data to export');
      return;
    }

    this.exportService.exportToExcel(dataToExport, this.columns);
    this.toastService.success(`Exported ${dataToExport.length} rows to Excel`);
  }

  async copyToClipboard(): Promise<void> {
    const dataToExport = this.selectedRows.size > 0
      ? this.filteredData.filter((_, index) => this.selectedRows.has(index))
      : this.filteredData;

    if (dataToExport.length === 0) {
      this.toastService.warning('No data to copy');
      return;
    }

    const success = await this.exportService.copyToClipboard(dataToExport, this.columns);
    if (success) {
      this.toastService.success(`Copied ${dataToExport.length} rows to clipboard`);
    } else {
      this.toastService.error('Failed to copy to clipboard');
    }
  }

  refresh(): void {
    this.currentPage = 1;
    this.filters.clear();
    this.sorts = [];
    this.groups = [];
    this.selectedRows.clear();
    this.selectAll = false;
    this.processData();
    this.toastService.info('Grid refreshed');
  }

  // Selection
  toggleSelectAll(): void {
    this.selectAll = !this.selectAll;
    if (this.selectAll) {
      this.displayedData.forEach((_, index) => {
        const globalIndex = (this.currentPage - 1) * this.pageSize + index;
        this.selectedRows.add(globalIndex);
      });
    } else {
      this.selectedRows.clear();
    }
  }

  toggleRowSelection(index: number): void {
    const globalIndex = (this.currentPage - 1) * this.pageSize + index;
    if (this.selectedRows.has(globalIndex)) {
      this.selectedRows.delete(globalIndex);
    } else {
      this.selectedRows.add(globalIndex);
    }
  }

  isRowSelected(index: number): boolean {
    const globalIndex = (this.currentPage - 1) * this.pageSize + index;
    return this.selectedRows.has(globalIndex);
  }

  // Formatting
  formatValue(value: any, type: string): string {
    if (value === null || value === undefined) {
      return '';
    }

    switch (type) {
      case 'date':
        // Display dates as-is from API (e.g., "2025-09-29")
        return String(value);
      
      case 'number':
        if (typeof value === 'number') {
          // Format with commas for large numbers
          return value.toLocaleString();
        }
        return String(value);
      
      case 'boolean':
        return value ? '✓' : '✗';
      
      default:
        return String(value);
    }
  }

  // SQL Update
  updateSQL(): void {
    // This will be called to update SQL based on grid actions
    // Implementation will be done in parent component
    this.sqlUpdate.emit('sql-update-requested');
  }

  // Syncfusion Grid Event Handlers
  onGridActionComplete(event: any): void {
    // Handle filter, sort, and group actions
    if (event.requestType === 'filtering') {
      this.handleGridFilters();
    } else if (event.requestType === 'sorting') {
      this.handleGridSorts();
    } else if (event.requestType === 'grouping') {
      // Use requestAnimationFrame for immediate update while ensuring grid state is ready
      requestAnimationFrame(() => {
        this.handleGridGroups(event);
      });
    } else if (event.requestType === 'ungrouping') {
      // Use requestAnimationFrame for immediate update while ensuring grid state is ready
      requestAnimationFrame(() => {
        this.handleGridGroups(event);
      });
    } else if (event.requestType === 'reorder') {
      // Column reordering completed - sync the column order
      setTimeout(() => {
        this.handleColumnReorder();
      }, 10);
    }
  }

  private updateGroupSettingsFromEvent(event: any): void {
    // Update our local groupSettings to match the grid's state
    if (this.syncfusionGrid) {
      const gridInstance = this.syncfusionGrid as any;
      
      // Wait a bit for grid to update its internal state
      setTimeout(() => {
        const currentGroupSettings = gridInstance.groupSettings;
        
        // Sync the settings
        if (currentGroupSettings && currentGroupSettings.columns) {
          this.gridGroupSettings.columns = [...currentGroupSettings.columns];
        } else {
          // Try alternative access methods
          const altSettings = (gridInstance as any).getGroupSettings?.() || 
                             (gridInstance as any).groupSettings;
          if (altSettings && altSettings.columns) {
            this.gridGroupSettings.columns = [...altSettings.columns];
          }
        }
      }, 10);
    }
  }

  private handleColumnReorder(): void {
    if (!this.syncfusionGrid) return;

    try {
      // Get the current column order from the grid after reorder
      // The grid's columns property is automatically updated by Syncfusion
      const gridInstance = this.syncfusionGrid as any;
      if (gridInstance.columns && Array.isArray(gridInstance.columns)) {
        // Create a new array with the reordered columns to trigger change detection
        // We need to preserve all column properties
        this.syncfusionGridColumns = gridInstance.columns.map((col: any) => {
          // Find the original column to preserve all properties
          const originalCol = this.syncfusionGridColumns.find(c => c.field === col.field);
          if (originalCol) {
            return { ...originalCol, ...col };
          }
          return { ...col };
        });
      }
    } catch (error) {
      console.error('Error handling column reorder:', error);
    }
  }

  onGridActionBegin(event: any): void {
    // Intercept filter actions to prevent applying empty filters
    if (event.requestType === 'filtering') {
      // Set up filter button validation when filter dialog opens
      if (event.action === 'openFilterDialog' || event.action === 'filter') {
        setTimeout(() => {
          this.setupFilterButtonValidation();
        }, 200);
      }
      
      // Check filter model if it exists
      if (event.filterModel) {
        const filterModel = event.filterModel;
        
        // Check if filter value is empty (except for NULL operators)
        if (filterModel && filterModel.value !== null && filterModel.value !== undefined) {
          const filterValue = filterModel.value.toString().trim();
          const operator = filterModel.operator || '';
          const operatorStr = operator.toString().toLowerCase();
          
          // Check if operator is NULL/IS NULL (these don't need values)
          const isNullOperator = operatorStr.includes('null') || 
                                operatorStr === 'isnull' || 
                                operatorStr === 'is not null' || 
                                operatorStr === 'isnotnull';
          
          // Cancel filter if value is empty and not a NULL operator
          if (filterValue === '' && !isNullOperator) {
            event.cancel = true;
            return;
          }
        } else if (filterModel && (filterModel.value === null || filterModel.value === undefined || filterModel.value === '')) {
          const operator = filterModel.operator || '';
          const operatorStr = operator.toString().toLowerCase();
          const isNullOperator = operatorStr.includes('null') || 
                                operatorStr === 'isnull' || 
                                operatorStr === 'is not null' || 
                                operatorStr === 'isnotnull';
          
          // Cancel filter if value is empty and not a NULL operator
          if (!isNullOperator) {
            event.cancel = true;
            return;
          }
        }
      }
    }
  }

  onGridDataBound(event: any): void {
    // Customize filter UI to disable filter button when value is empty
    if (!this.syncfusionGrid) return;

    try {
      // Use setTimeout to ensure DOM is ready
      setTimeout(() => {
        this.setupFilterButtonValidation();
      }, 100);
    } catch (error) {
      console.error('Error in onGridDataBound:', error);
    }
  }

  private setupFilterButtonValidation(): void {
    if (!this.syncfusionGrid) return;

    try {
      // Find filter popup/dialog
      const filterPopup = document.querySelector('.e-filter-popup') || 
                         document.querySelector('.e-filterdialog') ||
                         document.querySelector('.e-popup-open');
      
      if (filterPopup) {
        const inputs = filterPopup.querySelectorAll('input[type="text"], input.e-input, input:not([type="hidden"])');
        const operatorSelects = filterPopup.querySelectorAll('select, .e-dropdownlist, [role="combobox"]');
        const filterButtons = filterPopup.querySelectorAll('.e-primary, button.e-btn-primary, .e-filter-apply, button[type="button"]');
        
        // Function to validate and enable/disable filter button
        const validateFilterButton = () => {
          let hasValidValue = false;
          
          // Check all inputs
          inputs.forEach((input: any) => {
            const value = input.value ? input.value.toString().trim() : '';
            if (value !== '') {
              hasValidValue = true;
            }
          });
          
          // Check if any operator is NULL/IS NULL
          let isNullOperator = false;
          operatorSelects.forEach((select: any) => {
            const operatorValue = select.value || select.textContent || '';
            const operatorStr = operatorValue.toString().toLowerCase();
            if (operatorStr.includes('null') || 
                operatorStr === 'isnull' || 
                operatorStr === 'is not null' || 
                operatorStr === 'isnotnull') {
              isNullOperator = true;
            }
          });
          
          // Enable/disable filter buttons
          filterButtons.forEach((button: any) => {
            if (hasValidValue || isNullOperator) {
              button.disabled = false;
              button.classList.remove('e-disabled');
            } else {
              button.disabled = true;
              button.classList.add('e-disabled');
            }
          });
        };
        
        // Add event listeners to inputs
        inputs.forEach((input: any) => {
          input.addEventListener('input', validateFilterButton);
          input.addEventListener('change', validateFilterButton);
        });
        
        // Add event listeners to operator selects
        operatorSelects.forEach((select: any) => {
          select.addEventListener('change', validateFilterButton);
          // Also handle Syncfusion dropdown components
          if ((select as any).ej2_instances && (select as any).ej2_instances[0]) {
            const dropdownInstance = (select as any).ej2_instances[0];
            if (dropdownInstance.change) {
              const originalChange = dropdownInstance.change;
              dropdownInstance.change = (args: any) => {
                if (originalChange) originalChange.call(dropdownInstance, args);
                validateFilterButton();
              };
            } else {
              dropdownInstance.change = validateFilterButton;
            }
          }
        });
        
        // Initial validation
        validateFilterButton();
        
        // Use MutationObserver to watch for filter dialog changes
        const observer = new MutationObserver(() => {
          validateFilterButton();
        });
        
        observer.observe(filterPopup, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['value', 'disabled']
        });
      }
    } catch (error) {
      console.error('Error setting up filter button validation:', error);
    }
  }

  onGridFiltering(event: any): void {
    // Filter event is being triggered
    // Set up filter button validation when filter dialog opens
    if (event && event.type === 'filtering') {
      // Use setTimeout to ensure filter dialog is rendered
      setTimeout(() => {
        this.setupFilterButtonValidation();
      }, 200);
    }
    // We'll handle it in actionComplete to get final state
  }

  onGridSorted(event: any): void {
    // Sort event is being triggered
    // We'll handle it in actionComplete to get final state
  }

  onGridGrouping(event: any): void {
    // Grouping event is being triggered
    // We'll handle it in actionComplete to get final state
    
    // Try to get groups directly from the event if available
    if (event && event.columns) {
      const groups: GridGroup[] = [];
      event.columns.forEach((col: any) => {
        const field = col.field || col.name || col.columnName;
        if (field) {
          groups.push({ field: field });
        }
      });
      if (groups.length > 0) {
        this.groupChange.emit(groups);
        // Note: Don't call updateSQL() here - groupChange.emit() already triggers onGridGroupChange() 
        // in parent component which calls updateSQLFromGrid()
      }
    }
  }

  private handleGridFilters(): void {
    if (!this.syncfusionGrid) return;

    try {
      // Access filter settings from the grid
      const filterSettings = (this.syncfusionGrid as any).filterSettings;
      const filters: GridFilter[] = [];

      // Syncfusion Grid filter settings structure: { columns: [{ field, operator, value, ... }] }
      if (filterSettings && filterSettings.columns && Array.isArray(filterSettings.columns)) {
        filterSettings.columns.forEach((filterCol: any) => {
          if (filterCol.field) {
            const operator = filterCol.operator || '';
            const operatorStr = String(operator).toLowerCase().trim();
            
            // Check if operator is NULL/IS NULL (these don't need values)
            const isNullOperator = operatorStr.includes('null') || 
                                  operatorStr === 'isnull' || 
                                  operatorStr === 'is not null' || 
                                  operatorStr === 'isnotnull' ||
                                  operatorStr === '6' || // IsNULL enum value
                                  operatorStr === '7';   // IsNotNULL enum value
            
            // Include filter if:
            // 1. It has a value (not null, undefined, or empty), OR
            // 2. It's a NULL operator (which doesn't need a value)
            const hasValue = filterCol.value !== null && 
                           filterCol.value !== undefined && 
                           filterCol.value !== '';
            
            if (hasValue || isNullOperator) {
              // Map Syncfusion NULL operator strings to enum values
              let mappedOperator = filterCol.operator;
              if (isNullOperator) {
                // Map to enum values: IsNULL = 6, IsNotNULL = 7
                if (operatorStr.includes('not')) {
                  mappedOperator = '7'; // IsNotNULL
                } else {
                  mappedOperator = '6'; // IsNULL
                }
              }
              
              filters.push({
                field: filterCol.field,
                operator: mappedOperator || (isNullOperator ? '6' : 'contains'),
                value: filterCol.value
              });
            }
          }
        });
      }

      // Always emit, even if filters are cleared (empty array)
      this.filterChange.emit(filters);
      // Note: Don't call updateSQL() here - filterChange.emit() already triggers onGridFilterChange() 
      // in parent component which calls updateSQLFromGrid()
    } catch (error) {
      console.error('Error handling grid filters:', error);
    }
  }

  private handleGridSorts(): void {
    if (!this.syncfusionGrid) return;

    try {
      // Access sort settings from the grid
      const sortSettings = (this.syncfusionGrid as any).sortSettings;
      const sorts: GridSort[] = [];

      // Get currently grouped columns to exclude them from sorts
      const groupedFields = new Set<string>();
      if (this.currentGroupedColumns && this.currentGroupedColumns.size > 0) {
        this.currentGroupedColumns.forEach(field => {
          groupedFields.add(field.toLowerCase());
        });
      }

      // Syncfusion Grid sort settings structure: { columns: [{ field, direction }] }
      if (sortSettings && sortSettings.columns && Array.isArray(sortSettings.columns)) {
        sortSettings.columns.forEach((sortCol: any) => {
          if (sortCol.field) {
            // Exclude sorts on grouped columns (they were auto-added by grouping)
            const fieldLower = sortCol.field.toLowerCase();
            if (!groupedFields.has(fieldLower)) {
              sorts.push({
                field: sortCol.field,
                direction: sortCol.direction === 'Descending' ? 'desc' : 'asc'
              });
            }
          }
        });
      }

      // Always emit, even if sorts are cleared (empty array)
      this.sortChange.emit(sorts);
      // Note: Don't call updateSQL() here - sortChange.emit() already triggers onGridSortChange() 
      // in parent component which calls updateSQLFromGrid()
    } catch (error) {
      console.error('Error handling grid sorts:', error);
    }
  }

  private handleGridGroups(event: any): void {
    if (!this.syncfusionGrid) return;

    try {
      const groups: GridGroup[] = [];
      const gridInstance = this.syncfusionGrid as any;
      const columnNameFromEvent = event?.columnName || event?.column?.field || event?.column?.headerText || event?.fieldName;
      const actionType = (event?.action || event?.requestType || '').toString().toLowerCase();
      const isUngroupAction = actionType.includes('ungroup');

      // Method 1: Direct access to groupSettings property from grid instance (most reliable)
      let groupSettings = gridInstance.groupSettings;

      // Method 2: Try to get from grid's element if direct access doesn't work
      if (!groupSettings || !groupSettings.columns) {
        const gridElement = gridInstance.element;
        if (gridElement) {
          const gridObj = (gridElement as any).ej2_instances?.[0];
          if (gridObj && gridObj.groupSettings) {
            groupSettings = gridObj.groupSettings;
          }
        }
      }

      // Method 3: Try getGroupSettings method if available
      if (!groupSettings || !groupSettings.columns) {
        if (typeof gridInstance.getGroupSettings === 'function') {
          groupSettings = gridInstance.getGroupSettings();
        }
      }

      // Method 4: Use our local gridGroupSettings as fallback
      if (!groupSettings || !groupSettings.columns) {
        groupSettings = this.gridGroupSettings;
      }

      // Extract groups from the settings and sync with our tracked columns
      if (groupSettings && Array.isArray(groupSettings.columns)) {
        // Clear and rebuild from grid settings
        this.currentGroupedColumns.clear();
        groupSettings.columns.forEach((groupCol: any) => {
          let field: string | undefined;
          if (typeof groupCol === 'string') {
            field = groupCol;
          } else {
            field = groupCol.field || groupCol.name || groupCol.columnName || groupCol.headerText;
          }
          if (field) {
            this.currentGroupedColumns.add(field);
            if (!groups.find(g => g.field.toLowerCase() === field!.toLowerCase())) {
              groups.push({ field: field });
            }
          }
        });
      }

      // Also try to get from the grid's internal API methods
      if (groups.length === 0 && typeof gridInstance.getGroupedColumns === 'function') {
        try {
          const groupedColumns = gridInstance.getGroupedColumns();
          if (groupedColumns && Array.isArray(groupedColumns)) {
            this.currentGroupedColumns.clear();
            groupedColumns.forEach((col: any) => {
              let field: string | undefined;
              if (typeof col === 'string') {
                field = col;
              } else {
                field = col.field || col.name || col.columnName || col.headerText;
              }
              if (field) {
                this.currentGroupedColumns.add(field);
                if (!groups.find(g => g.field.toLowerCase() === field!.toLowerCase())) {
                  groups.push({ field: field });
                }
              }
            });
          }
        } catch (e) {
          // getGroupedColumns method not available or error
        }
      }

      // Build groups from tracked columns if we have any
      if (groups.length === 0 && this.currentGroupedColumns.size > 0) {
        Array.from(this.currentGroupedColumns).forEach(field => {
          groups.push({ field: field });
        });
      }

      // Method 5: Try to read from DOM - grouping bar elements
      if (groups.length === 0) {
        try {
          const gridElement = gridInstance.element;
          if (gridElement) {
            const groupBarElements = gridElement.querySelectorAll('.e-groupbar-item, .e-groupbar-item-text, [class*="groupbar"]');
            if (groupBarElements && groupBarElements.length > 0) {
              groupBarElements.forEach((el: any) => {
                const text = el.textContent || el.innerText || '';
                const field = text.trim();
                if (field) {
                  const matchedCol = this.syncfusionGridColumns.find(col =>
                    col.field === field || col.headerText === field ||
                    col.field.toLowerCase() === field.toLowerCase() ||
                    col.headerText.toLowerCase() === field.toLowerCase()
                  );
                  if (matchedCol && !groups.find(g => g.field === matchedCol.field)) {
                    groups.push({ field: matchedCol.field });
                  }
                }
              });
            }
          }
        } catch (e) {
          // Error reading from DOM
        }
      }

      // Fallback: If we still don't have groups and this was a grouping action (not ungrouping),
      // use the column name from the event
      if (groups.length === 0 && columnNameFromEvent && !isUngroupAction) {
        const gridElement = gridInstance.element;
        let matchedField: string | undefined;

        if (gridElement) {
          const groupBar = gridElement.querySelector('.e-groupbar, [class*="groupbar"], .e-grouped-row');
          if (groupBar) {
            matchedField = columnNameFromEvent;
          }
        }

        if (!matchedField) {
          const matchedCol = this.syncfusionGridColumns.find(col =>
            col.field === columnNameFromEvent ||
            col.headerText === columnNameFromEvent ||
            col.field.toLowerCase() === columnNameFromEvent.toLowerCase() ||
            col.headerText.toLowerCase() === columnNameFromEvent.toLowerCase()
          );
          if (matchedCol) {
            matchedField = matchedCol.field;
          }
        }

        if (!matchedField) {
          matchedField = columnNameFromEvent;
        }

        if (matchedField) {
          groups.push({ field: matchedField });
        }
      }

      // Sync our tracked columns with what we found
      const previousGroupedFields = new Set(this.currentGroupedColumns);
      this.currentGroupedColumns.clear();
      groups.forEach(g => this.currentGroupedColumns.add(g.field));

      // If grouping was removed, also remove any auto-added sorts on those columns
      if (this.syncfusionGrid && previousGroupedFields.size > 0 && groups.length < previousGroupedFields.size) {
        const removedFields = Array.from(previousGroupedFields).filter(f => !this.currentGroupedColumns.has(f));
        if (removedFields.length > 0) {
          const gridInstance = this.syncfusionGrid as any;
          const sortSettings = gridInstance.sortSettings;
          if (sortSettings && sortSettings.columns) {
            // Remove sorts on ungrouped columns
            const filteredSorts = sortSettings.columns.filter((sortCol: any) => {
              const field = sortCol.field?.toLowerCase();
              return !removedFields.some(removed => removed.toLowerCase() === field);
            });
            gridInstance.sortSettings = { ...sortSettings, columns: filteredSorts };
          }
        }
      }

      this.groupChange.emit(groups);
      // Note: Don't call updateSQL() here - groupChange.emit() already triggers onGridGroupChange() 
      // in parent component which calls updateSQLFromGrid()
    } catch (error) {
      console.error('Error handling grid groups:', error);
    }
  }

}



