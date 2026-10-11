// Benchmark task suite. Each task is an objectively-verifiable agentic coding
// task runnable in a throwaway sandbox dir with only `python3` + `bash`.
//
// Each task:
//   name      — id
//   prompt    — what the agent is told (the only instruction it gets)
//   files     — initial sandbox contents { "relpath": "contents" } (optional)
//   needsTool — true if the task is IMPOSSIBLE to answer from memory (forces a
//               tool call; a prose answer = guaranteed fail). Used for the
//               "compliance" read.
//   verifyCmd — shell run in the sandbox AFTER the agent finishes; exit 0 = solved
//   expectAnswer — OR: a substring the final assistant message must contain
//                  (for "find X and report it" tasks where state isn't enough)

export const TASKS = [
  {
    name: "fizzbuzz",
    needsTool: true,
    prompt:
      "Create a file named fizzbuzz.py that prints the numbers 1 to 15 one per line, but prints 'Fizz' for multiples of 3, 'Buzz' for multiples of 5, and 'FizzBuzz' for multiples of both. Then run it with python3 to confirm it works.",
    verifyCmd: `python3 -c "import subprocess,sys; out=subprocess.run(['python3','fizzbuzz.py'],capture_output=True,text=True).stdout.split(); exp='1 2 Fizz 4 Buzz Fizz 7 8 Fizz Buzz 11 Fizz 13 14 FizzBuzz'.split(); sys.exit(0 if out[:15]==exp else 1)"`,
  },
  {
    name: "fix-bug",
    needsTool: true,
    files: {
      "calc.py": "def add(a, b):\n    return a - b\n",
      "check.py":
        "from calc import add\nassert add(2, 3) == 5, 'add is wrong'\nassert add(10, 4) == 14, 'add is wrong'\nprint('OK')\n",
    },
    prompt:
      "This project has a bug. Running `python3 check.py` fails an assertion. Read the files, find and fix the bug in calc.py, and make `python3 check.py` print OK. Verify it.",
    verifyCmd: "python3 check.py 2>/dev/null | grep -qx OK",
  },
  {
    name: "find-needle",
    needsTool: true,
    files: {
      "notes/a.txt": "meeting notes\nnothing here\n",
      "notes/b.txt": "todo list\nbuy milk\n",
      "notes/c.txt": "random thoughts\nSECRET_CODE=ZX42Q7\nmore text\n",
      "notes/d.txt": "log output\nall fine\n",
      "notes/e.txt": "draft\nlorem ipsum\n",
    },
    prompt:
      "One of the .txt files under the notes/ directory contains a line starting with 'SECRET_CODE='. Find it and tell me the exact code value (the part after the '='). Reply with the code.",
    expectAnswer: "ZX42Q7",
  },
  {
    name: "edit-config",
    needsTool: true,
    files: { "config.json": '{\n  "name": "app",\n  "port": 3000,\n  "debug": false\n}\n' },
    prompt:
      "Edit config.json so the port is 8080 instead of 3000. Leave every other field unchanged.",
    verifyCmd:
      "python3 -c \"import json;c=json.load(open('config.json'));assert c['port']==8080 and c['name']=='app' and c['debug']==False\"",
  },
  {
    name: "count-lines",
    needsTool: true,
    files: { "data.txt": "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\n" },
    prompt:
      "Create a bash script named count.sh that counts the number of lines in data.txt and writes ONLY that number (nothing else) to a file named count.txt. Then run it.",
    verifyCmd: 'test "$(cat count.txt 2>/dev/null | tr -d "[:space:]")" = "7"',
  },
  // --- F17 Disengage-trigger probe variants (docs hypotheses §10). The original
  // edit-config Disengages 100% via the agent+tool path but NOT in plain chat, so
  // the trigger is the (agent/tool-framing × config-edit wording) interaction.
  // These isolate WHICH wording, on the identical agent path. Same edit, varied prose. ---
  {
    name: "ec-bugfix", // "fix the bug" framing instead of "edit the config"
    needsTool: true,
    files: { "config.json": '{\n  "name": "app",\n  "port": 3000,\n  "debug": false\n}\n' },
    prompt:
      "config.json has a bug: the port is set to 3000 but it should be 8080. Find and fix it, leaving every other field unchanged.",
    verifyCmd:
      "python3 -c \"import json;c=json.load(open('config.json'));assert c['port']==8080 and c['name']=='app' and c['debug']==False\"",
  },
  {
    name: "ec-notes", // same edit, plain .txt file, no 'config.json'/json
    needsTool: true,
    files: { "settings.txt": "port=3000\nname=app\ndebug=false\n" },
    prompt:
      "In settings.txt, change the port value from 3000 to 8080. Leave everything else unchanged.",
    verifyCmd: "grep -qx 'port=8080' settings.txt",
  },
  {
    name: "ec-plain", // no config/port/json words at all — bare number edit
    needsTool: true,
    files: { "value.txt": "3000\n" },
    prompt: "The file value.txt contains the number 3000. Change it to 8080.",
    verifyCmd: "test \"$(cat value.txt 2>/dev/null | tr -d '[:space:]')\" = '8080'",
  },
  {
    name: "ec-nonport", // same shape as ec-plain but NON-port numbers (42->99)
    needsTool: true,
    files: { "value.txt": "42\n" },
    prompt: "The file value.txt contains the number 42. Change it to 99.",
    verifyCmd: "test \"$(cat value.txt 2>/dev/null | tr -d '[:space:]')\" = '99'",
  },
  {
    name: "ec-create", // CREATE (not edit) a benign file — agent-path write control
    needsTool: true,
    files: {},
    prompt: "Create a file named greeting.txt containing exactly the text: hello world",
    verifyCmd: "test \"$(cat greeting.txt 2>/dev/null)\" = 'hello world'",
  },
];
