# wakecron — design spec

- **Date:** 2026-11-05
- **Status:** Draft for review
- **One line:** A command-line tool for macOS that wakes the Mac from sleep and runs your
  scripts at scheduled times. Put scripts in `scripts/`, then run `wakecron add <script> <time>`.

## 1. Decisions from brainstorming

| Topic | Decision |
|---|---|
| Schedules | Repeating (daily or chosen weekdays) and one-time. No cron syntax. |
| Runs as | The logged-in user, via LaunchAgents. Never root. |
| Interface | CLI with arguments; prompts for anything missing when run in a terminal. |
| Mechanism | launchd starts each job; one-time `pmset` wake events wake the Mac 60 s early. |
| Language | JavaScript on Node.js 20 or newer, no npm dependencies. |
| Delivery | Zip file in chat (GitHub push is not available in this session). |

Rejected approaches: crontab + `pmset repeat` (cron skips jobs while asleep and never catches
up; `pmset repeat` allows only one repeating wake time per Mac) and an always-running daemon
(duplicates launchd and still needs `pmset`).

## 2. Goals and non-goals

Goals:

1. A `scripts/` folder; jobs refer to scripts by their path inside that folder.
2. `wakecron add <script> <time>` schedules a job; missing arguments are prompted for.
3. If the Mac is asleep, it wakes about 60 s before each run.
4. If the Mac slept through a run time anyway, launchd runs the job as soon as it wakes.
5. Each run's output, exit code and duration are logged per job; failed scheduled runs raise a
   macOS notification.
6. Commands to list, run now, remove, repair, set up and uninstall.
7. All logic is testable on Linux, using stand-ins for the macOS tools.

Non-goals for v1: cron expressions, root jobs, a GUI, powering on a Mac that is shut down,
catching up runs missed while the Mac was off, per-job timeouts, passing arguments to scripts
(a wrapper script covers that).

## 3. Layout

```
wakecron/
├── wakecron            entry point (#!/usr/bin/env node); checks Node version, calls lib/cli.js
├── lib/
│   ├── util.js         UsageError, ensureDir, writeFileAtomic
│   ├── schedule.js     parse times and days, next run, next wake, launchd intervals, display (pure)
│   ├── plist.js        JS value → plist XML (pure)
│   ├── sudoers.js      sudoers rule text and username check (pure)
│   ├── paths.js        every file location: project root, LaunchAgents dir, labels, tool paths
│   ├── jobs.js         job store (jobs/<id>.json), id generation, script lookup
│   ├── macos.js        the only module that runs external commands
│   ├── agents.js       build, install and remove LaunchAgents
│   ├── wake.js         reconcile pmset wake events with the jobs (lock + state file)
│   ├── runner.js       execute a job's script: log, keep awake, notify, clean up one-time jobs
│   └── cli.js          commands, argument parsing, prompts, output
├── scripts/hello.sh    example script
├── jobs/ logs/ state/  created at runtime, git-ignored
├── tests/              node:test suites, fake macOS tools, helpers
├── package.json        "private": true, no dependencies, "test": "node --test"
└── README.md
```

All modules are CommonJS. Only `macos.js` spawns processes; the pure modules take `now` and
other inputs as parameters so tests never depend on the clock.

## 4. Commands

| Command | What it does |
|---|---|
| `setup` | One-time: installs the sudoers rule (§8) and the login agent (§7.6). Asks for the password once. Safe to re-run. |
| `add [script] [when…] [--days D]` | Schedules a job. In a terminal, prompts for missing parts. |
| `list` (also the default) | Jobs with schedule, next run and last result; pending wake-ups; setup status. Read-only. |
| `run <id>` | Runs a job now, streaming output to the terminal and the log. Does not change the schedule. |
| `remove <id>` (alias `rm`) | Unloads and deletes the job. Keeps its log. |
| `sync` | Repair: rewrites every LaunchAgent with the current node path, folder path and PATH, removes orphaned agents, re-schedules all wake-ups. |
| `uninstall` | Removes all LaunchAgents, pending wake-ups and the sudoers rule. Leaves this folder. |
| `help`, `--help` | Usage text. |

Internal forms: `run <id> --scheduled` (launchd uses it) and `sync --wakes-only` (the login
agent uses it). Exit codes: 0 success, 1 failure, 2 usage error; `run` exits with the
script's exit code.

### 4.1 Time formats (`when`)

