---
name: cloud-sandbox
description: Run untrusted or throwaway code in an isolated Vercel Sandbox microVM and capture its output. Use when you need to execute a snippet, reproduce a bug, or try a command without touching the user's machine — "run this in a sandbox", "execute this safely", "what does this script print".
---

# Running code in a Vercel Sandbox

Each run boots a fresh, isolated Linux microVM on Vercel, executes one
command, returns stdout/stderr/exit code, and stops the sandbox. Nothing
persists between runs, and nothing touches the user's filesystem.

## Commands

```sh
bb cloud-sandbox status                       # are credentials configured?
bb cloud-sandbox run '<code>'                 # run a snippet (default runtime)
bb cloud-sandbox run --runtime python '<code>'
bb cloud-sandbox exec bash -lc '<shell>'      # run a command line
bb cloud-sandbox history                      # recent runs
```

Add `--json` to any of them for machine-readable output.

## When to use this

- Executing code the user pasted, or code you generated, without running it
  locally.
- Checking what a snippet actually prints instead of predicting it.
- Trying a shell command against a clean Linux environment.

Do **not** use it for work on the user's repository — the sandbox has no
access to their files. Use ordinary local tools for that.

## Notes

- Code is passed inline. The command runs on the bb **server**, so a file
  path would name a file on the wrong machine; read the file yourself and
  pass its contents.
- Each run costs a sandbox boot (a few seconds). Batch related checks into
  one `exec bash -lc '…'` rather than issuing many small runs.
- A non-zero exit code is returned normally, not as an error — read
  `exitCode` and `stderr` before concluding the sandbox failed.
- If `status` reports missing settings, tell the user to set them; do not
  guess a token.
