import { getClubControlBaseUrl } from "../../shared-domain/clubControlConfig";

export type BoardMatchPlayer = {
  id?: string;
  name: string;
  start_score: number;
};

export type BoardNextMatch = {
  social_night_id: string;
  social_night_name: string;
  board_id: string;
  game_mode: string;
  format: string;
  group_name: string;
  round: number;
  slot: number;
  match_id: string;
  a: BoardMatchPlayer;
  b: BoardMatchPlayer;
};

export async function getBoardNextMatch(boardId: string): Promise<BoardNextMatch | null> {
  const safeBoardId = encodeURIComponent(String(boardId || "").trim());
  const res = await fetch(`${getClubControlBaseUrl()}/api/club/boards/${safeBoardId}/next-match`);
  if (!res.ok) {
    return null;
  }
  const data = await res.json().catch(() => ({}));
  if (!data?.has_match || !data?.next_match) {
    return null;
  }
  return data.next_match as BoardNextMatch;
}

export async function submitBoardMatchResult(params: {
  boardId: string;
  socialNightId: string;
  matchId: string;
  winner: "a" | "b";
  scoreA?: number;
  scoreB?: number;
}): Promise<boolean> {
  const safeBoardId = encodeURIComponent(String(params.boardId || "").trim());
  const res = await fetch(`${getClubControlBaseUrl()}/api/club/boards/${safeBoardId}/results`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      social_night_id: params.socialNightId,
      match_id: params.matchId,
      winner: params.winner,
      score_a: params.scoreA,
      score_b: params.scoreB,
    }),
  });
  return res.ok;
}
