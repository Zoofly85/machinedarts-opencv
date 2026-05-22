export interface Venue {
  venue_id: string;
  name: string;
  timezone?: string;
}

export interface Board {
  board_id: string;
  venue_id: string;
  machine_id?: string;
  status: "idle" | "in_session" | "offline";
  shell?: string;
  active_game?: string;
  fps?: number | null;
  last_seen_at?: string;
  active_session?: ClubSession | null;
  policy?: BoardPolicy | null;
}

export interface ClubSession {
  session_id: string;
  board_id: string;
  title: string;
  operator: string;
  notes: string;
  started_at: string;
  stopped_at?: string | null;
  status: "active" | "closed";
}

export interface SocialNight {
  id: string;
  name: string;
  starts_at: string;
  board_ids: string[];
  status: "active" | "closed";
}

export interface Tournament {
  id: string;
  name: string;
  starts_at: string;
  board_ids: string[];
  status: "active" | "closed";
  notes?: string;
}

export interface BoardPolicy {
  policy_id: string;
  policy_name: string;
  lock_detection_settings: boolean;
  lock_runtime_settings: boolean;
  lock_calibration: boolean;
  lock_game_presets: boolean;
}

export interface PlaytimeMetrics {
  occupancy_seconds: number;
  active_play_seconds: number;
  average_session_seconds: number;
}
