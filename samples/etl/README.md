# ETL Designer Sample Projects

This folder contains sample ETL projects that demonstrate the capabilities of the Netezza ETL Designer.

## Available Samples

### 1. Simple SQL Pipeline
**File:** `simple-sql-pipeline.etl.json`

A basic example showing sequential SQL task execution:
- Creates a staging table
- Loads customer data
- Updates statistics

### 2. Data Export Workflow
**File:** `data-export-workflow.etl.json`

Demonstrates parallel export capabilities:
- Creates an export view
- Exports to CSV and XLSB **in parallel**
- Logs completion after both exports finish

### 3. CSV Import Pipeline
**File:** `csv-import-pipeline.etl.json`

Shows a typical data import workflow:
- Truncates staging table
- Imports CSV file
- Validates import count
- Merges to production table

### 4. Python Data Processing
**File:** `python-data-processing.etl.json`

Integrates Python scripts for data transformation:
- Exports raw data to CSV
- Runs Python pandas script for aggregation
- Imports transformed data back to database
- Marks source records as processed

## Usage

1. Open VS Code with the Netezza extension
2. Press `Ctrl+Shift+P` → `Netezza: Open ETL Designer`
3. Click **Open** in the toolbar
4. Navigate to `samples/etl/` and select a `.etl.json` file
5. The workflow will be loaded and visualized

## Variables

Sample projects use variables like `${schema}` and `${workspaceFolder}`. These are substituted at runtime:
- `${workspaceFolder}` → Your VS Code workspace root
- Custom variables defined in the project's `variables` section

## Requirements

- Active Netezza connection for SQL and Import/Export tasks
- Python with pandas installed (for Python Data Processing sample)
