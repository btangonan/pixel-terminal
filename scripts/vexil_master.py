#!/usr/bin/env python3
"""
vexil_master.py — Proactive cross-session Vexil commentary daemon.

Polls /tmp/vexil_feed.jsonl for events from all pixel-terminal sessions.
Watches tool sequences per session and fires Claude (claude -p subprocess)
when patterns suggest something worth commenting on. Also watches for
tool errors and token bloat across sessions.

Triggers:
  retry_loop          — same tool 3+ times in a row in one session
  read_heavy          — 9+ consecutive read ops within 90s with no write
  cross_session_error — same tool error in 2+ different sessions
  token_bloat         — single turn > 80k tokens

Cooldown: max 1 comment per 60 seconds globally.
"""

import json
import os
import re
import time
import collections
import subprocess
import threading
from pathlib import Path
from typing import Optional, Tuple, Dict

_DATA_DIR            = Path.home() / '.local' / 'share' / 'pixel-terminal'
FEED_PATH            = str(_DATA_DIR / 'vexil_feed.jsonl')
OUT_PATH             = str(_DATA_DIR / 'vexil_master_out.jsonl')
ORACLE_QUERY_PATH    = str(_DATA_DIR / 'oracle_query.json')
POLL_INTERVAL        = 1.0
COOLDOWN             = 60.0   # global cooldown for anomaly triggers (retry, etc.)
TURN_COOLDOWN        = 20.0   # per-session cooldown for turn_complete commentary
TOKEN_BLOAT_THRESHOLD = 80000
RETRY_THRESHOLD      = 3   # same tool N times in a row
READ_HEAVY_THRESHOLD = 5   # lowered: 5 consecutive reads (was 9, unreachable in practice)
READ_HEAVY_MIN_READS = 4   # minimum pure reads within the tail (was 6)
READ_HEAVY_WINDOW    = 90.0 # must happen within this many seconds
FIRED_PATTERN_TTL    = 300.0 # seconds before a fired pattern can re-trigger
ACTIVITY_TRIGGER_THRESHOLD = 8  # tool events since last comment before tick fires
ACTIVITY_RECENCY_WINDOW    = 120.0  # only include recent_activity entries within this many seconds

# Tools that produce output / change state
WRITE_TOOLS = {
    'Write', 'Edit', 'MultiEdit', 'Bash',
    'NotebookEdit', 'mcp__figma', 'mcp__github__create',
    'mcp__github__push', 'mcp__github__merge',
}

# Tools that only read / search
READ_TOOLS = {
    'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch',
    'TodoRead', 'TaskList', 'TaskGet',
}


def classify_tool(name: str) -> str:
    """Return 'write', 'read', or 'other'."""
    for w in WRITE_TOOLS:
        if name.startswith(w):
            return 'write'
    # Strip mcp__ prefix for matching
    bare = name.split('__')[-1] if '__' in name else name
    if bare in READ_TOOLS or name in READ_TOOLS:
        return 'read'
    for r in READ_TOOLS:
        if name.startswith(r):
            return 'read'
    return 'other'


def short_name(tool: str) -> str:
    """Human-readable tool name for prompts."""
    return tool.replace('mcp__', '').replace('__', ' ').replace('_', ' ')


def load_buddy() -> dict:
    """Load buddy.json for name and species."""
    buddy_path = Path.home() / '.config' / 'pixel-terminal' / 'buddy.json'
    try:
        return json.loads(buddy_path.read_text())
    except Exception:
        return {'name': 'Vexil', 'species': 'dragon'}


def load_claude_companion() -> dict:
    """Read the official companion soul from ~/.claude.json (name + personality)."""
    try:
        claude_path = Path.home() / '.claude.json'
        data = json.loads(claude_path.read_text())
        return data.get('companion', {})
    except Exception:
        return {}


