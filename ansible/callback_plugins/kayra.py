# kayra's Ansible output, under the step kayra shows for the playbook: what
# changed (with its diff when asked), what failed and why, what a debug task
# says, and a recap. ok and skipped tasks are counted, not listed. On a
# terminal the task at work is one line, redrawn with a spinner and its time.
#
# ANSIBLE_STDOUT_CALLBACK=default brings back Ansible's own output.
from __future__ import annotations

DOCUMENTATION = """
    name: kayra
    type: stdout
    short_description: what changed, what failed, and the task at work
    description:
      - Shows what changed, with its diff under --diff; what failed, with its message and output;
        what a debug task says; retries; and a recap. ok and skipped tasks are only counted.
      - On a terminal the running task is one line, redrawn with a spinner and its running time.
    extends_documentation_fragment:
      - result_format_callback
"""

import os
import re
import shutil
import sys
import threading
import time

from ansible import constants as C
from ansible.playbook.task_include import TaskInclude
from ansible.plugins.callback import CallbackBase
from ansible.utils import color

INDENT = "    "
DETAIL = INDENT + "    "
# kayra caps its own lines here; the times line up with its frames.
COLUMNS = 80
TAIL = 20
FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

TONES = {"ok": "32", "bad": "31", "warn": "33", "active": "36", "muted": "2", "strong": "1"}


def paint(tone, text):
    return "\x1b[%sm%s\x1b[0m" % (TONES[tone], text) if color.ANSIBLE_COLOR and text else text


def diff_lines(diff):
    """Ansible colors a diff line with its newline inside, so a line's reset may end up on the next."""
    reset = "\x1b[0m" if color.ANSIBLE_COLOR else ""
    lines = [line + reset for line in diff.splitlines()]
    while lines and not re.sub(r"\x1b\[[0-9;]*m", "", lines[-1]).strip():
        lines.pop()
    return lines


