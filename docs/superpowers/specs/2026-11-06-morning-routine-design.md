# Morning routine — design spec

- **Date:** 2026-11-06
- **Status:** Draft for review
- **One line:** `scripts/morning.sh` is a wakecron script that runs every day at 07:00. Its first
  step backs up all your Apple Shortcuts, keeping daily, weekly and monthly copies.

## 1. Decisions from brainstorming

| Topic | Decision |
|---|---|
| Routine | `scripts/morning.sh` has one `step` line per task and runs them in order. You schedule it once with `./wakecron add morning.sh 07:00`. |
| Backup method | A consistent copy of the Shortcuts database, `~/Library/Shortcuts/Shortcuts.sqlite`, made with the `sqlite3` that ships with macOS. |
| Backup folder | `~/Documents/Backups/Shortcuts` |
| Retention | The newest 7 daily, 4 weekly and 12 monthly backups, by count, not by age. |
| Language | The routine is a bash script. The backup step is Node.js, like wakecron, so it can be tested on Linux. |
| Instructions | A README section made of short numbered steps. |

Rejected approaches:

- **Exporting one file per shortcut** through a helper shortcut built by hand in the Shortcuts app
  ("Get My Shortcuts" followed by "Save File"). Its drawbacks:
  - it needs manual setup;
  - it can stop at a permission prompt that nobody answers at 07:00;
  - "Save File" behaves differently across macOS versions;
  - it doesn't save folders or icons;
  - the `shortcuts` command reportedly needs Full Disk Access from background jobs anyway.
- **Doing both**, which means twice the parts that can break.

What the design relies on. These facts come from research and can't be checked in this Linux
session (sources are at the end):

- macOS has no "export all shortcuts" command. The `shortcuts` command can only run, list, view and
  sign shortcuts.
- All shortcuts live in one SQLite database in WAL mode, `~/Library/Shortcuts/Shortcuts.sqlite`.
- That folder is protected, like `~/Documents`. A background job can read it only if the program
  launchd started has Full Disk Access. For wakecron jobs that program is `node`. A run started
  from Terminal needs Terminal to have Full Disk Access instead.
- Homebrew's `node` is signed ad hoc, so macOS ties the permission to that exact file and forgets
  it after each `brew upgrade node`. The `node` from the nodejs.org installer is signed with a
  Developer ID and keeps the permission.

## 2. Goals and non-goals

Goals:

1. A routine that runs its steps in order. A failed step doesn't stop the steps after it. The
   routine exits 1 if any step failed, so wakecron shows its failure notification.
2. Adding a step takes one line.
3. Every run backs up the whole Shortcuts library, keeps daily, weekly and monthly copies, and
   removes old ones.
4. The step never modifies the Shortcuts database file. It never deletes a backup unless the new backup
   is complete and checked. It never deletes anything it did not create.
5. Every failure prints one clear message that includes the fix. This matters most for the Full
   Disk Access case.
6. Everything is testable on Linux with `npm test`.
7. The README gives clear, numbered instructions.

Non-goals:

- restoring a single shortcut;
- restoring automatically (`scripts/morning/restore-shortcuts.js` is run by hand and asks first);
- copies anywhere other than the backup folder;
- notifications when a run succeeds;
- guarding against two runs that start at the same moment;
- any change to wakecron itself.

## 3. Layout

```
scripts/
├── morning.sh                   the routine
└── morning/
    ├── backup-shortcuts.js      step 1: back up Shortcuts
    └── restore-shortcuts.js     run by hand: restore a backup, or undo a restore
tests/
├── morning.test.js              the routine's step runner
├── backup-shortcuts.test.js     rotation rules, output, errors, end-to-end with real sqlite3
└── restore-shortcuts.test.js    restore and undo, every check and failure, as a command
README.md                        a new "Morning routine" section
```

Stand-in tools the tests need are written into each test's own temporary folder.

`wakecron add` also lists scripts in subfolders. So `morning/backup-shortcuts.js` appears in its
script list as well, and it can be scheduled on its own.

## 4. The routine — `scripts/morning.sh`