def build_persona() -> str:
    # Soul from official Claude Code companion (~/.claude.json) — canonical identity.
    # Bones (species, stats) from buddy.json — may be stale until sync_real_buddy.ts runs.
    companion = load_claude_companion()
    buddy     = load_buddy()

    name        = companion.get('name') or buddy.get('name', 'Vexil')
    personality = companion.get('personality') or buddy.get('personality', '')

    # Use the official personality as the complete character base.
    # Watcher framing from prompt.ts: "You're not {name}" = voice acting, not method acting.
    return (
        f"{personality}\n\n"
        f"You watch across multiple Claude Code sessions and occasionally drop one line "
        f"in a speech bubble. You're not {name} — you're writing its line.\n"
        f"One physical action in asterisks, specific to this moment — never repeat the same action twice in a row.\n"
        f"Under 20 words total. Say what's wrong, not what's happening. No preamble."
    )


def call_claude_oracle(message: str, history: list, sessions: list = None, live_ctx: str = None, recent_convo: str = None) -> Optional[str]:
    """Interactive ORACLE pre-session chat — per-query subprocess, same auth path as old oracle."""
    companion   = load_claude_companion()
    buddy       = load_buddy()
    name        = companion.get('name') or buddy.get('name', 'Vexil')
    personality = companion.get('personality') or buddy.get('personality', '')

    buddy_species = buddy.get('species', '')
    buddy_voice   = buddy.get('voice', '')
    buddy_stats   = buddy.get('stats', {})
    peak_stat     = max(buddy_stats, key=lambda k: buddy_stats[k]) if buddy_stats else ''
    peak_val      = buddy_stats.get(peak_stat, 0) if peak_stat else 0

    # Build trait line — shared across both branches
    trait_line = ''
    if buddy_species or buddy_voice or peak_stat:
        trait_line = f"Species: {buddy_species}." if buddy_species else ''
        if buddy_voice and buddy_voice != 'default':
            trait_line += f" Voice: {buddy_voice}."
        if peak_stat:
            trait_line += f" Peak trait: {peak_stat} {peak_val}/10."
        trait_line = trait_line.strip()

    if sessions:
        sessions_str = '; '.join(f"{s.get('name')} ({s.get('cwd')})" for s in sessions)
        context = f"{personality}\n\n" if personality else ''
        context += (
            f"You are {name}, watching Claude Code sessions.\n"
            f"Open sessions: {sessions_str}.\n"
        )
        if trait_line:
            context += trait_line + "\n"
        if live_ctx:
            context += f"Recent tool activity:\n{live_ctx}\n"
        if recent_convo:
            context += f"Recent session conversation:\n{recent_convo}\n"
        context += (
            "\nAnswer directly from what you know. Be opinionated and specific. "
            "2 sentences max. Cut to the insight, not the description."
        )
    else:
        context = f"{personality}\n\n" if personality else ''
        if trait_line:
            context += trait_line + "\n"
        context += (
            f"You are {name}. No sessions open — you're blind right now. "
            "Tell the user to press + to open a project folder. "
            "One sentence."
        )
    lines = [context, "", "--- Conversation ---"]
    for turn in history:
        role = "USER" if turn.get('role') == 'user' else name.upper()
        lines.append(f"{role}: {turn.get('content', '')}")
    lines.append(f"USER: {message}")
    lines.append(f"{name.upper()}:")
    full_prompt = "\n".join(lines)
    model   = 'claude-sonnet-4-6' if sessions else 'claude-haiku-4-5-20251001'
    timeout = 30 if sessions else 12
    try:
        result = subprocess.run(
            ['claude', '-p', '--bare', '--model', model],
            input=full_prompt,
            capture_output=True, text=True, timeout=timeout,
        )
        if result.returncode != 0:
            print(f'[vexil-master] oracle -p failed (rc={result.returncode}): {result.stderr[:200]}', flush=True)
            return None
        msg = result.stdout.strip()
        return msg if msg else None
    except subprocess.TimeoutExpired:
        print(f'[vexil-master] oracle timed out ({timeout}s)', flush=True)
        return None
    except Exception as e:
        print(f'[vexil-master] oracle error: {e}', flush=True)
        return None