| Input | Meaning |
|---|---|
| `07:30`, `7:30`, `7:30pm`, `7:30 pm`, `7pm`, `12am` | Repeating at that time; days from `--days` (default daily) |
| `2026-11-06 18:00`, `2026-11-06T18:00`, `2026-11-06 6pm` | Once, at that local date and time |
| `+10m`, `+2h` | Once, that long from now, rounded up to the next whole minute |

`when` may span several arguments, so `add report.sh 2026-11-06 18:00` works without quotes.
Rejected with a clear message: seconds (`07:30:15`), out-of-range numbers, impossible dates
(`2026-02-30`), one-time times that are not in the future, `+0m`, and `--days` combined with a
one-time time.

### 4.2 Days (`--days`, `-d`)

`daily` (default), `weekdays` (Mon–Fri), `weekends` (Sat, Sun), or a comma list of day names and
ranges such as `mon,wed,fri`, `mon-fri` or `fri-mon` (ranges wrap). Names are `mon` … `sun`,
full names, or `tues`/`thur`/`thurs`, in any case.

### 4.3 Interactive add

When the script or the time is missing and both stdin and stdout are terminals:

1. List the files in `scripts/` (recursively, hidden files skipped), numbered; accept a number
   or a name.
2. Ask for the time, showing the three formats from §4.1.
3. For a repeating time without `--days`, ask for days (Enter means daily).

An invalid answer prints the error and asks again. End of input (Ctrl-D) aborts without changes
(exit 2). Without a terminal, missing arguments are a usage error.

### 4.4 Job IDs

`<slug>-<HHMM>`, for example `backup-0730`, with `-2`, `-3` … added on collisions. The slug is
the script's file name without extension, lowercased, with runs of non-alphanumerics replaced by
`-`, trimmed to 24 characters (`job` if empty). Adding a job with the same script and schedule as
an existing job is refused.

## 5. Data

### 5.1 Job file — `jobs/<id>.json`

```json
{
  "id": "backup-0730",
  "script": "backup.sh",
  "schedule": { "type": "repeat", "hour": 7, "minute": 30, "days": [1, 2, 3, 4, 5] },
  "node": "/opt/homebrew/bin/node",
  "root": "/Users/me/wakecron",
  "env": { "PATH": "…", "LANG": "en_US.UTF-8" },
  "createdAt": "2026-11-05T14:29:12.345Z"
}
```

- `script` is relative to `scripts/`.
- `schedule` is either `{type: "repeat", hour, minute, days}` (days use 0 = Sunday … 6 =
  Saturday, sorted, unique) or `{type: "once", at: "2026-11-06T18:00"}` (local wall-clock time).
- `node`, `root` and `env` record what the job's LaunchAgent was built with. `env.PATH` is the
  terminal's PATH at `add`/`sync` time, followed by `/opt/homebrew/bin`, `/opt/homebrew/sbin`,
  `/usr/local/bin`, `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`, with duplicates removed. `env.LANG`
  is copied only if set.
- Written atomically (temp file + rename) by `add` and `sync` only. Deleted by `remove` and by
  one-time cleanup. The runner never writes it, so it cannot resurrect a removed job.

### 5.2 Last run — `logs/<id>.last.json`

`{startedAt, finishedAt, exitCode, signal, durationMs, scheduled, error}` — written by the
runner after every run, manual or scheduled.

### 5.3 Run log — `logs/<id>.log`

Each run appends:

```
=== 2026-11-06 07:30:00 start backup.sh (scheduled) ===
…script stdout and stderr…
=== 2026-11-06 07:30:12 exit 0 after 12.3s ===
```

Runner warnings are lines starting with `[wakecron]`. Before a run, a log larger than 1 MiB is
renamed to `<id>.log.1`, replacing any older one. Logs are kept after `remove`.

### 5.4 Wake state — `state/wakes.json`

`{"scheduled": ["11/06/26 07:29:00", …]}` — the wake events wakecron believes it has scheduled
with pmset. Read and written only under the lock `state/wakes.lock` (§7.7).

### 5.5 LaunchAgents

Job agent `~/Library/LaunchAgents/local.wakecron.<id>.plist`:

| Key | Value |
|---|---|
| `Label` | `local.wakecron.<id>` |
| `ProgramArguments` | `[job.node, <job.root>/wakecron, "run", <id>, "--scheduled"]` |
| `StartCalendarInterval` | §6.4 |
| `EnvironmentVariables` | `job.env` |
| `StandardOutPath`, `StandardErrorPath` | `<root>/logs/launchd.log` (only runner crashes land here) |

