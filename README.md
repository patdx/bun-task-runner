# bun-task-runner

An task runner experiment with caching, dependency management, and file tracking.

## Features

- Task dependency management
- Caching based on input file changes
- File input/output tracking
- SQLite-based cache storage

## Installation

No external dependencies, just using built in features of Bun JS.

## Configuration

Create a `tasks.json` file in your project root. Each task can specify:

- Command to execute
- Dependencies on other tasks
- Input files or glob patterns to track
- Output files or glob patterns to cache
- Enable/disable caching (defaults to true)

## Usage

- Run a specific task
- List all available tasks
- Reset the cache database

## Example

```
cd example
bun ../task.ts build
bun ../task.ts reset
bun ../task.ts dev
```

## How It Works

1. Check and run dependencies in order
2. Hash input files to detect changes
3. Use cache if inputs haven't changed, otherwise run the task
4. Store results in SQLite

## Cache Management

The SQLite database stores:

- Task execution history
- Input file hashes
- Command outputs
- Output file contents

Reset the cache using the reset command.

## License

MIT