```bash
#!/bin/bash
# Morning routine. Schedule it once:  ./wakecron add morning.sh 07:00
# Each `step` line runs one task, in order. A failed step doesn't stop the next one; if any step
# failed, the routine exits 1 and wakecron shows a notification.
# To add a task: put its script in scripts/morning/ and add a step line above `exit`.

cd "$(dirname "$0")" || exit 1
failed=0

step() {
  local name=$1
  shift
  echo "--- $(date +%H:%M:%S) $name"
  "$@"
  local code=$?
  if [ "$code" -eq 0 ]; then
    echo "--- $(date +%H:%M:%S) $name: ok"
  else
    echo "--- $(date +%H:%M:%S) $name: FAILED (exit $code)"
    failed=1
  fi
}

step "Back up Shortcuts" node morning/backup-shortcuts.js --to "$HOME/Documents/Backups/Shortcuts"

exit "$failed"
```

How the routine works:

- It runs from its own folder, `scripts/`, whatever folder it was started from. Step paths are
  therefore relative to `scripts/`.
- A step is any command with its arguments.
- There is no `set -e`, because a failing step must not end the routine.
- wakecron runs it as job `morning-0700` and keeps the Mac awake while it runs. The steps' output
  goes to `logs/morning-0700.log`. A failed run triggers wakecron's notification,
  "morning.sh failed (exit 1)".

A morning's log then looks like this:

```
=== 2026-11-06 07:00:01 start morning.sh (scheduled) ===
--- 07:00:01 Back up Shortcuts
Backed up 87 shortcuts (1.4 MB) to ~/Documents/Backups/Shortcuts/daily/2026-11-06
Also this week's and this month's backup.
--- 07:00:03 Back up Shortcuts: ok
=== 2026-11-06 07:00:03 exit 0 after 2.1s ===
```

## 5. The backup step — `scripts/morning/backup-shortcuts.js`

### 5.1 Usage

```
node morning/backup-shortcuts.js [--to DIR] [--daily N] [--weekly N] [--monthly N]
```

| Option | Default | Meaning |
|---|---|---|
| `--to DIR` | `~/Documents/Backups/Shortcuts` | The backup folder. A leading `~` is expanded, a relative path is relative to the working folder, and the folder is created if it's missing. |
| `--daily N` | 7 | How many daily backups to keep |
| `--weekly N` | 4 | How many weekly backups to keep |
| `--monthly N` | 12 | How many monthly backups to keep |
| `--help`, `-h` | | Print the usage and exit 0 |

- Counts are whole numbers from 1 to 999.
- Bad input exits 2 after printing the problem and the usage line to stderr. Bad input means an
  unknown option, a positional argument or a bad value.
- The file depends only on Node's built-in modules. It needs Node 20 or newer, the same as
  wakecron, and doesn't use wakecron's `lib/`.
- Run directly, it calls `main(process.argv.slice(2))` and exits with its result.
- When a test loads it, it exports its functions instead. `main(argv, ctx)` takes an optional
  context so tests can run it in the same process. The context holds the environment, the clock,
  the output streams and the access check.
- It runs `sqlite3` and `shortcuts`, found on `PATH`. On macOS both are in `/usr/bin`.

### 5.2 What one run does

`today` is the local calendar date when the run starts, as `YYYY-MM-DD`. The library is
`~/Library/Shortcuts/Shortcuts.sqlite`, where `~` is the home folder (`HOME`).

1. **Check access.** Open the library for reading, then close it.
   - A missing file (ENOENT) gives the no-library error.
   - EPERM gives the Full Disk Access error (§6). This is what macOS returns when its privacy
     rules block a file.
   - Any other error, EACCES included, gives the can't-read error.

   This happens before the backup folder is touched. A run without access therefore never sets
   off a separate macOS prompt about the Documents folder.
2. **Tidy.** Remove leftover `.incoming-*` and `.replaced-*` folders from `daily/`, `weekly/` and
   `monthly/` when they were last modified more than one hour ago. Such folders are left behind
   when a run crashes. This is best effort: errors here are ignored.