No `RunAtLoad`, no `KeepAlive`, no `ProcessType`.

Login agent `~/Library/LaunchAgents/local.wakecron.sync.plist`: `ProgramArguments`
`[node, <root>/wakecron, "sync", "--wakes-only"]`, `RunAtLoad` true, `EnvironmentVariables` with
a PATH built as in §5.1, and the same log paths. The label `local.wakecron.sync` is reserved; no job can get the id `sync`.

Agents are loaded with `launchctl bootstrap gui/<uid> <plist>` (after a `launchctl bootout
gui/<uid>/<label>` whose failure is ignored) and unloaded with `launchctl bootout`.

## 6. Scheduling rules (`lib/schedule.js`, pure)

1. **Next run.** Repeat: the earliest local time at `hour:minute:00` on one of `days` that is
   strictly after `now`. Once: `at` if it is after `now`, otherwise none.
2. **Next wake.** `WAKE_LEAD` is 60 s. Walk the job's runs after `now` in order and return the
   first one whose wake time (run − 60 s) is more than 5 s after `now`. A job that is about to
   run (so the Mac is already awake) therefore gets the wake for its *following* run, and the
   runner — which starts at the run time — always arms the next one.
3. **pmset date.** `MM/dd/yy HH:mm:ss` in local time, zero-padded.
4. **launchd intervals.** Daily: `[{Hour, Minute}]`. Chosen days: one `{Weekday, Hour, Minute}`
   per day (launchd's Weekday also uses 0 = Sunday). Once: `[{Month, Day, Hour, Minute}]`;
   launchd has no year field, so the runner guards against early or yearly firing (§7.2).
5. **Display.** Schedules: `daily 07:30`, `weekdays 07:30`, `weekends 07:30`, `Mon-Thu 07:30`
   (contiguous days), `Mon,Wed,Fri 07:30`, `once 2026-11-06 18:00`. Times in tables: `Fri 06 Nov
   07:30`, in a fixed English format rather than the locale.
6. **DST.** Plain local `Date` arithmetic. A time that doesn't exist on a DST change day rolls
   forward, as JS does. Not special-cased.

## 7. Behaviour

### 7.1 add

1. Resolve the script: it must be a regular file inside `scripts/` (no `..` or absolute-path
   escapes).
2. If it starts with `#!` and isn't executable, `chmod u+x` it and say so. If it doesn't start
   with `#!`, warn that it will run with `/bin/bash`.
3. Parse the schedule, refuse duplicates, create the id.
4. Write the job file and its LaunchAgent, then load the agent. If loading fails, delete both
   and exit 1.
5. Reconcile wake-ups (§7.7), allowing a password prompt.
6. Print the id, schedule, next run and wake time. If the wake couldn't be scheduled, keep the
   job and warn that the Mac won't wake for it. If the sudoers rule isn't active, suggest
   `./wakecron setup`.

### 7.2 run --scheduled (started by launchd)

1. No job file → orphaned agent: note it in `logs/launchd.log`, delete its plist, unload it
   with a detached `launchctl bootout`, exit 0.
2. One-time job, and launchd's calendar (which has no year) fired at the wrong time:
   - `now` is more than 2 minutes before `at` (e.g. `at` is next year): log "not due", exit 0.
   - `now` is more than 24 hours after `at` (the Mac was off at `at`, and launchd matched the
     same date a year later, or the Mac slept for over a day): don't run. Log "skipped: missed
     by more than 24 h", send a notification saying so, then clean up as in step 6.
3. Reconcile wake-ups without prompting. A failure becomes a `[wakecron] warning` line in the
   job log; the run continues.
4. Execute the script (§7.3).
5. Non-zero exit, a signal, or a failure to start → notification "<script> failed (exit N)" with
   title "wakecron".
6. One-time job → delete its job file and plist, reconcile again, then unload itself with
   `launchctl bootout` in a detached process (so it survives launchd stopping this job). Exit.

`run <id>` without `--scheduled` performs only step 4, with output also streamed to the
terminal. No notification, and one-time jobs are not removed. An unknown id exits with 2.

### 7.3 Executing a script

1. Rotate the log if needed and write the start line.
2. If the script file is missing, record a failure with error "script not found" and stop.
3. Spawn it: a file that starts with `#!` is executed directly; anything else runs as
   `/bin/bash <file>`. Working directory `scripts/`. Environment: the runner's own (launchd
   provides `job.env`) plus `WAKECRON_JOB_ID`. stdin ignored; stdout and stderr appended to the
   log, and also echoed to the terminal for manual runs.
