"""Qualification benchmark 1: prefer legal moves that approach the goal."""
import random

random.seed(1)
BEAT = {0: 2, 1: 0, 2: 1}
DIRS = [(dx, dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1) if dx or dy]


def choose_move(state):
    board = {(x, y): (owner, kind) for x, y, owner, kind in state["pieces"]}
    me = state["me"]
    gx, gy = state["goal"]
    moves = []
    for (x, y), (owner, kind) in board.items():
        if owner != me:
            continue
        for dx, dy in DIRS:
            nx, ny = x + dx, y + dy
            if not (0 <= nx < 9 and 0 <= ny < 9):
                continue
            target = board.get((nx, ny))
            if target is not None and (target[0] == me or BEAT[kind] != target[1]):
                continue
            before = max(abs(x - gx), abs(y - gy))
            after = max(abs(nx - gx), abs(ny - gy))
            if after < before:
                moves.append((x, y, nx, ny))
    return random.choice(moves) if moves else entry_fallback(state)


def entry_fallback(state):
    board = {(x, y): (owner, kind) for x, y, owner, kind in state["pieces"]}
    me = state["me"]
    for (x, y), (owner, kind) in board.items():
        if owner != me:
            continue
        for dx, dy in DIRS:
            nx, ny = x + dx, y + dy
            target = board.get((nx, ny))
            if 0 <= nx < 9 and 0 <= ny < 9 and (target is None or (target[0] != me and BEAT[kind] == target[1])):
                return x, y, nx, ny
    return (-1, -1, -1, -1)