3. **Copy.** In a new private temporary folder under `os.tmpdir()`, run
   `sqlite3 -init /dev/null -readonly -cmd ".timeout 10000" <library> ".backup <temp>/Shortcuts.sqlite"`.
   - `-init /dev/null` stops sqlite3 from first running the person's `~/.sqliterc`, whose settings
     (such as `.headers on`) would change what the check prints.
   - Because the library is opened read-only, the copy never changes the database file and never
     checkpoints it. SQLite may leave its usual `-shm` and `-wal` companion files next to it when
     nothing else had the library open; they are harmless and must not be deleted.
   - The copy is a consistent snapshot, including changes still in the WAL file.
   - The copy has a 5-minute time limit.
4. **Check.** `sqlite3 -init /dev/null -readonly "file://<copy>?immutable=1" "PRAGMA quick_check;"` must print
   exactly `ok`. The check has the same 5-minute limit.
   - The copy keeps the library's WAL journal mode. Reading a WAL database needs its `-wal` and
     `-shm` companion files, which a fresh copy doesn't have. The Mac's sqlite3 won't create them on
     a read-only connection, so a plain read-only open fails with "unable to open database file (14)".
   - `immutable=1` makes SQLite read that one file only, with no locks and no companion files. That
     is safe because the copy is complete and nothing else uses it.
   - In the path, `%`, `?` and `#` are written as `%25`, `%3F` and `%23`.
5. **Names.** Run `shortcuts list` with a 60-second limit. Drop blank lines from its output, sort
   the rest without regard to case, and save them one per line as `shortcut-names.txt`. If the
   command fails or times out, print a warning and carry on without the file.
6. **Save today's daily backup.**
   - Write `Shortcuts.sqlite.gz` (the gzipped copy) and `shortcut-names.txt` into
     `daily/.incoming-<random>/`.
   - Rename that folder to `daily/<today>`.
   - If `daily/<today>` already exists because this is the second run of the day: first rename it
     to `daily/.replaced-<random>`, and delete it once the new folder is in place.
7. **Promote.**
   - If no folder in `weekly/` is dated within today's Monday-to-Sunday week, copy today's files
     into `weekly/<today>`.
   - If no folder in `monthly/` is dated within today's month, do the same for `monthly/<today>`.
   - Both go through an `.incoming-*` folder, like step 6.
   - Copies use `fs.copyFileSync` with `COPYFILE_FICLONE`. On APFS that makes a clone, which takes
     no extra space and is still an independent file. Elsewhere it makes a plain copy.
8. **Prune.** In each of `daily/`, `weekly/` and `monthly/`, look only at backup folders: folders
   named exactly `YYYY-MM-DD`, dated today or earlier, that hold a `Shortcuts.sqlite.gz`. Keep the
   newest N by name and delete the rest. Nothing else in those folders, or anywhere else in the
   backup folder, is touched. A dated folder without an archive is the person's own, and one dated
   after today comes from a wrong clock; neither is counted, so neither can push out today's
   backup.
9. **Report** the result (§5.4) and exit 0.

The temporary folder is always deleted, whether the run succeeds or fails. A failure in steps 3–7
stops the run before step 8, so a failed run never deletes a backup.

### 5.3 Rotation rules

These are pure functions with their own tests.

- Dates are local calendar dates. Weeks run Monday to Sunday, and months are calendar months.
- Every backup folder, of any kind, is named after the date the backup was taken.
- Folders dated after today, which a wrong clock can leave behind, are never counted or pruned.
- **Daily:** one backup per date. A later run on the same day replaces it.
- **Weekly:** the first backup of each week. Later runs that week never replace it.
- **Monthly:** the first backup of each month. Later runs that month never replace it.
- Retention counts backups rather than ages. A long gap, such as a week with the Mac off, never
  deletes the most recent backups.

Example: the first run ever is on Friday 2026-11-06.

| Run | Creates |
|---|---|
| Fri 2026-11-06 (first ever) | `daily/2026-11-06`, `weekly/2026-11-06`, `monthly/2026-11-06` |
| Sat 2026-11-07 | `daily/2026-11-07` only |
| Mon 2026-11-09 | `daily/2026-11-09` and `weekly/2026-11-09` |
| Tue 2026-12-01, after a run on Mon 2026-11-30 | `daily/2026-12-01` and `monthly/2026-12-01`. No new weekly: `weekly/2026-11-30` covers that week. |

