from __future__ import annotations

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.core.games.service import GameService


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def make_dart(*, score: int, multiplier: int, segment: str, zone: str) -> dict[str, object]:
    return {
        "score": score,
        "multiplier": multiplier,
        "segment": segment,
        "zone": zone,
        "confidence": 1.0,
    }


def start_service(*, start_score: int, starting_player: int, legs_per_set: int, sets_to_win: int) -> GameService:
    service = GameService()
    service.start_x01(
        players=[
            {"name": "Host"},
            {"name": "Joiner"},
        ],
        start_score=start_score,
        in_mode="straight",
        out_mode="double",
        starting_player=starting_player,
        legs_per_set=legs_per_set,
        sets_to_win=sets_to_win,
        free_play=False,
        game_variant="standard",
        lms_total_legs=3,
        teams=None,
        analytics_source="online_p2p",
    )
    return service


def scenario_basic_remote_turn() -> None:
    service = start_service(start_score=101, starting_player=0, legs_per_set=3, sets_to_win=1)
    state = service.apply_remote_x01_turn(
        player_index=0,
        darts=[
            make_dart(score=20, multiplier=1, segment="20", zone="single_inner"),
            make_dart(score=20, multiplier=1, segment="20", zone="single_inner"),
            make_dart(score=20, multiplier=1, segment="20", zone="single_inner"),
        ],
    )
    assert_true(state["players"][0]["score"] == 41, "basic turn: host score should be 41 after scoring 60 from 101")
    assert_true(state["players"][1]["score"] == 101, "basic turn: joiner score should remain unchanged")
    assert_true(state["currentPlayer"] == 1, "basic turn: handoff should move to joiner")
    assert_true(state["match"]["currentLeg"] == 1, "basic turn: current leg should remain the same")
    assert_true(state["lastCommittedTurn"]["playerIndex"] == 0, "basic turn: last committed turn owner should be host")
    assert_true(state["lastCommittedTurn"]["turnIndex"] == 1, "basic turn: last committed turn index should be 1")
    service.stop_x01()


def scenario_leg_win_reset() -> None:
    service = start_service(start_score=40, starting_player=1, legs_per_set=3, sets_to_win=1)
    state = service.apply_remote_x01_turn(
        player_index=1,
        darts=[make_dart(score=40, multiplier=2, segment="20", zone="double")],
    )
    assert_true(state["players"][0]["score"] == 40, "leg win: host score should reset to start score")
    assert_true(state["players"][1]["score"] == 40, "leg win: joiner score should reset to start score")
    assert_true(state["players"][1]["legsWon"] == 1, "leg win: joiner should have 1 leg won")
    assert_true(state["players"][0]["legsWon"] == 0, "leg win: host should still have 0 legs won")
    assert_true(state["match"]["currentLeg"] == 2, "leg win: next leg should start")
    assert_true(state["currentPlayer"] == 0, "leg win: opener should rotate to host")
    assert_true(state["lastTurn"] is None, "leg win: history should reset for new leg")
    assert_true(state["lastCommittedTurn"]["playerIndex"] == 1, "leg win: committed turn owner should persist across reset")
    assert_true(state["lastCommittedTurn"]["finished"] is True, "leg win: committed turn should be marked as a checkout")
    service.stop_x01()


def scenario_set_win_reset() -> None:
    service = start_service(start_score=40, starting_player=0, legs_per_set=1, sets_to_win=2)
    state = service.apply_remote_x01_turn(
        player_index=0,
        darts=[make_dart(score=40, multiplier=2, segment="20", zone="double")],
    )
    assert_true(state["players"][0]["score"] == 40, "set win: host score should reset to start score")
    assert_true(state["players"][1]["score"] == 40, "set win: joiner score should reset to start score")
    assert_true(state["players"][0]["setsWon"] == 1, "set win: host should have 1 set won")
    assert_true(state["players"][0]["legsWon"] == 0, "set win: host legs should reset for next set")
    assert_true(state["players"][1]["legsWon"] == 0, "set win: joiner legs should reset for next set")
    assert_true(state["match"]["currentSet"] == 2, "set win: next set should start")
    assert_true(state["match"]["currentLeg"] == 1, "set win: new set should begin at leg 1")
    assert_true(state["currentPlayer"] == 1, "set win: opener should rotate to joiner")
    assert_true(state["lastTurn"] is None, "set win: history should reset for new set")
    assert_true(state["lastCommittedTurn"]["playerIndex"] == 0, "set win: committed turn owner should persist across reset")
    assert_true(state["lastCommittedTurn"]["finished"] is True, "set win: committed turn should remain available after reset")
    service.stop_x01()


def scenario_match_complete() -> None:
    service = start_service(start_score=40, starting_player=1, legs_per_set=1, sets_to_win=1)
    state = service.apply_remote_x01_turn(
        player_index=1,
        darts=[make_dart(score=40, multiplier=2, segment="20", zone="double")],
    )
    assert_true(state["winner"] == 1, "match complete: winner index should be joiner")
    assert_true(state["matchWinner"] == 1, "match complete: match winner index should be joiner")
    assert_true(state["players"][1]["setsWon"] == 1, "match complete: winner set count should be recorded")
    assert_true(state["players"][1]["score"] == 0, "match complete: winning checkout should leave winner on 0")
    assert_true(state["players"][0]["score"] == 40, "match complete: losing player score should remain unchanged")
    service.stop_x01()


def main() -> None:
    scenario_basic_remote_turn()
    scenario_leg_win_reset()
    scenario_set_win_reset()
    scenario_match_complete()
    print("Online X01 remote-apply smoke test passed.")
    print("Scenarios: basic turn handoff | leg win reset | set win reset | match complete")


if __name__ == "__main__":
    main()