4. Keep the Mac awake: spawn `caffeinate -i -s -w <script pid>` and kill it when the script
   ends. (`-w` rather than wrapping the script, so the script's own exit code is kept.)
5. Write the end line and `logs/<id>.last.json`.

### 7.4 remove

Validate the id (unknown id → exit 2), unload the agent (ignore "not loaded"), delete the plist
and the job file, then reconcile wake-ups, which cancels the job's wake unless another job shares
that minute. Logs are kept.

### 7.5 sync

Full: for each job, refresh `node`, `root` and `env` from the current process (your terminal), rewrite the job
file and plist, and reload the agent. Unload and delete `local.wakecron.*.plist` files that have
no job (the login agent excepted). Rewrite the login agent if it is installed. Reconcile with
force. Print a summary.

`--wakes-only` (the login agent): reconcile with force only. Never prompts, never rewrites
agents (launchd's minimal environment would otherwise overwrite the captured PATH).

### 7.6 setup

1. Warn if the folder is inside `~/Desktop`, `~/Documents`, `~/Downloads` or iCloud Drive
   (`~/Library/Mobile Documents`), because macOS privacy rules block background jobs there.
   Suggest `~/wakecron`.
2. Create `scripts/`, `jobs/`, `logs/`, `state/`.
3. Write the rule (§8) to a temp file in `state/`, check it with `sudo visudo -cf <tmp>`,
   install it with `sudo install -m 0440 -o root -g wheel <tmp> /etc/sudoers.d/wakecron_<user>`,
   delete the temp file, and verify with
   `sudo -n -l /usr/bin/pmset schedule wake 01/01/30 00:00:00 wakecron`.
4. Write and load the login agent.
5. Run a full `sync` and print the status.

### 7.7 Wake reconciliation (`lib/wake.js`)

Under the lock:

1. `prev` = the state file's dates minus those already past. `desired` = the set of next-wake
   dates of all jobs (§6.2). Jobs whose wakes fall in the same minute share one event.
2. Cancel every date in `prev` but not in `desired`
   (`pmset schedule cancel wake <date> wakecron`; failures ignored).
3. Schedule every date in `desired` but not in `prev` (`pmset schedule wake <date> wakecron`).
   With `force`, first cancel and then schedule *every* desired date. This guarantees exactly
   one event each and repairs events removed outside wakecron.
4. Save the dates now believed scheduled. Return `{scheduled, cancelled, errors}`.

How pmset is run: `sudo -n` when the rule is active (checked once per process with
`sudo -n -l`). Otherwise, in a terminal, print "Scheduling a wake-up needs admin rights (run
./wakecron setup to stop these prompts)" and use plain `sudo`. Otherwise fail with "passwordless
wake-ups aren't set up — run ./wakecron setup".

The lock is an exclusively created file holding the PID. It is stale if that PID is not alive or
the file is older than 10 minutes. Waiting gives up after 15 s with "another wakecron process is
updating wake-ups — try again".

### 7.8 list

- A jobs table: ID, SCRIPT, SCHEDULE, NEXT RUN, LAST RUN (✓ or ✗ with time, or `never`). A
  one-time job whose time has passed shows `missed` as its next run.
- Warnings that end in "run ./wakecron sync": a job not loaded in launchd (`launchctl print`
  fails), a job whose `node` no longer exists, or whose `root` isn't the current folder.
- The lines of `pmset -g sched` that contain `'wakecron'`.
- Status: passwordless wake-ups ✓/✗, login agent ✓/✗.

### 7.9 uninstall

Cancel every date in the state file, unload and delete every `local.wakecron.*` plist (jobs and
login agent), run `sudo rm -f /etc/sudoers.d/wakecron_<user>`, and clear the state file. It
leaves `scripts/`, `jobs/` and `logs/`, so `setup` restores everything, and prints the folder
path to delete for a full removal.

## 8. Privilege and security

The rule installed by `setup`, where `<user>` is the macOS short user name:

```
<user> ALL = (root) NOPASSWD: \
  /usr/bin/pmset schedule wake [0-9][0-9]/[0-9][0-9]/[0-9][0-9] [0-9][0-9]\:[0-9][0-9]\:[0-9][0-9] wakecron, \
  /usr/bin/pmset schedule cancel wake [0-9][0-9]/[0-9][0-9]/[0-9][0-9] [0-9][0-9]\:[0-9][0-9]\:[0-9][0-9] wakecron
```

- The commands are listed directly rather than through a `Cmnd_Alias`: alias names are global
  across all sudoers files, so a second user running `setup` would otherwise define the same
  alias twice.
- No `*` wildcards. Only these exact command shapes match, so the rule can't change other pmset
  settings, schedule shutdowns, or pass extra arguments. sudo matches the space-joined argument
  string, so splitting the date and time into two arguments also matches; that is harmless
  because the joined text must still be exactly `schedule [cancel] wake <digits> wakecron`.
- Probed during design with real sudo 1.9.15p5 in this container (alias form; the live test in
  §11 re-checks the final direct form): `visudo` accepts the rule; the
  two intended commands run without a password; extra arguments, other owners, no owner,
  `shutdown`, `cancelall`, `repeat`, power settings and letters in the date all require a
  password; `sudo -n -l <command>` exits 0 only for the allowed form.
- Installed `0440 root:wheel` after `visudo` accepts it. The file name is `wakecron_<user>` with
  any character outside `[A-Za-z0-9_-]` replaced by `_` (sudo ignores files whose names contain a
  dot).
- `setup` refuses user names that don't match `^[A-Za-z0-9_][A-Za-z0-9_.-]*$`.

Elsewhere:

- Every external command is an argv array. Nothing goes through a shell.
- Scripts must resolve inside `scripts/`.
- Ids must match `^[a-z0-9][a-z0-9-]{0,40}$` and must not be `sync`.
- Notification text is passed to `osascript` as arguments, never pasted into AppleScript.

## 9. Error handling

- Usage errors: one line plus a hint, exit 2.
- External command failures: show the command, its exit code and stderr.
- An unreadable job file: `list` marks it invalid and continues; `run` and `remove` fail with the
  file path.
- Not macOS: refuse to run anything except `help`, unless `WAKECRON_BIN_DIR` is set (tests only:
  every tool path then points into that folder).
- Node older than 20: refuse, naming the version found.

## 10. macOS limits (README, not code)

- Jobs run only while you're logged in. A locked screen is fine; the FileVault login screen after
  a restart is not.
- A Mac that is shut down isn't powered on. Wake-ups for later runs are re-armed at the next
  login.
- A MacBook with its lid closed and no external display may go straight back to sleep.
- The first time, macOS may show "Background Items Added" (manage it in System Settings → General
  → Login Items & Extensions) and folder-access prompts. Scripts that touch protected folders may
  need Full Disk Access for `node` or `bash`.
- After moving the folder or changing Node (nvm switch, Homebrew upgrade), run `./wakecron sync`.

## 11. Testing (`node --test`, works on Linux and macOS)

- **Unit:** `schedule` (parsing, next run across week, month and year boundaries, wake-lead
  edges, launchd intervals, display), `plist` (escaping, nesting, types), `sudoers` (text, user
  name rules), `jobs` (ids, slugs, script lookup including path escapes).
- **Integration:** the real CLI is copied into a temp folder and run as a child process with
  `HOME` set to a temp dir and `WAKECRON_BIN_DIR` pointing at fake `launchctl`, `pmset`,
  `caffeinate`, `osascript`, `sudo`, `visudo`, `install` and `rm`. The fakes record each call and
  keep minimal state (loaded agents, scheduled wakes), so tests check outcomes: add → list → run
  → remove, scheduled one-time cleanup, failure notification, shared wakes, forced sync, setup,
  uninstall, and the warnings when sudo isn't set up.
- **Prompts:** interactive add, tested in-process with stand-in streams.
- **Live sudoers check:** runs only as root on Linux with `sudo` and `visudo` installed (this
  container). Installs the rule for a temporary user and a stand-in pmset path, then checks with
  real `sudo` that the allowed command lines pass and the others (extra arguments, other owners,
  `cancelall`, power settings, shutdown) are refused.
- **Manual, on the Mac:** the README self-test — `./wakecron add hello.sh +3m`, then
  `pmset sleepnow`, then check `logs/`.

## 12. Delivery

A zip of the project folder sent in this chat. Unzip it to `~/wakecron`, then run
`./wakecron setup`.