def call_claude(prompt: str) -> Optional[str]:
    # Watcher framing (not roleplay) gives personality without asterisk bleedthrough.
    # Back to Sonnet — Haiku was too weak for Vexil's voice.
    # Pipe via stdin (not -p arg) to avoid ARG_MAX limits on large file-context prompts.
    full_prompt = f"{build_persona()}\n\n{prompt}"
    try:
        result = subprocess.run(
            ['claude', '-p', '--model', 'claude-sonnet-4-6'],
            input=full_prompt,
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            print(f'[vexil-master] claude -p failed: {result.stderr[:120]}')
            return None
        msg = result.stdout.strip()
        if not msg or msg == 'SKIP':
            return None
        return msg
    except subprocess.TimeoutExpired:
        print('[vexil-master] claude subprocess timed out')
        return None
    except Exception as e:
        print(f'[vexil-master] claude subprocess error: {e}')
        return None


def append_out(msg: str) -> None:
    """Atomically append a commentary entry (O_APPEND)."""
    entry = json.dumps({'msg': msg, 'ts': int(time.time() * 1000)})
    fd = os.open(OUT_PATH, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    try:
        os.write(fd, (entry + '\n').encode())
    finally:
        os.close(fd)


def check_tool_patterns(
    sid: str,
    sequences: dict,
    now: float,
    session_born: dict = None,
) -> Tuple[Optional[str], dict]:
    """
    Inspect per-session tool sequence for patterns worth commenting on.
    Returns (trigger_name, data) or (None, {}).
    """
    seq = sequences.get(sid)
    if not seq or len(seq) < RETRY_THRESHOLD:
        return None, {}

    entries = list(seq)
    tools = [t for _, t, _ in entries]
    hints = [h for _, _, h in entries]

    # Retry loop: last N calls are the same tool
    if len(tools) >= RETRY_THRESHOLD:
        tail_tools = tools[-RETRY_THRESHOLD:]
        tail_hints = hints[-RETRY_THRESHOLD:]
        if len(set(tail_tools)) == 1:
            return 'retry_loop', {
                'tool': tail_tools[0],
                'count': RETRY_THRESHOLD,
                'hints': [h for h in tail_hints if h],
                'session_id': sid,
            }

    # Read-heavy: N consecutive reads within time window with no write
    # Suppress during session orientation window (first 120s) — /gsd and CLAUDE.md reads are expected
    session_age = now - session_born.get(sid, now)
    if len(entries) >= READ_HEAVY_THRESHOLD and session_age > 120:
        tail = entries[-READ_HEAVY_THRESHOLD:]
        tail_ts    = [ts for ts, _, _ in tail]
        tail_tools = [t for _, t, _ in tail]
        tail_hints = [h for _, _, h in tail]
        window_ok   = (now - tail_ts[0]) <= READ_HEAVY_WINDOW
        all_reads   = all(classify_tool(t) in ('read', 'other') for t in tail_tools)
        enough_reads = sum(1 for t in tail_tools if classify_tool(t) == 'read') >= READ_HEAVY_MIN_READS
        if window_ok and all_reads and enough_reads:
            return 'read_heavy', {
                'tools': [short_name(t) for t in tail_tools[-4:]],
                'hints': [h for h in tail_hints[-4:] if h],
                'count': READ_HEAVY_THRESHOLD,
                'session_id': sid,
            }

    return None, {}


# Pixel-terminal internal terms — messages referencing these are dev-only
_INTERNAL_TERMS = [
    'companion.js', 'vexil_master', 'session-lifecycle', 'session.js',
    'events.js', 'cards.js', 'voice.js', 'attachments.js', 'history.js',
    'app.js', 'styles.css', 'index.html', 'dom.js', 'messages.js',
    'buddy.json', 'vexil_feed', 'vexil_master_out', 'vexil_lint',
    'pixel-terminal', 'pixel_terminal', 'LINT_LOG', 'BUDDY tab',
    'FILES tab', 'VOICE tab', 'vexil-log', 'vexil-bio',
]

def _is_internal(msg: str) -> bool:
    """Return True if the message references pixel-terminal internals."""
    lower = msg.lower()
    return any(term.lower() in lower for term in _INTERNAL_TERMS)


def _read_file_context(file_path: Optional[str], cwd: Optional[str], max_lines: int = 100) -> Optional[str]:
    """Read up to max_lines from file_path. Returns None if unreadable or unsafe."""
    if not file_path:
        return None
    try:
        p = Path(file_path)
        # Resolve relative paths against cwd
        if not p.is_absolute() and cwd:
            p = (Path(cwd) / p).resolve()
        # Safety: path must stay within cwd
        if cwd and not str(p).startswith(str(Path(cwd).resolve())):
            return None
        lines = p.read_text(errors='replace').splitlines()
        excerpt = '\n'.join(lines[:max_lines])
        return f'--- {p.name} ---\n{excerpt}'
    except Exception:
        return None


def _collect_file_excerpts(recent_activity: dict, now: float, recency_window: float,
                           max_lines_per_file: int = 100) -> str:
    """Collect up to 3 unique file excerpts from recent activity. Returns formatted string."""
    seen: dict[str, str] = {}  # path → excerpt
    for acts in recent_activity.values():
        for entry in acts:
            if len(entry) < 5:
                continue
            ets, _, _, file_path, cwd = entry
            if (now - ets) > recency_window:
                continue
            if file_path and file_path not in seen and len(seen) < 3:
                excerpt = _read_file_context(file_path, cwd, max_lines=max_lines_per_file)
                if excerpt:
                    seen[file_path] = excerpt
    if not seen:
        return ''
    return 'Files being worked on:\n' + '\n\n'.join(seen.values()) + '\n\n'


def _reporting_mode() -> str:
    """Read reportingMode from buddy.json. Defaults to 'user'."""
    try:
        buddy_path = Path.home() / '.config' / 'pixel-terminal' / 'buddy.json'
        data = json.loads(buddy_path.read_text())
        return data.get('reportingMode', 'user')
    except Exception:
        return 'user'


def main() -> None:
    # Ensure runtime data directory exists (safe from /tmp symlink attacks)
    _DATA_DIR.mkdir(parents=True, exist_ok=True)

    feed_offset: int = 0
    last_comment_ts: float = 0.0
    tool_errors: Dict[str, list] = {}

    # Lock protecting recent_activity — accessed by main loop and oracle worker thread
    _activity_lock = threading.Lock()

    # Per-session tool sequence: {session_id: deque of (timestamp, tool_name)}
    # Max 20 entries per session — enough for pattern detection, bounded memory
    tool_sequences: Dict[str, collections.deque] = {}
    # Track when patterns last fired: {key: timestamp}. Expire after FIRED_PATTERN_TTL.
    fired_patterns: Dict[str, float] = {}
    # Activity tick: tool events seen since last comment fired
    tools_since_comment: int = 0
    # Recent tool summary for activity tick prompt: {session_id: [(tool, hint), ...]}
    recent_activity: Dict[str, list] = {}
    # Per-session last comment time for turn_complete cadence (20s cooldown)
    last_comment_per_session: Dict[str, float] = {}
    # Rolling last-4 conversation turns per session for oracle context
    _session_convo: Dict[str, list] = {}
    # First time we saw any event for this session — used to suppress orientation-phase triggers
    session_born: Dict[str, float] = {}
    # turn_complete events seen this batch: {session_id: tool_count}
    turn_complete_this_batch: Dict[str, int] = {}

    # Last 3 physical actions Vexil used — injected into prompt to prevent repetition
    recent_actions: collections.deque = collections.deque(maxlen=3)

    # Seed offset — skip events from before this daemon started
    try:
        feed_offset = os.path.getsize(FEED_PATH)
    except FileNotFoundError:
        pass

    print(f'[vexil-master] started — watching {FEED_PATH}')
    # Write startup signal so companion.js can detect daemon presence on poll
    append_out('\u22b8 online')

    _oracle_query_mtime: float = 0.0
    _oracle_busy: bool = False
    _commentary_busy: bool = False

    def _oracle_worker(query: dict) -> None:
        nonlocal _oracle_busy
        try:
            _now = time.time()
            activity_lines = []
            convo_lines    = []
            with _activity_lock:
                _activity_snapshot = list(recent_activity.items())
                _convo_snapshot    = {k: list(v) for k, v in _session_convo.items()}
            for sid, acts in _activity_snapshot:
                _recent = [(t, tool, hint) for (t, tool, hint, *_) in acts if _now - t < 300]
                if _recent:
                    summary = ', '.join(f"{tool}({hint})" if hint else tool for _, tool, hint in _recent[-4:])
                    activity_lines.append(f"  session {sid[:8]}: {summary}")
            # Include last 2 turns from the most recently updated session
            if _convo_snapshot:
                latest_sid = max(
                    _convo_snapshot,
                    key=lambda s: _convo_snapshot[s][-1][0] if _convo_snapshot[s] else 0
                )
                for ts_e, user_msg, turn_text in _convo_snapshot[latest_sid][-2:]:
                    if user_msg:
                        convo_lines.append(f"USER: {user_msg[:300]}")
                    if turn_text:
                        convo_lines.append(f"CLAUDE: {turn_text[:600]}")
            live_ctx     = '\n'.join(activity_lines) if activity_lines else None
            recent_convo = '\n'.join(convo_lines)    if convo_lines    else None
            reply = call_claude_oracle(
                query.get('message', ''),
                query.get('history', []),
                query.get('sessions', []),
                live_ctx,
                recent_convo,
            )
            if reply:
                out_entry = json.dumps({
                    'type': 'oracle_response',
                    'req_id': query.get('req_id'),
                    'msg': reply,
                    'ts': int(time.time() * 1000),
                })
                fd = os.open(OUT_PATH, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
                try:
                    os.write(fd, (out_entry + '\n').encode())
                finally:
                    os.close(fd)
                print(f'[vexil-master] oracle → "{reply[:80]}"', flush=True)
        except Exception as _oe:
            print(f'[vexil-master] oracle worker error: {_oe}', flush=True)
        finally:
            _oracle_busy = False

    def _commentary_worker(prompt: str, _trigger: str) -> None:
        nonlocal _commentary_busy
        try:
            msg = call_claude(prompt)
            if msg:
                if _reporting_mode() != 'dev' and _is_internal(msg):
                    print(f'[vexil-master] suppressed internal ref (user mode): "{msg[:80]}"')
                else:
                    append_out(msg)
                    m = re.search(r'\*([^*]+)\*', msg)
                    if m:
                        recent_actions.append(m.group(1).strip())
                print(f'[vexil-master] {_trigger} → "{msg[:80]}"', flush=True)
        except Exception as _ce:
            print(f'[vexil-master] commentary worker error: {_ce}', flush=True)
        finally:
            _commentary_busy = False

    while True:
        # ── Oracle pre-session chat (non-blocking thread dispatch) ────────────
        if not _oracle_busy:
            try:
                qmtime = os.path.getmtime(ORACLE_QUERY_PATH)
                if qmtime > _oracle_query_mtime:
                    _oracle_query_mtime = qmtime
                    with open(ORACLE_QUERY_PATH) as _qf:
                        query = json.load(_qf)
                    _oracle_busy = True
                    threading.Thread(target=_oracle_worker, args=(query,), daemon=True).start()
            except FileNotFoundError:
                pass
            except Exception as _oe:
                print(f'[vexil-master] oracle check error: {_oe}', flush=True)

        time.sleep(POLL_INTERVAL)

        # ── Read new feed entries ─────────────────────────────────────────────
        new_entries: list[dict] = []
        try:
            # Detect file truncation/rotation — reset offset so events aren't missed
            try:
                if os.path.getsize(FEED_PATH) < feed_offset:
                    feed_offset = 0
            except FileNotFoundError:
                pass
            with open(FEED_PATH, 'rb') as f:
                f.seek(feed_offset)
                chunk = f.read()
            # Only advance to the last complete line — a trailing partial line (written mid-event)
            # would advance the offset past it, permanently losing the event.
            last_nl = chunk.rfind(b'\n')
            if last_nl >= 0:
                feed_offset += last_nl + 1
                chunk = chunk[:last_nl + 1]
            else:
                chunk = b''  # no complete lines yet — skip this poll cycle
            for raw_line in chunk.decode(errors='replace').splitlines():
                raw_line = raw_line.strip()
                if not raw_line:
                    continue
                try:
                    new_entries.append(json.loads(raw_line))
                except json.JSONDecodeError:
                    pass
        except FileNotFoundError:
            continue

        if not new_entries:
            continue

        # ── Process events ────────────────────────────────────────────────────
        now = time.time()
        trigger: Optional[str] = None
        trigger_data: dict = {}

        # Expire stale fired_patterns entries (TTL-based reset)
        fired_patterns = {k: ts for k, ts in fired_patterns.items()
                         if (now - ts) < FIRED_PATTERN_TTL}

        # Collect which sessions got new tool_use events this batch
        sessions_with_new_tools: set = set()
        turn_complete_this_batch = {}

        for entry in new_entries:
            etype = entry.get('type')
            sid   = entry.get('session_id', '?')
            ets   = entry.get('ts', now * 1000) / 1000  # ms → s

            if etype == 'tool_use':
                tool = entry.get('tool', '')
                hint = entry.get('hint', '')  # human-readable context from toolHint()
                if not tool:
                    continue
                if sid not in session_born:
                    session_born[sid] = ets
                if sid not in tool_sequences:
                    tool_sequences[sid] = collections.deque(maxlen=20)
                tool_sequences[sid].append((ets, tool, hint))
                sessions_with_new_tools.add(sid)
                # Keep a short rolling summary per session for tick context
                # (counter is driven by tool_any — not here, avoids double-count)
                file_path = entry.get('file')   # full absolute path, or None
                cwd       = entry.get('cwd')    # session project root, or None
                with _activity_lock:
                    if sid not in recent_activity:
                        recent_activity[sid] = []
                    recent_activity[sid].append((ets, short_name(tool), hint, file_path, cwd))
                    if len(recent_activity[sid]) > 6:
                        recent_activity[sid] = recent_activity[sid][-6:]

                # Write tools reset the read-heavy TTL so it can re-trigger
                if classify_tool(tool) == 'write':
                    fired_patterns.pop(f'{sid}:read_heavy', None)

            elif etype == 'turn_complete':
                tool_count = entry.get('tool_count', 0)
                if tool_count > 0:
                    turn_complete_this_batch[sid] = {
                        'tc':        tool_count,
                        'turn_text': entry.get('turn_text', ''),
                        'user_msg':  entry.get('user_msg', ''),
                    }
                # Always capture conversation turns so oracle has context for "is this right?" queries
                _user_msg  = entry.get('user_msg', '')
                _turn_text = entry.get('turn_text', '')
                if _user_msg or _turn_text:
                    with _activity_lock:
                        if sid not in _session_convo:
                            _session_convo[sid] = []
                        _session_convo[sid].append((ets, _user_msg, _turn_text))
                        if len(_session_convo[sid]) > 4:
                            _session_convo[sid] = _session_convo[sid][-4:]

            elif etype == 'tool_any':
                # Lightweight counter-only event — all tools including MCP/internal.
                # Don't add to sequences or recent_activity (no hint/context).
                tools_since_comment += 1

            elif etype == 'tool_error':
                tool  = entry.get('tool', '?')
                error = entry.get('error', '')[:40]
                key   = f"{tool}:{error}"
                if key not in tool_errors:
                    tool_errors[key] = []
                if sid not in tool_errors[key]:
                    tool_errors[key].append(sid)

            elif etype == 'token_bloat':
                tokens = entry.get('tokens', 0)
                if tokens > TOKEN_BLOAT_THRESHOLD and trigger is None:
                    if (now - last_comment_ts) > COOLDOWN:
                        trigger = 'token_bloat'
                        trigger_data = {'tokens': tokens, 'session_id': sid}


        # ── Per-turn commentary (native buddy cadence) ───────────────────────
        # Fires once per completed turn if the session did real work (tool_count > 0).
        # Uses per-session cooldown (20s) not global, so 2 active sessions both comment.
        if trigger is None and turn_complete_this_batch:
            for tc_sid, tc_data in turn_complete_this_batch.items():
                since_last = now - last_comment_per_session.get(tc_sid, 0)
                if since_last >= TURN_COOLDOWN:
                    with _activity_lock:
                        acts = list(recent_activity.get(tc_sid, []))
                    recent = [(t, h) for ts_e, t, h, *_ in acts if (now - ts_e) <= 60.0]
                    if recent:
                        trigger = 'turn_complete'
                        trigger_data = {
                            'session_id': tc_sid,
                            'tool_count': tc_data['tc'],
                            'activity':   recent[-4:],
                            'turn_text':  tc_data.get('turn_text', ''),
                            'user_msg':   tc_data.get('user_msg', ''),
                        }
                        last_comment_per_session[tc_sid] = now
                        break

        # ── Check tool patterns once per batch (not per entry) ───────────────
        if trigger is None and (now - last_comment_ts) > COOLDOWN:
            for sid in sessions_with_new_tools:
                pat, data = check_tool_patterns(sid, tool_sequences, now, session_born)
                if pat:
                    pat_key = f'{sid}:{pat}'
                    if pat_key not in fired_patterns:
                        trigger = pat
                        trigger_data = data
                        fired_patterns[pat_key] = now
                        break

        # Activity tick — fires when enough tool events have accumulated since last comment
        if trigger is None and tools_since_comment >= ACTIVITY_TRIGGER_THRESHOLD:
            if (now - last_comment_ts) > COOLDOWN:
                # Only use activity entries from the last ACTIVITY_RECENCY_WINDOW seconds
                # so the tick reflects what's happening NOW, not an hour ago
                summary_parts = []
                with _activity_lock:
                    _tick_snapshot = list(recent_activity.items())
                for sess_id, acts in _tick_snapshot:
                    recent = [(t, h) for ts_e, t, h, *_ in acts if (now - ts_e) <= ACTIVITY_RECENCY_WINDOW]
                    if recent:
                        pairs = [f"{t}({h})" if h else t for t, h in recent[-3:]]
                        summary_parts.append(f"[{sess_id}] {' → '.join(pairs)}")
                if not summary_parts:
                    # No recent tool_use events in window — counter was all MCP noise, skip
                    tools_since_comment = 0
                else:
                    trigger = 'session_activity'
                    trigger_data = {'summary': '; '.join(summary_parts)}

        # Cross-session error
        if trigger is None:
            for key, sessions in tool_errors.items():
                if len(set(sessions)) >= 2:
                    if (now - last_comment_ts) > COOLDOWN:
                        trigger = 'cross_session_error'
                        trigger_data = {'key': key, 'sessions': list(set(sessions))[:3]}
                        break

        if trigger is None:
            continue

        # ── Build Claude prompt ───────────────────────────────────────────────
        if trigger == 'turn_complete':
            sid       = trigger_data['session_id']
            tc        = trigger_data['tool_count']
            acts      = trigger_data['activity']
            turn_text = trigger_data.get('turn_text', '')
            user_msg  = trigger_data.get('user_msg', '')
            steps     = ' → '.join(f"{t}({h})" if h else t for t, h in acts)
            if turn_text:
                prompt = (
                    f"<user_msg>{user_msg}</user_msg>\n"
                    f"<claude_conclusion>{turn_text}</claude_conclusion>\n"
                    f"Tools: {steps} ({tc} tools).\n\n"
                    f"Write the next line for the companion. "
                    f"Drop ONE sharp observation — a pattern, a momentum shift, "
                    f"something interesting about what the user is building or where they're heading. "
                    f"Focus ONLY on the user's intent, workflow state, or project domain. "
                    f"Do NOT comment on Claude's internal bash commands, shell delays, or tool parameters. "
                    f"Do NOT give refactoring advice. "
                    f"Under 20 words. "
                    f"If you have nothing genuinely additive to say, output exactly: SKIP"
                )
            else:
                prompt = (
                    f"Tool sequence: {steps} ({tc} tools).\n\n"
                    f"Write the next line for the companion. "
                    f"Drop ONE sharp observation about what's happening — a pattern, a pivot, momentum. "
                    f"Do NOT give refactoring advice. "
                    f"Under 20 words. "
                    f"If you have nothing genuinely additive to say, output exactly: SKIP"
                )

        elif trigger == 'retry_loop':
            tool = short_name(trigger_data['tool'])
            count = trigger_data['count']
            sid = trigger_data['session_id']
            hints = trigger_data.get('hints', [])
            hint_ctx = ' → '.join(hints) if hints else 'no detail'
            prompt = (
                f"'{tool}' called {count} times in a row. Context: {hint_ctx}. "
                f"What's broken that made this necessary?"
            )

        elif trigger == 'read_heavy':
            tools = ', '.join(trigger_data['tools'])
            hints = trigger_data.get('hints', [])
            hint_ctx = ' | '.join(hints) if hints else 'no detail'
            sid = trigger_data['session_id']
            prompt = (
                f"{trigger_data['count']} reads, no writes. Files: {hint_ctx}. "
                f"Lost or avoiding the actual change?"
            )

        elif trigger == 'cross_session_error':
            key = trigger_data['key']
            sessions = trigger_data['sessions']
            prompt = (
                f"Same error '{key}' in {len(sessions)} sessions ({', '.join(sessions)}). "
                f"What's the shared root?"
            )

        elif trigger == 'session_activity':
            summary = trigger_data['summary']
            prompt = (
                f"Activity: {summary}. "
                f"What's the actual problem, not the activity description."
            )

        elif trigger == 'token_bloat':
            tokens = trigger_data['tokens']
            sid = trigger_data['session_id']
            prompt = (
                f"Session {sid} burned {tokens:,} tokens in a single turn. "
                f"Comment on what this likely means about how that session is "
                f"being used."
            )

        else:
            continue

        # ── Inject recent actions to prevent repetition ──────────────────────
        if recent_actions:
            avoid = ', '.join(f'"{a}"' for a in recent_actions)
            prompt = prompt + f'\n\nDo not use these physical actions (already used recently): {avoid}.'

        # ── Prepend file context (structural triggers only) ───────────────────
        # turn_complete already has turn_text + user_msg — file excerpts cause the
        # model to echo prose from large docs (STATE.md etc.) instead of observing.
        # Only inject for structural triggers (retry_loop, read_heavy) where file
        # content directly informs the diagnosis.
        try:
            if trigger != 'turn_complete':
                file_ctx = _collect_file_excerpts(recent_activity, now, ACTIVITY_RECENCY_WINDOW,
                                                  max_lines_per_file=100)
                if file_ctx:
                    prompt = prompt + '\n\nRelevant file context:\n' + file_ctx
        except Exception as e:
            print(f'[vexil-master] file context error (skipping): {e}', flush=True)

        # ── Dispatch commentary async — prevents 30s main loop stall ────────────
        # Set timestamps immediately to prevent re-triggering during async call.
        last_comment_ts = now
        tools_since_comment = 0
        if trigger == 'cross_session_error':
            tool_errors.clear()
        if not _commentary_busy:
            _commentary_busy = True
            threading.Thread(
                target=_commentary_worker, args=(prompt, trigger), daemon=True
            ).start()
        else:
            print(f'[vexil-master] commentary busy — skipping {trigger}', flush=True)


if __name__ == '__main__':
    main()
