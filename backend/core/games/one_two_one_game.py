"""One Two One (121+) checkout practice game for the dart detector backend."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

MAX_DARTS_PER_TURN = 3
MAX_VISITS_PER_ATTEMPT = 3  # 3 visits = 9 darts


def _score_from_raw(raw_score: Optional[Dict]) -> int:
  """Safely extract the score integer from a raw score dict."""
  if not raw_score:
    return 0
  try:
    return max(0, int(round(float(raw_score.get("score", 0) or 0))))
  except (TypeError, ValueError):
    return 0


def _is_double_out(raw_score: Optional[Dict]) -> bool:
  """Check if the dart qualifies as a double (or inner bull) for checkout."""
  if not raw_score:
    return False
  multiplier = raw_score.get("multiplier", 1)
  zone = (raw_score.get("zone") or "").lower()
  return multiplier == 2 or zone == "inner_bull"


@dataclass
class OneTwoOneDartResult:
  player_index: int
  score: int
  raw_score: Optional[Dict]
  bust: bool = False
  checkout: bool = False


@dataclass
class OneTwoOnePlayerState:
  name: str
  current_target: int
  starting_target: int
  target_limit: Optional[int]
  failure_policy: str  # stay | drop | reset
  out_rule: str  # double | any
  attempt_remaining: int
  visits_used: int = 0
  darts_thrown: int = 0
  busts: int = 0
  successes: int = 0
  failures: int = 0
  best_target_reached: int = 0
  legs_won: int = 0
  sets_won: int = 0
  attempt_history: List[Dict[str, Any]] = field(default_factory=list)


class OneTwoOneGame:
  """Checkout ladder starting at 121 with up to 9 darts per target."""

  def __init__(self) -> None:
    self.players: List[OneTwoOnePlayerState] = []
    self.current_player_index: int = 0
    self.current_turn_darts: List[Optional[OneTwoOneDartResult]] = [None] * MAX_DARTS_PER_TURN
    self.last_completed_turn: List[Optional[OneTwoOneDartResult]] = [None] * MAX_DARTS_PER_TURN
    self.current_turn_bust: bool = False
    self.current_turn_scored: int = 0
    self.last_turn_bust: bool = False
    self.last_turn_scored: int = 0
    self.winner_index: Optional[int] = None
    self.match_winner_index: Optional[int] = None
    self.leg_winner_index: Optional[int] = None
    self.set_winner_index: Optional[int] = None
    self.turn_history: List[Tuple[int, List[Optional[OneTwoOneDartResult]]]] = []
    self.completed_leg_summaries: List[Dict[str, Any]] = []
    self._last_leg_summary: Optional[List[Dict[str, Any]]] = None
    self.legs_per_set: int = 1
    self.sets_to_win: int = 1
    self.current_leg: int = 1
    self.current_set: int = 1
    # visit level bookkeeping
    self._visit_busted: bool = False
    self._visit_start_remaining: int = 0
    self._turn_start_snapshot: Optional[Dict[str, Any]] = None
    self._replaying_correction: bool = False

  # ------------------------------------------------------------------
  # Game setup
  # ------------------------------------------------------------------
  def start_game(
    self,
    players: List[str],
    starting_target: int = 121,
    target_limit: Optional[int] = None,
    failure_policy: str = "stay",
    out_rule: str = "double",
    starting_player: int = 0,
    legs_per_set: int = 1,
    sets_to_win: int = 1,
  ) -> None:
    filtered = [p.strip() for p in players if p and p.strip()]
    if not filtered:
      raise ValueError("At least one player name is required")

    self.players = [
      OneTwoOnePlayerState(
        name=name,
        current_target=max(1, starting_target),
        starting_target=max(1, starting_target),
        target_limit=target_limit,
        failure_policy=failure_policy,
        out_rule=out_rule,
        attempt_remaining=max(1, starting_target),
      )
      for name in filtered
    ]
    self.current_player_index = max(0, min(starting_player, len(self.players) - 1))
    self.winner_index = None
    self.match_winner_index = None
    self.leg_winner_index = None
    self.set_winner_index = None
    self.current_leg = 1
    self.current_set = 1
    self.legs_per_set = max(1, legs_per_set)
    self.sets_to_win = max(1, sets_to_win)
    self.turn_history = []
    self.completed_leg_summaries = []
    self._last_leg_summary = None
    self._reset_turn_buffers()

  def reset_match(self) -> None:
    if not self.players:
      return
    for player in self.players:
      player.current_target = player.starting_target
      player.attempt_remaining = player.starting_target
      player.visits_used = 0
      player.darts_thrown = 0
      player.busts = 0
      player.successes = 0
      player.failures = 0
      player.best_target_reached = 0
      player.legs_won = 0
      player.sets_won = 0
      player.attempt_history = []
    self.current_player_index = 0
    self.winner_index = None
    self.match_winner_index = None
    self.leg_winner_index = None
    self.set_winner_index = None
    self.current_leg = 1
    self.current_set = 1
    self.turn_history = []
    self.completed_leg_summaries = []
    self._last_leg_summary = None
    self._reset_turn_buffers()

  # ------------------------------------------------------------------
  # Turn lifecycle
  # ------------------------------------------------------------------
  def start_turn(self) -> None:
    self._reset_turn_buffers()
    player = self.players[self.current_player_index]
    self._visit_start_remaining = player.attempt_remaining
    self._visit_busted = False
    self._turn_start_snapshot = {
      "current_target": player.current_target,
      "attempt_remaining": player.attempt_remaining,
      "visits_used": player.visits_used,
      "busts": player.busts,
      "successes": player.successes,
      "failures": player.failures,
      "best_target_reached": player.best_target_reached,
      "darts_thrown": player.darts_thrown,
    }

  def record_dart(self, dart_index: int, score: Optional[Dict]) -> None:
    if self.winner_index is not None:
      return
    if dart_index < 0 or dart_index >= MAX_DARTS_PER_TURN:
      return
    player = self.players[self.current_player_index]
    if not self._replaying_correction and self._turn_start_snapshot is None:
      # Snapshot the turn start so corrections can re-evaluate the visit accurately.
      self._visit_start_remaining = player.attempt_remaining
      self._turn_start_snapshot = {
        "current_target": player.current_target,
        "attempt_remaining": player.attempt_remaining,
        "visits_used": player.visits_used,
        "busts": player.busts,
        "successes": player.successes,
        "failures": player.failures,
        "best_target_reached": player.best_target_reached,
        "darts_thrown": player.darts_thrown,
      }

    # Ignore darts after bust within the same visit, but keep storage for UI.
    if self._visit_busted or player.attempt_remaining <= 0:
      result = OneTwoOneDartResult(player_index=self.current_player_index, score=_score_from_raw(score), raw_score=score, bust=True, checkout=False)
      self.current_turn_darts[dart_index] = result
      self.current_turn_bust = True
      return

    dart_score = _score_from_raw(score)
    remaining_after = player.attempt_remaining - dart_score
    bust = False
    checkout = False

    if remaining_after < 0:
      bust = True
    elif remaining_after == 0:
      if player.out_rule == "double" and not _is_double_out(score):
        bust = True
      else:
        checkout = True
    # If not bust/checkout, just continue

    result = OneTwoOneDartResult(
      player_index=self.current_player_index,
      score=dart_score,
      raw_score=score,
      bust=bust,
      checkout=checkout,
    )
    self.current_turn_darts[dart_index] = result
    player.darts_thrown += 1
    self.current_turn_scored += dart_score

    if bust:
      # revert to start of visit
      player.attempt_remaining = self._visit_start_remaining
      player.busts += 1
      self._visit_busted = True
      self.current_turn_bust = True
      return

    # Apply score
    player.attempt_remaining = remaining_after

    if checkout:
      # success ends attempt immediately
      player.successes += 1
      self._finalize_success(player)
      return

  def apply_correction(self, dart_index: int, score: Optional[Dict]) -> None:
    """Apply a manual correction by re-evaluating the current visit."""
    if self.winner_index is not None:
      return
    if dart_index < 0 or dart_index >= MAX_DARTS_PER_TURN:
      return

    # Capture raw scores (with corrected slot), then replay from turn start snapshot.
    raw_scores: List[Optional[Dict]] = []
    for idx, entry in enumerate(self.current_turn_darts):
      if idx == dart_index:
        raw_scores.append(score)
      else:
        raw_scores.append(entry.raw_score if entry else None)

    player = self.players[self.current_player_index]
    snapshot = self._turn_start_snapshot or {
      "current_target": player.current_target,
      "attempt_remaining": player.attempt_remaining + self.current_turn_scored,
      "visits_used": player.visits_used,
      "busts": player.busts,
      "successes": player.successes,
      "failures": player.failures,
      "best_target_reached": player.best_target_reached,
      "darts_thrown": max(0, player.darts_thrown - sum(1 for d in self.current_turn_darts if d)),
    }

    # Restore player state to turn start.
    player.current_target = snapshot["current_target"]
    player.attempt_remaining = snapshot["attempt_remaining"]
    player.visits_used = snapshot["visits_used"]
    player.busts = snapshot["busts"]
    player.successes = snapshot["successes"]
    player.failures = snapshot["failures"]
    player.best_target_reached = snapshot["best_target_reached"]
    player.darts_thrown = snapshot["darts_thrown"]

    # Reset and replay darts.
    self._reset_turn_buffers()
    self._turn_start_snapshot = snapshot
    self._visit_start_remaining = snapshot["attempt_remaining"]
    self._replaying_correction = True
    try:
      for idx, raw in enumerate(raw_scores):
        if raw is not None:
          self.record_dart(idx, raw)
    finally:
      self._replaying_correction = False

  def complete_turn(self) -> None:
    """Finish the visit and advance player/attempt state."""
    if self.winner_index is not None:
      self._reset_turn_buffers()
      return

    player = self.players[self.current_player_index]
    success_in_turn = any(d.checkout for d in self.current_turn_darts if d)
    self.last_completed_turn = list(self.current_turn_darts)
    self.last_turn_bust = self.current_turn_bust
    self.last_turn_scored = self.current_turn_scored
    self.turn_history.append((self.current_player_index, list(self.current_turn_darts)))

    if success_in_turn:
      # Do not count this visit toward the 3-visit limit; the attempt is already completed.
      player.visits_used = 0
      self._advance_player_turn()
      return

    player.visits_used += 1

    # Fail attempt after max visits
    if player.visits_used >= MAX_VISITS_PER_ATTEMPT:
      player.failures += 1
      self._apply_failure_policy(player)

    # Advance to next player
    self._advance_player_turn()

  # ------------------------------------------------------------------
  # Helpers
  # ------------------------------------------------------------------
  def _advance_player_turn(self) -> None:
    if self.winner_index is None:
      self.current_player_index = (self.current_player_index + 1) % len(self.players)
    self._reset_turn_buffers()

  def _apply_failure_policy(self, player: OneTwoOnePlayerState) -> None:
    policy = (player.failure_policy or "stay").lower()
    darts_used = player.visits_used * MAX_DARTS_PER_TURN
    if policy == "drop":
      player.current_target = max(player.starting_target, player.current_target - 1)
    elif policy == "reset":
      player.current_target = player.starting_target
    # stay: no change
    # record attempt summary before resetting counters
    player.attempt_history.append({
      "target": player.current_target,
      "success": False,
      "dartsUsed": darts_used,
      "busts": player.busts,
    })
    player.attempt_remaining = player.current_target
    player.visits_used = 0
    self._visit_start_remaining = player.attempt_remaining
    self._visit_busted = False

  def _finalize_success(self, player: OneTwoOnePlayerState) -> None:
    # Record successful attempt summary
    darts_in_attempt = player.visits_used * MAX_DARTS_PER_TURN
    darts_in_attempt += sum(1 for d in self.current_turn_darts if d is not None and not d.bust)
    player.attempt_history.append({
      "target": player.current_target,
      "success": True,
      "dartsUsed": darts_in_attempt,
    })
    player.best_target_reached = max(player.best_target_reached, player.current_target)
    player.current_target += 1
    player.visits_used = 0
    player.attempt_remaining = player.current_target
    self._visit_start_remaining = player.attempt_remaining
    self._visit_busted = True  # ignore remaining darts in this visit; next visit will reset

    # Check win condition
    if player.target_limit is not None and player.current_target > player.target_limit:
      self.winner_index = self.current_player_index
      self.match_winner_index = self.current_player_index
      self.leg_winner_index = self.current_player_index
      self.set_winner_index = self.current_player_index

  def _reset_turn_buffers(self) -> None:
    self.current_turn_darts = [None] * MAX_DARTS_PER_TURN
    self._visit_busted = False
    self._visit_start_remaining = 0
    self.current_turn_bust = False
    self.current_turn_scored = 0
    self._turn_start_snapshot = None

  # ------------------------------------------------------------------
  # State / summary
  # ------------------------------------------------------------------
  def _player_stats(self, player: OneTwoOnePlayerState) -> Dict[str, Any]:
    attempts = len(player.attempt_history)
    successes = sum(1 for a in player.attempt_history if a.get("success"))
    failures = attempts - successes
    checkout_pct = (successes / attempts * 100.0) if attempts else 0.0
    fastest = min((a["dartsUsed"] for a in player.attempt_history if a.get("success") and a.get("dartsUsed") is not None), default=None)

    # Longest climb streak (consecutive successes)
    longest_streak = 0
    current_streak = 0
    for attempt in player.attempt_history:
      if attempt.get("success"):
        current_streak += 1
      else:
        longest_streak = max(longest_streak, current_streak)
        current_streak = 0
    longest_streak = max(longest_streak, current_streak)

    return {
      "attempts": attempts,
      "successes": successes,
      "failures": failures,
      "checkoutPercentage": checkout_pct,
      "bestTargetReached": player.best_target_reached,
      "fastestCheckoutDarts": fastest,
      "longestStreak": longest_streak,
    }

  def get_state(self) -> Dict[str, Any]:
    return {
      "mode": "one_two_one",
      "players": [
        {
          "name": p.name,
          "currentTarget": p.current_target,
          "startingTarget": p.starting_target,
          "targetLimit": p.target_limit,
          "failurePolicy": p.failure_policy,
          "outRule": p.out_rule,
          "attemptRemaining": p.attempt_remaining,
          "visitsUsed": p.visits_used,
          "dartsThrown": p.darts_thrown,
          "busts": p.busts,
          "successes": p.successes,
          "failures": p.failures,
          "bestTargetReached": p.best_target_reached,
          "legsWon": p.legs_won,
          "setsWon": p.sets_won,
          "attemptHistory": p.attempt_history,
        }
        for p in self.players
      ],
      "currentPlayer": self.current_player_index,
      "currentTurn": {
        "darts": [
          d.raw_score if d else None
          for d in self.current_turn_darts
        ],
        "bust": self.current_turn_bust,
        "scored": self.current_turn_scored,
      },
      "lastCompletedTurn": [
        d.raw_score if d else None
        for d in self.last_completed_turn
      ],
      "lastTurn": {
        "darts": [
          d.raw_score if d else None for d in self.last_completed_turn
        ],
        "bust": self.last_turn_bust,
        "scored": self.last_turn_scored,
      },
      "winnerIndex": self.winner_index,
      "match": {
        "currentSet": self.current_set,
        "currentLeg": self.current_leg,
        "legsPerSet": self.legs_per_set,
        "setsToWin": self.sets_to_win,
        "legWinner": self.leg_winner_index,
        "setWinner": self.set_winner_index,
        "matchWinner": self.match_winner_index,
      },
      "stats": [self._player_stats(p) for p in self.players],
    }

  def consume_leg_summary(self) -> Optional[List[Dict[str, Any]]]:
    summary = self._last_leg_summary
    self._last_leg_summary = None
    return summary
