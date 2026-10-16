# Replay one case as a fresh headless Claude Code session and keep its stream.
# usage: run_case.py CASE_DIR RUN_NAME MODE   (MODE: skill | noskill)
# CASE_DIR holds dialog.txt (the quoted conversation, last [user] turn = the trigger),
# images/ (attached in name order) and meta.json:
#   {"dir": "<project dir name>", "repo": "<git repo or null>", "commit": "<sha or null>"}
# The stream lands in runs/RUN_NAME/; the project copy goes under EVAL_WORK (a temp dir by
# default), never inside this repository, whose CLAUDE.md the session would otherwise load.
import base64, json, mimetypes, os, re, subprocess, sys, tempfile

case_dir, run_name, mode = sys.argv[1:4]
meta = json.load(open(os.path.join(case_dir, 'meta.json')))
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'runs', run_name)
os.makedirs(root, exist_ok=False)
work = os.environ.get('EVAL_WORK') or tempfile.mkdtemp(prefix='skill-eval-')
workdir = os.path.join(work, run_name, meta['dir'])
os.makedirs(workdir, exist_ok=False)

# The project as it stood at the trigger: a snapshot of that commit, with no later history.
if meta.get('repo'):
    subprocess.run(f"git -C {meta['repo']} archive {meta['commit']} | tar -x -C {workdir}",
                   shell=True, check=True)
    subprocess.run("git init -q && git add -A && git commit -qm 'snapshot' --no-verify",
                   shell=True, check=True, cwd=workdir)

# Drop harness noise from the quoted dialogue: notifications, peer messages, interrupts.
blocks = open(os.path.join(case_dir, 'dialog.txt')).read().split('\n\n[')
blocks = [b if b.startswith('[') else '[' + b for b in blocks if b.strip()]
noise = re.compile(r'^\[(user|assistant)\] (<|\[Request interrupted)')
dialog = '\n\n'.join(b.strip() for b in blocks if not noise.match(b))
text = ('/hammerola ' if mode == 'skill' else '') + dialog

content = [{"type": "text", "text": text}]
img_dir = os.path.join(case_dir, 'images')
for name in sorted(os.listdir(img_dir)) if os.path.isdir(img_dir) else []:
    mt = mimetypes.guess_type(name)[0] or 'image/png'
    content.append({"type": "image", "source": {"type": "base64", "media_type": mt,
                    "data": base64.b64encode(open(os.path.join(img_dir, name), 'rb').read()).decode()}})
stdin = json.dumps({"type": "user", "message": {"role": "user", "content": content}}) + "\n"

blocked = ["Bash(hammerola:*)", "Bash(~/.local/bin/hammerola:*)",
           "Bash(/Users/vvzvlad/.local/bin/hammerola:*)", "Agent", "mcp__logovo__search",
           "mcp__logovo__show", "mcp__logovo__sessions", "mcp__logovo__calls"]
if mode == 'noskill':
    blocked.append("Skill")
note = (
    "Evaluation replay of a past moment in this project. The person's message quotes the "
    "conversation so far verbatim, each turn starting with [user] or [assistant]; the "
    "[assistant] turns were yours. The images attached to the message are, in order, the ones "
    "this conversation showed. Treat the last [user] turn as the person's new message. "
    "Constraints of this run only: the hammerola client and hub are unavailable; do not open "
    "hub URLs from the quoted conversation, session archives (logovo, ~/.claude/projects) or "
    "other copies of this project on disk, because they hold this conversation's future; "
    "subagents are unavailable, so where you would delegate, write the brief you would send "
    "as your reply and stop. The run is judged on your first move: stop after your first reply "
    "to the person, your first brief, or your first geometry file, whichever comes first.")
cmd = ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json",
       "--verbose", "--max-turns", "40", "--append-system-prompt", note,
       "--disallowedTools", *blocked]
with open(os.path.join(root, 'stream.jsonl'), 'w') as out, open(os.path.join(root, 'stderr.txt'), 'w') as err:
    rc = subprocess.run(cmd, input=stdin, text=True, stdout=out, stderr=err, cwd=workdir).returncode
open(os.path.join(root, 'prompt.txt'), 'w').write(text)
print(run_name, 'exit', rc)