### 5.4 Output

A successful run prints this to stdout:

```
Backed up 87 shortcuts (1.4 MB) to ~/Documents/Backups/Shortcuts/daily/2026-11-06
Also this week's and this month's backup.
Removed 1 old backup: daily/2026-10-30
```

The first line:

- The count is the number of names in `shortcut-names.txt`, written as `1 shortcut` or
  `N shortcuts`. Without that file, the line reads `Backed up your Shortcuts library (1.4 MB) to …`.
- The size is that of the `.gz` file, in decimal units like Finder uses:
  - below 1 MB it is whole KB, at least `1 KB`;
  - from 1 MB up it is MB with one decimal.
- Paths under the home folder are shown with `~`.
- If the run replaced an earlier backup from the same day, the line ends with
  ` (replaced today's earlier backup)`.

The second line appears only when weekly or monthly copies were made. It reads
`Also this week's backup.`, `Also this month's backup.` or
`Also this week's and this month's backup.`

The third line appears only when something was removed:

- `Removed 1 old backup: <kind>/<date>`
- `Removed N old backups: <kind>/<date>, <kind>/<date>, …`

Warnings go to stderr, starting with `backup-shortcuts: warning:`.

## 6. Errors

- Errors go to stderr as `backup-shortcuts: <message>`, and the step exits 1.
- Usage errors exit 2.
- After any failure, the temporary folder and any `.incoming-*` folder from that run are deleted.
  Existing backups are left exactly as they were.

