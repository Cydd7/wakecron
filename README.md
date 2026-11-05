# wakecron

Wake your Mac from sleep and run your scripts on a schedule.

Put scripts in `scripts/`, then tell wakecron when to run them:

```bash
./wakecron add backup.sh 07:30
```

At 07:29 the Mac wakes up. At 07:30 `backup.sh` runs, and the Mac stays awake until the
script finishes, then goes back to sleep on its usual timer. If the Mac slept through the time
anyway, the script runs as soon as the Mac wakes.

## Requirements

- macOS
- Node.js 20 or newer. Check with `node --version`; install it with `brew install node` or from
  [nodejs.org](https://nodejs.org).

## Install

1. Unzip the folder to `~/wakecron`. Don't put it in Desktop, Documents, Downloads or iCloud
   Drive: macOS privacy rules stop background jobs from reading those folders.
2. Run the one-time setup. It asks for your password once:

   ```bash
   cd ~/wakecron
   ./wakecron setup
   ```

   Setup lets wakecron schedule wake-ups without asking for your password each time. It also adds
   a small login item that re-arms wake-ups whenever you log in.

macOS may then show a **Background Items Added** notification for `node`. That's wakecron; leave
it allowed in System Settings → General → Login Items & Extensions.

## Three-minute self-test

```bash
./wakecron add hello.sh +3m     # run the example script once, three minutes from now
pmset -g sched                  # should list a wake-up "by 'wakecron'"
pmset sleepnow                  # or Apple menu → Sleep
```

About two minutes later the Mac wakes up, and `hello.sh` runs a minute after that. You'll see
a "hello.sh ran" notification. Then check:

```bash
./wakecron list                 # one-time jobs remove themselves after running
cat logs/hello-*.log            # the script's output, with start and end lines
```

## Commands

| Command | What it does |
|---|---|
| `./wakecron setup` | One-time setup. Safe to run again. |
| `./wakecron add [script] [time] [--days D]` | Schedule a script from `scripts/`. Run it without arguments to be asked step by step. |
| `./wakecron list` | Jobs, next runs, last results, pending wake-ups and setup status. Also what plain `./wakecron` shows. |
| `./wakecron run <id>` | Run a job now and see its output. Doesn't change its schedule. |
| `./wakecron remove <id>` | Delete a job (alias `rm`). Its log is kept. |
| `./wakecron sync` | Repair everything, for example after moving this folder or changing Node. |
| `./wakecron uninstall` | Remove the background jobs, wake-ups and sudo rule. Leaves this folder alone. |

Job ids look like `backup-0730`: the script name plus the time.

### Times

| You type | Meaning |
|---|---|
| `07:30`, `7:30pm`, `7pm`, `12am` | Every day at that time, or on the days you choose with `--days` |
| `2026-11-06 18:00` or `2026-11-06 6pm` | Once, at that date and time |
| `+10m`, `+2h` | Once, that long from now |

### Days (`--days` or `-d`)

`daily` (the default), `weekdays`, `weekends`, or a list of day names and ranges such as
`mon,wed,fri`, `mon-fri` or `fri-mon`.

```bash
./wakecron add report.js 18:00 --days mon-fri
./wakecron add cleanup.sh 2026-12-24 09:00
./wakecron add                  # asks which script, when, and which days
```

## Writing scripts

- Any language works. Start the file with a `#!` line, such as `#!/bin/bash`,
  `#!/usr/bin/env python3` or `#!/usr/bin/env node`. A script without one runs with
  `/bin/bash`. wakecron makes `#!` scripts executable for you.
- Scripts run from inside `scripts/`, so relative paths start there.
- Scripts get the PATH your terminal had the last time you ran `add` or `sync`, plus the
  Homebrew folders, so `git`, `brew` and friends work as usual. `WAKECRON_JOB_ID` holds the job id.
- A non-zero exit code shows a macOS notification and is marked ✗ in `./wakecron list`.
- Output is captured until every process that holds it exits. If a script starts something that
  keeps running, detach it: `long-task >/dev/null 2>&1 &`.

## Logs

- `logs/<id>.log` — each run's output, between `=== … start …` and `=== … exit N …` lines. When it
  passes 1 MB it moves to `<id>.log.1`.
- `logs/launchd.log` — problems with wakecron itself (rarely written).

## How it works

- Each job is a macOS LaunchAgent (`~/Library/LaunchAgents/local.wakecron.<id>.plist`) that
  launchd starts at the job's time. If the Mac slept through that time, launchd starts it on wake.
- One minute before each run, a `pmset` wake-up wakes the Mac. Each run schedules the next
  wake-up before running the script, so a failing script can't break the schedule.
- While the script runs, `caffeinate` keeps the Mac from sleeping.
- `setup` installs `/etc/sudoers.d/wakecron_<you>`. It allows exactly two commands without a
  password, `pmset schedule wake <date> wakecron` and `pmset schedule cancel wake <date> wakecron`,
  and nothing else.
- The login item runs `./wakecron sync --wakes-only` at each login. That re-arms wake-ups missed
  while the Mac was shut down.

## Limits and troubleshooting

- **Jobs run only while you're logged in.** A locked screen is fine. The FileVault login screen
  after a restart is not; log in once and the next runs happen as normal.
- **A shut-down Mac isn't turned on.** wakecron wakes a sleeping Mac. Runs missed while it was
  off are skipped. A one-time job that is more than 24 hours late is skipped and removed, and you
  get a notification.
- **MacBooks with the lid closed** and no external display may go straight back to sleep. Keep the
  lid open, or use an external display and power.
- **"Operation not permitted"** in a log means macOS privacy rules blocked the script. Give Full
  Disk Access to the program named in the error, often `node` or `bash`, in System Settings →
  Privacy & Security.
- **Moved this folder, or switched Node versions** (nvm, a Homebrew upgrade)? Run
  `./wakecron sync`. `./wakecron list` tells you when it's needed.
- **Nothing happened?** Check `./wakecron list` for ✗ and `!` lines, then `logs/`, then
  `pmset -g sched`, which should list wake-ups `by 'wakecron'`.

## Uninstall

```bash
./wakecron uninstall
```

Then delete this folder.

## Development

```bash
npm test
```

The tests run on macOS and Linux and never touch your real launchd, pmset or sudo.
`WAKECRON_BIN_DIR` points wakecron at the stand-in tools in `tests/fakes/`; it is for tests only.
One test checks the sudoers rule against real `sudo`; it runs only as root on Linux, for example
in a CI container, and is skipped everywhere else.

The design and the implementation plan are in `docs/superpowers/`.
