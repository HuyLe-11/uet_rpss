import entry0 from './sampleBots/entry_bot0.py?raw';
import entry1 from './sampleBots/entry_bot1.py?raw';
import bot1 from './sampleBots/bot1.py?raw';
import bot2 from './sampleBots/bot2.py?raw';

export type SampleBot = { id: string; name: string; hint: string; source: string };

export const SAMPLE_BOTS: SampleBot[] = [
  { id: 'entry_bot0', name: 'Entry 0', hint: 'Vòng loại · đơn giản', source: entry0 },
  { id: 'entry_bot1', name: 'Entry 1', hint: 'Vòng loại · tiến về đích', source: entry1 },
  { id: 'bot1', name: 'Bot 1', hint: 'Thi đấu · ưu tiên thắng nhanh', source: bot1 },
  { id: 'bot2', name: 'Bot 2', hint: 'Thi đấu · nâng cao', source: bot2 },
];

const SIMULATOR = `
# ======================================================================
# CHẠY THỬ CỤC BỘ: python bot.py   (khối này bị bỏ qua khi nộp bài)
# Mô phỏng BO2 (đổi bên) giữa bot của bạn và bot BTC, rồi in kết quả.
# ======================================================================
if __name__ == "__main__":
    import types

    BEAT = {0: 2, 1: 0, 2: 1}
    MAX_PLY = 200

    btc = types.ModuleType("btc_bot")
    exec(BTC_SOURCE, btc.__dict__)
    btc_move = getattr(btc, "choose_move", None) or getattr(btc, "choose_best_move")
    players = {"you": choose_move, "btc": btc_move}

    def new_board():
        board = {}
        for x in range(9):
            board[(x, 0)] = (0, x % 3)
            board[(x, 8)] = (1, x % 3)
        return board

    def is_legal(board, side, move):
        try:
            x, y, nx, ny = [int(v) for v in move]
        except Exception:
            return False
        piece = board.get((x, y))
        if piece is None or piece[0] != side:
            return False
        if max(abs(nx - x), abs(ny - y)) != 1 or not (0 <= nx < 9 and 0 <= ny < 9):
            return False
        target = board.get((nx, ny))
        return target is None or (target[0] != side and BEAT[piece[1]] == target[1])

    def play(side_of):
        """side_of: {'you': 0/1, 'btc': 0/1}. Trả về (người thắng, số nước, lý do)."""
        board = new_board()
        who = {side: name for name, side in side_of.items()}
        goals = {0: (8, 8), 1: (0, 0)}
        for ply in range(MAX_PLY):
            side = ply % 2
            name = who[side]
            state = {
                "me": side,
                "ply": ply,
                "goal": list(goals[side]),
                "pieces": [[x, y, o, k] for (x, y), (o, k) in board.items()],
            }
            try:
                move = players[name](state)
            except Exception as error:
                return who[1 - side], ply, "%s bị lỗi: %r" % (name, error)
            if not move or not is_legal(board, side, move):
                return who[1 - side], ply, "%s đi sai luật: %r" % (name, move)
            x, y, nx, ny = [int(v) for v in move]
            board[(nx, ny)] = board.pop((x, y))
            if (nx, ny) == goals[side]:
                return name, ply + 1, "%s chạm ô đích" % name
            if len({k for o, k in board.values() if o != side}) < 3:
                return name, ply + 1, "%s triệt hạ một loại quân" % name
        return None, MAX_PLY, "hết %d nước, hòa" % MAX_PLY

    score = {"you": 0.0, "btc": 0.0}
    for game, side_of in enumerate(({"you": 0, "btc": 1}, {"you": 1, "btc": 0}), 1):
        winner, plies, reason = play(side_of)
        if winner:
            score[winner] += 1
        else:
            score["you"] += 0.5
            score["btc"] += 0.5
        label = {"you": "BẠN THẮNG", "btc": "BTC THẮNG"}.get(winner, "HÒA")
        print("Ván %d (bạn đi %s): %s sau %d nước - %s" % (game, "trước" if side_of["you"] == 0 else "sau", label, plies, reason))
    print("KẾT QUẢ BO2: bạn %.1f - %.1f BTC" % (score["you"], score["btc"]))
`;

const USER_BOT = `
# ======================================================================
# BOT CỦA BẠN - chỉ cần hoàn thiện hàm choose_move(state)
# state = {"me": 0|1, "ply": int, "goal": [x, y], "pieces": [[x, y, owner, kind], ...]}
# kind: 0 = Búa, 1 = Bao, 2 = Kéo.  Trả về (x, y, next_x, next_y).
# Mặc định bên dưới đi một nước hợp lệ ngẫu nhiên - hãy thay bằng chiến thuật của bạn.
# ======================================================================
import random

def choose_move(state):
    me = state["me"]
    beat = {0: 2, 1: 0, 2: 1}
    board = {(x, y): (o, k) for x, y, o, k in state["pieces"]}
    moves = []
    for (x, y), (owner, kind) in board.items():
        if owner != me:
            continue
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                nx, ny = x + dx, y + dy
                if (dx or dy) and 0 <= nx < 9 and 0 <= ny < 9:
                    target = board.get((nx, ny))
                    if target is None or (target[0] != me and beat[kind] == target[1]):
                        moves.append((x, y, nx, ny))
    return random.choice(moves) if moves else (-1, -1, -1, -1)
`;

export function buildBotTemplate(bot: SampleBot): string {
  const btc = bot.source.replace(/\r\n/g, '\n').replace(/'''/g, "\\'\\'\\'").replace(/\n+$/, '');
  return `# ======================================================================
# CODE CỦA BTC (đối thủ): ${bot.name} - ${bot.hint}
# Chỉ để tham khảo/chạy thử. Có thể xóa phần này trước khi nộp bài.
# ======================================================================
BTC_SOURCE = r'''
${btc}
'''
${USER_BOT}${SIMULATOR}`;
}

export const DEFAULT_TEMPLATE = `def choose_move(state):
    # state['pieces']: [x, y, owner, kind]
    # Return: (x, y, next_x, next_y)
    return (-1, -1, -1, -1)
`;