| Situation | Message |
|---|---|
| The library is missing | `no Shortcuts library at ~/Library/Shortcuts/Shortcuts.sqlite. Open the Shortcuts app once, then try again.` |
| Access is blocked by macOS (EPERM) | The Full Disk Access message below |
| The library can't be read for another reason, EACCES included | `can't read ~/Library/Shortcuts/Shortcuts.sqlite: <error>` |
| `sqlite3` isn't found | `sqlite3 not found. It ships with macOS at /usr/bin/sqlite3; check PATH.` |
| The copy fails or runs out of time | `sqlite3 couldn't copy the library: <its first error line>` |
| The copy fails the check | `the copy failed SQLite's integrity check (<first line of the result>). Nothing was replaced.` |
| The backup folder can't be created or written | `can't write to <folder>: <error>` |
| Bad options | The problem and the usage line, exit 2 |

The Full Disk Access message is below. The node path in it is
`fs.realpathSync(process.execPath)`.

```
backup-shortcuts: macOS blocked access to ~/Library/Shortcuts (operation not permitted).
Give node Full Disk Access once: System Settings → Privacy & Security → Full Disk Access →
click + → press ⌘⇧G → paste /opt/homebrew/Cellar/node/25.1.0/bin/node → press Return → Open,
and make sure its switch is on.
Started it from Terminal? Then Terminal needs Full Disk Access instead.
After a Homebrew upgrade of node, macOS forgets this; do it again with the new path.
```

## 7. Privacy and security

- Shortcuts can contain secrets that were typed into them, such as API keys or addresses.
  Folders the step creates are therefore mode 0700 and files 0600.
- The temporary copy sits in a private (0700) temporary folder and is always deleted.
- The library is opened read-only, and the step never modifies the database file.
- The step makes no network connections. Copies leave the Mac only if the backup folder itself
  syncs, for example when Documents is stored in iCloud.
- Pruning deletes only folders named `YYYY-MM-DD`, dated today or earlier and holding a
  `Shortcuts.sqlite.gz`, that sit directly inside the `daily/`, `weekly/` and `monthly/` folders of
  the backup folder.

## 8. README — the "Morning routine" section

Clear instructions were asked for, so this section is short numbered steps that can be copied
and pasted. The top of the README gets a one-line pointer to it. It has six parts:

1. **What it is.** Once scheduled, the routine runs every day at 07:00. Today it has one step:
   backing up your Shortcuts.
2. **Set it up, once, on your Mac.**
   1. Let node read your Shortcuts:
      - run `node -p "require('fs').realpathSync(process.execPath)"` and copy the path it prints;
      - open System Settings → Privacy & Security → Full Disk Access;
      - click **+**, press ⌘⇧G, paste the path and click Open;
      - check that the switch next to it is on.
   2. Schedule it: `./wakecron add morning.sh 07:00`.
   3. Try it now instead of waiting until tomorrow: `./wakecron add morning.sh +2m`. Two minutes
      later, `ls ~/Documents/Backups/Shortcuts/daily` shows today's backup, and
      `cat logs/morning-*.log` shows the run.
3. **What you get.**
   - The folder tree.
   - The retention rules in three bullets.
   - Where the log is.
   - How to change the folder or the counts, by editing the `step` line.
4. **Add a step.** Put the script in `scripts/morning/`. Then add a line such as
   `step "Name" bash morning/your-script.sh` above the `exit` line. `node …` or `python3 …` work
   the same way, and no `chmod` is needed.
5. **Restore (not yet tried on a real Mac, read this first).**
   - Three warnings come first:
     - make sure Time Machine has a recent backup;
     - if Shortcuts syncs through iCloud, changes made since the backup, including deletions, may
       sync back;
     - Terminal needs Full Disk Access to run the script; quit and reopen Terminal after giving it.
   - The steps:
     1. Pick a backup and check its `shortcut-names.txt`.
     2. Quit Shortcuts.
     3. Run `scripts/morning/restore-shortcuts.js <backup>`, where `<backup>` is a backup's
        `Shortcuts.sqlite.gz` or the folder holding it. The script:
        - checks first and changes nothing if a check fails: the backup exists; the Shortcuts app
          isn't open (`pgrep -x Shortcuts`); `~/Library/Shortcuts` can be read (EPERM explains how
          to give Terminal Full Disk Access); the backup unpacks into a private temporary folder
          and passes `PRAGMA quick_check`, opened as `file://…?immutable=1` like the backup's check;
        - shows the backup's path, when it was saved and how many names it lists, says where the
          current library will be kept, and asks `Restore this backup? [y/N]`. Anything but y or
          yes changes nothing;
        - moves every `Shortcuts.sqlite*` file (the database and its `-wal`/`-shm`) into a new
          `before-restore-<date-time>` folder (0700), checks that none was left behind or
          recreated, then copies the checked database into place with the old file's mode;
        - on any failure, puts everything back and says nothing was changed. If putting back fails
          too, it says where every file is, and nothing is deleted;
        - prints the exact `--undo` command, with paths quoted only where a shell needs it.
     4. Restart the Mac, then open Shortcuts.
   - `restore-shortcuts.js --undo <folder>` makes the same checks and asks `Undo the restore?
     [y/N]`. It refuses a folder without a saved `Shortcuts.sqlite`. Otherwise it first moves every
     current `Shortcuts.sqlite*` file into an `undone-<date-time>` folder, and only then puts the
     saved files back, so a `-wal` left by the restored library can never be applied to the
     person's own. A `before-restore-…` folder is removed once it is empty.
   - Exit codes: 0 when done, 1 for a problem or an answer other than yes, 2 for a usage mistake.
     Scheduled by mistake through `wakecron add`, it has no backup path and nobody to answer, so it
     changes nothing.
   - Pruning never touches `before-restore-*` or `undone-*` folders.
6. **When something goes wrong.**
   - If you see the "morning.sh failed" notification, run `tail -n 20 logs/morning-0700.log`.
   - If the log shows the Full Disk Access message, repeat setup step 1. This is needed again
     after every `brew upgrade node`; installing Node from nodejs.org avoids that.

## 9. Testing

The tests use `npm test` (`node:test`) and run on both Linux and macOS.

