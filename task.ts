import { $, Glob, randomUUIDv7 } from 'bun'
import { Database } from 'bun:sqlite'
import { unlinkSync } from 'node:fs'
import path from 'node:path'

// Initialize the database and create the task_cache table
using db = new Database('cache.sqlite', {
	strict: true,
})
db.exec('PRAGMA journal_mode = WAL;')

db.exec(`
  CREATE TABLE IF NOT EXISTS task_cache (
    id TEXT PRIMARY KEY,
    task_name TEXT,
    inputs TEXT,
    stdout TEXT,
    timestamp TEXT DEFAULT CURRENT_TIMESTAMP
  ) STRICT;
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS task_output (
    task_id TEXT,
    path TEXT,
    hash TEXT,
    content BLOB,
    FOREIGN KEY(task_id) REFERENCES task_cache(id) ON DELETE CASCADE
    PRIMARY KEY (task_id, path)
  ) STRICT;
`)

interface Task {
	command: string
	depends_on?: string[]
	inputs?: string[]
	outputs?: string[]
	cache?: boolean
}

interface Scripts {
	[key: string]: Task
}

interface FileInputs {
	[filepath: string]: string
}

async function hashInputs(task: Task): Promise<string> {
	const command = task.command
	const patterns = task.inputs
	const inputs: FileInputs = {}

	for (const pattern of patterns ?? []) {
		// Handle both direct file paths and globs
		const files = pattern.includes('*') ? new Glob(pattern).scan() : [pattern]

		for await (const filepath of files) {
			try {
				const content = await Bun.file(filepath).text()
				const hasher = new Bun.CryptoHasher('sha256')
				hasher.update(content)
				inputs[filepath] = hasher.digest('base64')
			} catch (err) {
				console.warn(`Warning: Could not read input file ${filepath}`)
			}
		}
	}

	// Create stable sorted JSON string
	return JSON.stringify({
		command,
		files: Object.fromEntries(
			Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b)),
		),
	})
}

async function prepareOutputs(
	task: Task,
): Promise<{ [filepath: string]: Uint8Array | null }> {
	const outputs: { [filepath: string]: Uint8Array | null } = {}

	for (const pattern of task.outputs ?? []) {
		// Handle both direct file paths and globs
		const files = pattern.includes('*') ? new Glob(pattern).scan() : [pattern]

		for await (const filepath of files) {
			try {
				const content = await Bun.file(filepath).bytes()
				outputs[filepath] = content
			} catch (err) {
				console.warn(`Warning: Could not read output file ${filepath}`)
				outputs[filepath] = null
			}
		}
	}

	return outputs
}

async function loadScripts(): Promise<Scripts> {
	const tasksPath = path.join(process.cwd(), 'tasks.json')
	console.log(`Loading tasks from ${tasksPath}`)
	const scripts = await import(tasksPath)
	return scripts.default.tasks
}

function usage(scripts: Scripts) {
	console.log('Usage: bun task-runner.ts <script-name>')
	console.log('Available scripts:')
	for (const [name, task] of Object.entries(scripts)) {
		const depends_on = task.depends_on ? task.depends_on.join(', ') : ''
		if (depends_on) {
			console.log(`  - ${name} (depends_on: ${depends_on})`)
		} else {
			console.log(`  - ${name}`)
		}
	}
}

async function runTask(scripts: Scripts, script_name: string) {
	const task = scripts[script_name]
	if (task.depends_on) {
		for (const dependency of task.depends_on) {
			await runTask(scripts, dependency)
		}
	}

	// Prepare inputs before running task
	const inputsHash = await hashInputs(task)

	// Check if task has already been run with the same inputs
	const cachedTask = db
		.query(`SELECT * FROM task_cache WHERE task_name = ? AND inputs = ?`)
		.get(script_name, inputsHash) as {
		id: string
		task_name: string
		inputs: string
		stdout: string
	} | null

	if (cachedTask) {
		console.log(`Cache hit for task: ${script_name}`)
		await restoreFromCache(cachedTask.id)
		console.log(`Output from cache: ${script_name}`)
		console.log(cachedTask.stdout)
		return
	}

	console.log(`Starting task: ${script_name}`)
	console.log(`> ${task.command}`)

	// Execute the command and capture stdout
	const stdout = await $`${{ raw: task.command }}`.text()

	if (task.cache ?? true) {
		// Prepare outputs after running task

		// Save execution data with input hash
		const taskId = randomUUIDv7()
		db.run(
			`INSERT INTO task_cache (id, task_name, inputs, stdout) ` +
				`VALUES (?, ?, ?, ?)`,
			[taskId, script_name, inputsHash, stdout],
		)

		const outputs = await prepareOutputs(task)

		for (const [filepath, content] of Object.entries(outputs)) {
			let digest = null
			if (content != null) {
				const hasher = new Bun.CryptoHasher('sha256')
				hasher.update(content)
				digest = hasher.digest('base64')
			}
			db.run(
				`INSERT INTO task_output (task_id, path, hash, content) ` +
					`VALUES (?, ?, ?, ?)`,
				[taskId, filepath, digest, content],
			)
		}
	}

	console.log(`Finished task: ${script_name}`)
}

async function resetDatabase() {
	db.exec('DELETE FROM task_cache;')
	db.exec('DELETE FROM task_output;')
	console.log('Database reset successfully.')
}

const args = process.argv.slice(2)
if (args.length < 1) {
	const scripts = await loadScripts()
	usage(scripts)
	process.exit(1)
}

const script_name = args[0]

if (script_name === 'reset') {
	await resetDatabase()
	process.exit(0)
}

const scripts = await loadScripts()

if (!scripts[script_name]) {
	console.error(`Error: Script '${script_name}' not found`)
	usage(scripts)
	process.exit(1)
}

await runTask(scripts, script_name)

await $`sqlite3 cache.sqlite .dump > cache.sql`

async function restoreFromCache(task_id: string) {
	console.log(`Restoring task from cache: ${task_id}`)
	const outputs = db
		.query(`SELECT * FROM task_output WHERE task_id = ?`)
		.all(task_id) as {
		path: string
		hash: string | null
		content: Uint8Array | null
	}[]

	console.log(`Restoring ${outputs.length} files from cache`)

	for (const { path, hash, content } of outputs) {
		if (hash == null || content == null) {
			console.log(`Clearing ${path}`)
			try {
				unlinkSync(path)
			} catch (err) {
				console.warn(`Warning: Could not delete file ${path}`)
			}
			continue
		}
		const currentContent = await getMaybeFileBytes(path)
		const currentHash = await getMaybeFileHash(currentContent)
		if (currentHash === hash) {
			console.log(`Skipping ${path} (unchanged)`)
			continue
		}
		console.log(`Writing ${path}`)
		await Bun.write(path, content)
	}
}

async function getMaybeFileBytes(path: string): Promise<Uint8Array | null> {
	try {
		const result = await Bun.file(path).bytes()
		return result
	} catch (err) {
		return null
	}
}
async function getMaybeFileHash(
	bytes: Uint8Array | null,
): Promise<string | null> {
	if (bytes == null) {
		return null
	}
	const hasher = new Bun.CryptoHasher('sha256')
	hasher.update(bytes)
	return hasher.digest('base64')
}
