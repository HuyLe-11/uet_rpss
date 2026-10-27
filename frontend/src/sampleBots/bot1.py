"""Bot 1 for OTTv2. Reads one JSON game state per line and prints x y nx ny."""
import json
import random
import sys

BEAT = {0: 2, 1: 0, 2: 1}
DIRECTIONS = [(dx, dy) for dx in (-1, 0, 1)
              for dy in (-1, 0, 1) if dx or dy]


def choose_move(state):
    me = state["me"]
    goal = tuple(state["goal"])
    pieces = {(x, y): (owner, kind)
              for x, y, owner, kind in state["pieces"]}
    moves = []

    for (x, y), (owner, kind) in pieces.items():
        if owner != me:
            continue
        for dx, dy in DIRECTIONS:
            nx, ny = x + dx, y + dy
            if not (0 <= nx < 9 and 0 <= ny < 9):
                continue
            target = pieces.get((nx, ny))
            if target is not None and (
                    target[0] == me or BEAT[kind] != target[1]):
                continue

            next_pieces = dict(pieces)
            del next_pieces[(x, y)]
            next_pieces[(nx, ny)] = (me, kind)
            enemy_types = {
                piece_kind for piece_owner, piece_kind in next_pieces.values()
                if piece_owner != me
            }
            if (nx, ny) == goal or len(enemy_types) < 3:
                return (x, y, nx, ny)

            before = max(abs(x - goal[0]), abs(y - goal[1]))
            after = max(abs(nx - goal[0]), abs(ny - goal[1]))
            score = random.random() * 0.3 + 0.5 * (before - after)
            if target is not None:
                score += 3
            if any(
                    enemy_owner != me
                    and BEAT[enemy_kind] == kind
                    and max(abs(ex - nx), abs(ey - ny)) == 1
                    for (ex, ey), (enemy_owner, enemy_kind) in next_pieces.items()):
                score -= 4
            moves.append((score, (x, y, nx, ny)))

    if not moves:
        return None
    best_score = max(score for score, _ in moves)
    return random.choice([move for score, move in moves
                          if score == best_score])


if __name__ == "__main__":
    for line in sys.stdin:
        try:
            move = choose_move(json.loads(line))
            if move is None:
                print("-1 -1 -1 -1", flush=True)
            else:
                print(*move, flush=True)
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            print("-1 -1 -1 -1", flush=True)
