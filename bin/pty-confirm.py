#!/usr/bin/env python3
"""dev-channels の確認プロンプトに Enter を1回送ってから、コマンドを常駐させる小さなラッパ。

`claude --dangerously-load-development-channels …` は起動のたびに人間の確認(Enter)を求める。
そのため `screen -dmS` のような非対話の常駐起動では先に進めない。このラッパは擬似端末(PTY)を
1枚用意してコマンドを起動し、確認プロンプトを検出したら Enter を1回送る。あとは入出力を
素通しして子プロセスを生かし続けるだけ——`screen -r` でアタッチすれば通常どおり操作できる。

使い方:  python3 bin/pty-confirm.py <command> [args...]
"""
import os, sys, pty, tty, termios, select, signal, struct, fcntl, time

# 確認プロンプトを示す目印。いずれかが出たら Enter を送る。
PROMPT_MARKERS = (b"Enter to confirm", b"local development", b"development channel")
FALLBACK_SECONDS = 30  # 目印を検出できなくても、この秒数で1回だけ Enter を送る保険


def get_winsize(fd):
    try:
        return struct.unpack("HHHH", fcntl.ioctl(fd, termios.TIOCGWINSZ, b"\x00" * 8))[:2]
    except OSError:
        return (40, 120)


def set_winsize(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main():
    argv = sys.argv[1:]
    if not argv:
        sys.stderr.write("usage: pty-confirm.py <command> [args...]\n")
        return 2

    pid, master = pty.fork()
    if pid == 0:                       # 子: 実コマンドに置き換わる
        os.execvp(argv[0], argv)
        os._exit(127)

    # 子 PTY のサイズを親端末に合わせる（端末でなければ既定値）。TUI を正しく描画させるため。
    out = sys.stdout.fileno()
    set_winsize(master, *(get_winsize(out) if os.isatty(out) else (40, 120)))

    # 親 stdin が端末なら raw にして、1文字ずつそのまま子へ渡す（アタッチ時の操作用）。
    stdin_fd = sys.stdin.fileno()
    saved = termios.tcgetattr(stdin_fd) if os.isatty(stdin_fd) else None
    if saved is not None:
        tty.setraw(stdin_fd)

    # 端末リサイズを子へ伝える。
    signal.signal(signal.SIGWINCH, lambda *_: os.isatty(out) and set_winsize(master, *get_winsize(out)))

    watch = [master, stdin_fd]
    buf = b""
    confirmed = False
    start = time.monotonic()
    try:
        while True:
            try:
                rlist, _, _ = select.select(watch, [], [], 1)
            except (OSError, select.error):
                continue

            if master in rlist:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    data = b""
                if not data:           # 子が終了 → EOF
                    break
                os.write(out, data)
                if not confirmed:
                    buf += data
                    if any(m in buf for m in PROMPT_MARKERS):
                        os.write(master, b"\r")
                        confirmed, buf = True, b""

            if stdin_fd in rlist:
                try:
                    data = os.read(stdin_fd, 65536)
                except OSError:
                    data = b""
                if not data:           # stdin が閉じた → 以後は監視しない（ビジーループ防止）
                    watch.remove(stdin_fd)
                else:
                    os.write(master, data)

            if not confirmed and time.monotonic() - start > FALLBACK_SECONDS:
                os.write(master, b"\r")
                confirmed = True
    finally:
        if saved is not None:
            termios.tcsetattr(stdin_fd, termios.TCSADRAIN, saved)

    _, status = os.waitpid(pid, 0)
    if hasattr(os, "waitstatus_to_exitcode"):
        return os.waitstatus_to_exitcode(status)
    return (status >> 8) if os.WIFEXITED(status) else 1


if __name__ == "__main__":
    sys.exit(main())
