# ETL Designer

The ETL Designer provides a visual, drag-and-drop interface for creating data extraction, transformation, and loading workflows in IBM Netezza.

## Opening the ETL Designer

There are several ways to open the ETL Designer:

1. **Command Palette**: Press `Ctrl+Shift+P` → type "Netezza: Open ETL Designer"
2. **Schema Browser Toolbar**: Click the workflow icon (⚡) in the Netezza Schema view toolbar
3. **New Project**: Command Palette → "Netezza: New ETL Project"
4. **Open Existing**: Command Palette → "Netezza: Open ETL Project"

## Interface Overview

![ETL Designer Interface](screenshots/etl-designer.png)

The ETL Designer interface consists of four main areas:

### 1. Toolbar (Top)
- **📄 New**: Create a new ETL project
- **📂 Open**: Load an existing `.etl.json` project file
- **💾 Save**: Save the current project
- **▶️ Run**: Execute the ETL workflow
- **⏹️ Stop**: Cancel a running execution (appears during execution)

### 2. Toolbox (Left Panel)
The panel is labeled **Tasks** and uses letter badges rather than emoji icons. Click a task to add it to the canvas, or drag it onto the canvas or an existing container:

| Toolbox badge | Task | Description |
|---------------|------|-------------|
| `V` | **Variable** | Set a workflow variable from a user prompt, a static value, or a scalar SQL query |
| `S` | **SQL task** | Execute a SQL query against the selected or run-fallback database connection |
| `P` | **Python script** | Run an inline Python script or a selected `.py` file |
| `C` | **Container** | Group tasks in a sequence container on the main canvas |
| `E` | **Export** | Export query results to CSV, XLSB or Parquet |
| `I` | **Import** | Import CSV, XLSB or Parquet data into a selected database |

The toolbox also displays these hints below the task list:

- Drop a task onto the canvas or a container.
- Drag existing tasks into a container to group them.

### 3. Canvas (Center)
The main workspace where you build your workflow:
- **Drag tasks** from the toolbox to add them
- **Click** a task to select and edit it in the details inspector on the right
- **Drag from output (right connector) to input (left connector)** to create connections
- **Click a connection line** to delete it
- **Press Delete** or click the × button to remove a selected task

### 4. Properties Panel (Right)
Displays editable details of the selected task:

- Task name and description
- Task-specific settings, including the database connection for SQL/SELECT, Import and Export tasks
- Save/Revert actions

## Task Types

### SQL Task
Execute SQL queries against the selected database connection.

**Configuration:**
- **Query**: The SQL statement to execute
- **Connection**: Select a named saved connection, or use the run fallback connection

**Features:**
- Supports variable substitution: `${variableName}`
- Results can be passed to downstream tasks

### Python Script
Run Python scripts for data transformation or custom logic.

**Configuration:**
- **Script Source**: Inline code or external file
- **Script Path** (if file): Path to `.py` file
- **Script** (if inline): Python code
- **Interpreter**: Python executable (auto-detected by default)

**Features:**
- Environment variables from previous tasks are available
- Can read/write files for data exchange

### Export Task
Export query results to files.

**Configuration:**
- **Format**: CSV, XLSB (Excel Binary) or Parquet
- **Output Path**: Destination file path
- **Connection**: Select a named saved connection, or use the run fallback connection
- **Query**: SQL to generate export data

### Import Task
Import data from files into Netezza tables.

**Configuration:**
- **Input Path**: Source file (CSV, TSV, XLSB or Parquet)
- **Target Table**: Destination table name
- **Connection**: Select a named saved connection, or use the run fallback connection
- **Create Table**: Auto-create table if it doesn't exist
- **Format**: Auto-detected or specified

### Container Task
Group multiple tasks that should be treated as a unit, like an SSDT Sequence Container.

**Configuration:**
- **Child Tasks**: Drag new or existing tasks into the visible container area on the main canvas
- **Boundary paths**: Connections that cross the group are automatically represented by the container's success/failure ports
- **Move to canvas**: Select a child task and use the Properties panel to remove it from the group
- **Delete**: Deleting a container deletes its contained tasks after confirmation

## Connections and Execution Order

### Creating Connections
1. Hover over a task to see its connectors
2. Click and drag from the **output connector** (right side)
3. Drop on another task's **input connector** (left side)

### Deleting Connections
- **Click the connection line** (it highlights in red)
- Confirm deletion in the dialog

### Execution Rules
- **Connected tasks**: Run sequentially in dependency order
- **Unconnected tasks**: Run in parallel
- Uses **Kahn's algorithm** for topological sort to determine order

## Project Files

ETL projects are saved as `.etl.json` files containing:
- Project metadata (name, version)
- All nodes with their positions and configurations
- All connections between nodes
- Project variables

### Example Structure
```json
{
  "id": "project-123",
  "name": "Daily Data Load",
  "version": "1.0.0",
  "nodes": [...],
  "connections": [...],
  "variables": {}
}
```

## Running a Project

1. Ensure the task connections are configured, or have an active/run fallback connection
2. Click **▶️ Run** in the toolbar
3. Monitor progress in the **ETL Execution** output channel
4. Task nodes change color to indicate status:
   - 🔵 Blue: Pending
   - 🟡 Yellow: Running
   - 🟢 Green: Success
   - 🔴 Red: Error
   - ⚫ Grey: Skipped

### Stopping Execution
- Click **⏹️ Stop** to request cancellation
- Currently running tasks will attempt to stop gracefully

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Delete` | Delete selected task |
| `Double-click` | Configure task |
| `Right-click` | Context menu (delete) |

## Tips

1. **Plan your workflow** before building - sketch out the data flow
2. **Use meaningful names** for tasks to make the workflow readable
3. **Test incrementally** - add and test tasks one at a time
4. **Save frequently** - use `💾 Save` to preserve your work
5. **Check the output** - the ETL Execution channel shows detailed logs