def duration(seconds):
    if seconds < 10:
        return "%.1fs" % (int(seconds * 10) / 10)
    if seconds < 60:
        return "%ds" % seconds
    if seconds < 3600:
        return "%dm%02ds" % (seconds // 60, seconds % 60)
    return "%dh%02dm" % (seconds // 3600, seconds % 3600 // 60)


def tail(text, count=TAIL):
    lines = str(text).rstrip().splitlines()
    return (["… %d lines before" % (len(lines) - count)] if len(lines) > count else []) + lines[-count:]


def title(task, handler=False):
    """`role › task` instead of Ansible's `role : task`."""
    name = task.get_name().strip()
    role, sep, rest = name.partition(" : ")
    name = "%s › %s" % (role, rest) if sep else name
    return "handler › " + name if handler else name


class CallbackModule(CallbackBase):
    CALLBACK_VERSION = 2.0
    CALLBACK_TYPE = "stdout"
    CALLBACK_NAME = "kayra"

    def __init__(self):
        super().__init__()
        self._pid = os.getpid()
        self._live = sys.stdout.isatty() and os.environ.get("TERM") != "dumb"
        self._width = min(shutil.get_terminal_size((COLUMNS, 24)).columns, COLUMNS)
        # Display's own lock: the spinner never writes in the middle of its output.
        self._lock = getattr(self._display, "_lock", None) or threading.RLock()
        self._task = None
        self._started = time.monotonic()
        self._retrying = ""
        self._drawn = False
        self._shown = set()
        self._handlers = set()
        self._root = os.getcwd()
        self._done = threading.Event()
        if self._live:
            self._wrap_display()
            threading.Thread(target=self._tick, name="kayra-spinner", daemon=True).start()

    # The line for the task at work: cleared before anything is printed, drawn again after.

    def _wrap_display(self):
        original = self._display.display

        def display(msg, *args, **kwargs):
            # Forked workers hand their output to this process; only it draws.
            if os.getpid() != self._pid or kwargs.get("log_only"):
                return original(msg, *args, **kwargs)
            with self._lock:
                self._clear()
                original(msg, *args, **kwargs)
                self._draw()

        self._display.display = display

    def _tick(self):
        while not self._done.wait(0.1):
            with self._lock:
                self._draw()

    def _clear(self):
        if self._drawn:
            sys.stdout.write("\r\x1b[2K")
            sys.stdout.flush()
            self._drawn = False

    def _draw(self):
        if not self._live or self._task is None or self._done.is_set():
            return
        elapsed = time.monotonic() - self._started
        frame = FRAMES[int(elapsed * 10) % len(FRAMES)]
        # One line, never wrapped: \r only returns to the start of the last one.
        sys.stdout.write("\r\x1b[2K" + self._line(frame, "active", self._task + self._retrying, None, duration(elapsed)))
        sys.stdout.flush()
        self._drawn = True

    # What is printed.

    def _say(self, line=""):
        self._display.display(line)

    def _line(self, glyph, tone, name, name_tone, right):
        """A glyph, a name, and `right` flush with the last column; lengths taken before painting."""
        room = self._width - len(INDENT) - 2 - (len(right) + 2 if right else 0)
        name = name if len(name) <= room else name[: max(0, room - 1)] + "…"
        pad = " " * (room - len(name) + 2) if right else ""
        return INDENT + paint(tone, glyph) + " " + (paint(name_tone, name) if name_tone else name) + pad + paint("muted", right)

    def _headline(self, glyph, tone, name, name_tone=None, note=""):
        took = time.monotonic() - self._started
        right = " · ".join(part for part in (note, duration(took) if took >= 1 else "") if part)
        self._say(self._line(glyph, tone, name, name_tone, right))

    def _failure(self, result):
        """A failure's warnings; its exception says again what its message says, at length."""
        self._handle_warnings(result.result)
        result.result.pop("exception", None)

    def _details(self, result, tone=None):
        res = result.result
        if res.get("censored"):
            self._say(DETAIL + paint("muted", res["censored"]))
            return
        lines = []
        if res.get("msg"):
            lines += str(res["msg"]).rstrip().splitlines()
        for key in ("stderr", "module_stderr", "stdout", "module_stdout"):
            text = res.get(key)
            if text and str(text).strip() and str(text).strip() != str(res.get("msg", "")).strip():
                lines += [paint("muted", key + ":")] + ["  " + line for line in tail(text)]
        if not lines:
            lines = self._dump_results(res, indent=2).rstrip().splitlines()
        for line in lines:
            self._say(DETAIL + (paint(tone, line) if tone else line))
        path = result.task.get_path()
        if path:
            self._say(DETAIL + paint("muted", "at " + os.path.relpath(path, self._root)))

    def _changed(self, result, label=""):
        key = (result.task._uuid, result.host.get_name(), label)
        if key in self._shown:
            return
        self._shown.add(key)
        self._headline("~", "warn", self._name(result) + (" · %s" % label if label else ""))

    def _name(self, result):
        return title(result.task, handler=result.task._uuid in self._handlers)

    # Ansible's events.

    def v2_playbook_on_start(self, playbook):
        # Tasks are named by their path from above the playbooks: roles/<role>/tasks/main.yml.
        self._root = os.path.dirname(os.path.abspath(playbook._basedir))

    def v2_playbook_on_play_start(self, play):
        name = play.get_name().strip()
        with self._lock:
            self._task = None
            if name:
                self._say(INDENT + paint("muted", "▸ " + name))

    def _start(self, task, handler=False):
        with self._lock:
            if handler:
                self._handlers.add(task._uuid)
            self._task = title(task, handler)
            self._started = time.monotonic()
            self._retrying = ""
            self._clear()
            self._draw()

    def v2_playbook_on_task_start(self, task, is_conditional):
        self._start(task)

    def v2_playbook_on_handler_task_start(self, task):
        self._start(task, handler=True)

    def v2_runner_on_ok(self, result):
        self._handle_warnings_and_exception(result)
        if isinstance(result.task, TaskInclude):
            return
        res = result.result
        if result.task.action in C._ACTION_DEBUG and not result.task.loop:
            self._clean_results(res, result.task.action)
            self._headline("·", "active", self._name(result))
            msg = res.get("msg")
            text = "\n".join(map(str, msg)) if isinstance(msg, list) else str(msg) if "msg" in res else self._dump_results(res, indent=2)
            for line in text.rstrip().splitlines():
                self._say(DETAIL + line)
            return
        if res.get("changed") and not (result.task.loop and "results" in res):
            self._changed(result)

    def v2_runner_item_on_ok(self, result):
        self._handle_warnings_and_exception(result)
        if result.result.get("changed"):
            self._changed(result, str(self._get_item_label(result.result)))

    def v2_on_file_diff(self, result):
        res = result.result
        items = res["results"] if result.task.loop and "results" in res else [res]
        for item in items:
            if item.get("diff") and item.get("changed"):
                diff = self._get_diff(item["diff"])
                if diff:
                    label = str(self._get_item_label(item)) if result.task.loop else ""
                    self._changed(result, label)
                    for line in diff_lines(diff):
                        self._say(DETAIL + line)

    def v2_runner_on_failed(self, result, ignore_errors=False):
        self._failure(result)
        if result.task.loop and "results" in result.result:
            return
        if ignore_errors:
            self._headline("✗", "muted", self._name(result), "muted", "ignored")
            return
        rc = result.result.get("rc")
        self._headline("✗", "bad", self._name(result), "strong", "exit %s" % rc if rc not in (None, 0) else "")
        self._details(result)

    def v2_runner_item_on_failed(self, result):
        self._failure(result)
        self._headline("✗", "bad", "%s · %s" % (self._name(result), self._get_item_label(result.result)), "strong")
        self._details(result)

    def v2_runner_on_unreachable(self, result):
        self._failure(result)
        self._headline("✗", "bad", "%s unreachable" % result.host.get_name(), "strong")
        self._details(result)

    def v2_runner_retry(self, result):
        left = result.result.get("retries", 0) - result.result.get("attempts", 0)
        with self._lock:
            first = not self._retrying
            self._retrying = " (retrying, %d left)" % left
            # On a terminal the task's line says it; elsewhere once is enough to show it is not stuck.
            if first and not self._live:
                self._headline("↻", "warn", "%s: retrying, %d left" % (self._name(result), left))

    def v2_playbook_on_no_hosts_matched(self):
        self._say(INDENT + paint("muted", "no hosts matched"))

    def v2_playbook_on_stats(self, stats):
        with self._lock:
            self._task = None
            self._done.set()
            self._clear()
        hosts = sorted(stats.processed.keys())
        for host in hosts:
            counts = stats.summarize(host)
            parts = [paint("muted", "%d ok" % counts["ok"]), paint("warn" if counts["changed"] else "muted", "%d changed" % counts["changed"])]
            parts += [paint("muted", "%d %s" % (counts[key], word)) for key, word in (("skipped", "skipped"), ("rescued", "rescued"), ("ignored", "ignored")) if counts[key]]
            parts += [paint("bad", "%d %s" % (counts[key], word)) for key, word in (("failures", "failed"), ("unreachable", "unreachable")) if counts[key]]
            prefix = paint("muted", host + ": ") if len(hosts) > 1 else ""
            self._say(INDENT + prefix + paint("muted", " · ").join(parts))