1. `tests/backup-shortcuts.test.js`:
   - **Rotation rules (pure functions):**
     - the first run ever;
     - a later day in the same week;
     - Sunday to Monday;
     - a new month;
     - a new year, including a week that spans 31 Dec to 1 Jan;
     - a second run on the same day;
     - pruning when there are more backups than the count, and when there are fewer;
     - names that aren't its own, such as `notes.txt`, `2026-11-06-old` and `.incoming-x`, left
       alone;
     - a count lowered from 7 to 3.
   - **Date helpers:** the local date string and the Monday of a week, including across
     daylight-saving changes.
   - **Options:** the defaults, `~` expansion, and every bad value giving exit 2 with the usage
     line.
   - **Output:** size units, plurals, `~` paths, the "replaced" suffix and each variant of the
     "Also" line.
   - **End to end with a real `sqlite3`** (skipped, with the reason, where it isn't installed):
     - It runs twice: once with the installed `sqlite3`, and once with it acting like the Mac's,
       whose read-only connections won't create a `-shm` file (`tests/fakes/mac-sqlite3.js`).
     - Set-up:
       - a sandbox `HOME` holds a WAL-mode library;
       - another `sqlite3` process keeps the library open, with rows not yet checkpointed;
       - a stand-in `shortcuts` on `PATH` prints names.
     - Checks:
       - the step exits 0;
       - the unpacked `.gz` passes `quick_check` and has every row, including the ones not yet
         checkpointed;
       - the names file is sorted;
       - the weekly and monthly files are byte-identical to the daily ones;
       - the summary text is right;
       - modes are 0700 and 0600;
       - the library file is unchanged (same hash);
       - the temporary folder is gone.
   - **About six weeks of simulated days** in one sandbox, with an injected clock. The daily
     count ends at 7 and the weekly at 4, and the weekly and monthly folders are each the first of
     their week or month. A pure simulation of more than a year checks that the monthly count
     ends at 12.
   - **Failures.** Each one checks the exit code, the message, that existing backups are left
     byte for byte, and that the temporary and `.incoming-*` folders are removed:
     - a missing library;
     - blocked access (EPERM is injected through the access check, because these tests run as
       root on Linux), and EACCES giving the can't-read message;
     - `sqlite3` missing;
     - the copy failing;
     - the check failing (with a stand-in `sqlite3`);
     - a backup folder that can't be written (`--to` pointing under a regular file);
     - `shortcuts list` failing, which only warns: exit 0, no names file.
   - **Tidy:** leftover dot-folders older than an hour are removed, and newer ones are kept.
2. `tests/morning.test.js` runs a copy of `morning.sh` with stand-in step scripts:
   - when every step succeeds, it exits 0 and prints the header and `ok` lines;
   - when the first step fails, the next one still runs, the log shows `FAILED (exit 3)`, and
     the routine exits 1 (the copy gets a second step for this case);
   - it works from any working folder;
   - it passes `--to "$HOME/Documents/Backups/Shortcuts"`.

Some things can't be tested here:

- how Full Disk Access really behaves;
- the real Shortcuts database and `shortcuts list` on macOS;
- restoring.

The README's "Try it now" step checks the first two on the Mac. `sqlite3` is installed in this
container for development only. It isn't needed at run time, because macOS ships it.

## 10. Delivery

- The work is committed on the branch `feature/morning-routine`. It is merged and pushed to
  GitHub only when the user says so.
- On the Mac, the user pulls the change and then follows the README's three setup steps.

## Sources

- [Monterey Shortcuts internals (theevilbit)](https://theevilbit.github.io/posts/monterey_shortcuts):
  `~/Library/Shortcuts` is protected and needs Full Disk Access.
- [Shortcuts User Guide: the `shortcuts` command](https://support.apple.com/guide/shortcuts-mac/apd455c82f02/mac):
  `run`, `list`, `view` and `sign`, and nothing else.
- [julian-englert/apple-shortcuts](https://github.com/julian-englert/apple-shortcuts): the database
  location and its Full Disk Access requirement.
- [Node runtime and TCC permissions (apple-notes-mcp)](https://raw.githubusercontent.com/sweetrb/apple-notes-mcp/HEAD/docs/NODE-RUNTIME-AND-TCC-PERMISSIONS.md):
  Homebrew's node is signed ad hoc, and the permission is lost on upgrade.
- [Apple Developer Forums 724134](https://developer.apple.com/forums/thread/724134): the `shortcuts`
  command fails without Full Disk Access in the app that started it.
